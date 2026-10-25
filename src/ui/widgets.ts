/**
 * TUI 控件库：面板、输入框、消息列表、菜单、进度条。
 *
 * 全部基于 Frame（字符画布），因此：
 *  - 自动适配终端尺寸与色彩能力（truecolor / 256 / 16 / none）
 *  - 中文/emoji 宽度正确
 *  - 一次 render() 输出整屏，不闪烁
 */

import { Frame } from '../lib/frame.js';
import { THEMES, userColor, type Theme } from '../lib/palette.js';import { paint, cursor, screen, stripAnsi, type RGB } from '../lib/ansi.js';
import { displayWidth, truncate, pad, wrapText, sliceByWidth } from '../lib/utf8.js';
import type { Cell } from '../lib/frame.js';

export interface UiContext {
  width: number;
  height: number;
  theme: Theme;
  mode: 'truecolor' | 'ansi256' | 'ansi16' | 'none';
}

export function makeContext(width: number, height: number, themeId = 'nebula', mode: UiContext['mode'] = 'truecolor'): UiContext {
  return { width, height, theme: THEMES[themeId] ?? THEMES['nebula']!, mode };
}

/* ------------------------------------------------------------------ */
/* 面板                                                                */
/* ------------------------------------------------------------------ */

export interface PanelOptions {
  title?: string;
  /** 边框颜色 */
  border?: RGB;
  /** 是否双线 */
  double?: boolean;
  /** 标题右侧的提示 */
  hint?: string;
  /** 底部状态行 */
  footer?: string;
  /** 是否高亮（当前焦点面板） */
  focused?: boolean;
}

export class Panel {
  readonly frame: Frame;
  private inner: { x: number; y: number; w: number; h: number };

  constructor(
    private ctx: UiContext,
    private x: number,
    private y: number,
    private w: number,
    private h: number,
    private opts: PanelOptions = {},
  ) {
    this.frame = new Frame({ width: w, height: h, bg: ctx.theme.bg });
    this.inner = { x: 1, y: 1, w: Math.max(0, w - 2), h: Math.max(0, h - 2) };
    this.drawChrome();
  }

  private drawChrome(): void {
    const t = this.ctx.theme;
    const border = this.opts.border ?? (this.opts.focused ? t.accent : t.border);
    const kind = this.opts.double ? 'double' : 'single';
    this.frame.box(0, 0, this.w, this.h, { fg: border }, kind);

    if (this.opts.title) {
      const label = ` ${this.opts.title} `;
      this.frame.text(2, 0, label, { fg: this.opts.focused ? t.accent : t.fg, bold: true });
    }
    if (this.opts.hint && this.w > 20) {
      const hint = this.opts.hint;
      const hx = this.w - 2 - displayWidth(hint);
      if (hx > 4) this.frame.text(hx, 0, hint, { fg: t.dim });
    }
    if (this.opts.footer && this.h > 2) {
      const f = truncate(this.opts.footer, this.w - 4);
      this.frame.text(2, this.h - 1, f, { fg: t.dim });
    }
  }

  get innerWidth(): number {
    return this.inner.w;
  }

  get innerHeight(): number {
    return this.inner.h;
  }

  /** 在面板内容区写一行（相对坐标，y 从 0 开始） */
  line(relY: number, text: string, style?: Partial<Cell>): void {
    if (relY < 0 || relY >= this.inner.h) return;
    this.frame.text(this.inner.x, this.inner.y + relY, truncate(text, this.inner.w), style);
  }

  /** 写富文本（已含 ANSI 的字符串按纯文本处理） */
  plain(relY: number, text: string, fg?: RGB, bold = false): void {
    this.line(relY, text, { fg: fg ?? this.ctx.theme.fg, bold });
  }

  clearContent(): void {
    for (let y = 0; y < this.inner.h; y++) {
      for (let x = 0; x < this.inner.w; x++) {
        this.frame.set(this.inner.x + x, this.inner.y + y, ' ', { bg: this.ctx.theme.bg });
      }
    }
  }

  render(): string {
    return this.frame.render(this.ctx.mode);
  }

  blitTo(target: Frame): void {
    target.blit(this.x, this.y, this.frame);
  }
}

/* ------------------------------------------------------------------ */
/* 消息列表（仿 VK 群聊气泡风格）                                        */
/* ------------------------------------------------------------------ */

export interface ChatMessage {
  id: string;
  nick: string;
  authorId: string;
  text: string;
  ts: number;
  /** 私聊标记 */
  dm?: boolean;
  /** 系统消息 */
  system?: boolean;
  /** 文件/投票等附件摘要 */
  attachment?: string;
}

/**
 * 一行待渲染的内容：纯文本 + 样式。
 *
 * 为什么不直接返回上好 ANSI 色的字符串：Frame 是按「格」存的画布，
 * 它自己会在渲染时统一生成 SGR 并做游程合并。如果把带 ANSI 的字符串
 * 喂给 Frame.text()，转义字符会被当成普通字符逐格写进画布 —— 既占列，
 * 又把序列打碎。所以这里只传纯文本 + 样式。
 */
export interface StyledRow {
  text: string;
  style?: Partial<Cell>;
}

/**
 * 消息渲染：昵称按 id 稳定着色，时间右对齐，长文本自动换行。
 * 这是「仿 VK 群聊」的关键视觉：一行昵称 + 缩进的内容。
 *
 * 返回的是结构化行（不是 ANSI 字符串），由调用方写进 Frame。
 */
export function renderMessages(
  ctx: UiContext,
  msgs: ChatMessage[],
  width: number,
  height: number,
  selfId: string,
): StyledRow[] {
  const t = ctx.theme;
  const out: StyledRow[] = [];
  const timeStr = (ts: number): string => {
    const d = new Date(ts);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  // 从后往前收集，直到填满高度
  for (let i = msgs.length - 1; i >= 0 && out.length < height; i--) {
    const m = msgs[i]!;
    if (m.system) {
      out.unshift({ text: `  ${truncate(m.text, width - 4)}`, style: { fg: t.dim, italic: true } });
      continue;
    }
    const color = m.authorId === selfId ? t.self : userColor(m.authorId, t);
    const tag = m.dm ? '🔒 ' : '';
    const head = `${tag}${m.nick}`;
    const time = timeStr(m.ts);
    const headW = displayWidth(head) + displayWidth(time) + 1;
    if (headW < width - 2) {
      out.unshift({ text: `${head} ${time}`, style: { fg: color, bold: m.authorId === selfId } });
    } else {
      out.unshift({ text: truncate(head, width - 3), style: { fg: color, bold: true } });
    }
    // 内容换行，缩进 2 列
    const bodyW = Math.max(8, width - 4);
    for (const l of wrapText(m.text, bodyW)) {
      out.unshift({ text: `  ${l}`, style: { fg: t.fg } });
    }
    if (m.attachment) {
      out.unshift({ text: `  📎 ${truncate(m.attachment, bodyW - 2)}`, style: { fg: t.accent2 } });
    }
  }
  // 只保留最后 height 行
  return out.slice(-height);
}

/* ------------------------------------------------------------------ */
/* 输入框                                                              */
/* ------------------------------------------------------------------ */

export class InputLine {
  private value = '';
  private cursorPos = 0;
  private history: string[] = [];
  private historyIdx = -1;
  private draft = '';

  constructor(
    private promptStr = '> ',
    private maxLen = 2000,
  ) {}

  get text(): string {
    return this.value;
  }

  set text(v: string) {
    this.value = v.slice(0, this.maxLen);
    this.cursorPos = this.value.length;
  }

  get cursor(): number {
    return this.cursorPos;
  }

  set cursor(v: number) {
    this.cursorPos = Math.max(0, Math.min(this.value.length, v));
  }

  /** 用新文本替换 [start, end) 区间，并把光标放到替换内容之后 */
  splice(start: number, end: number, replacement: string): void {
    const s = Math.max(0, Math.min(this.value.length, start));
    const e = Math.max(s, Math.min(this.value.length, end));
    this.value = this.value.slice(0, s) + replacement + this.value.slice(e);
    this.cursorPos = Math.max(0, Math.min(this.value.length, s + replacement.length));
  }

  clear(): void {
    this.value = '';
    this.cursorPos = 0;
    this.historyIdx = -1;
  }

  insert(s: string): void {
    if (this.value.length + s.length > this.maxLen) return;
    this.value = this.value.slice(0, this.cursorPos) + s + this.value.slice(this.cursorPos);
    this.cursorPos += s.length;
  }

  backspace(): void {
    if (this.cursorPos === 0) return;
    this.value = this.value.slice(0, this.cursorPos - 1) + this.value.slice(this.cursorPos);
    this.cursorPos--;
  }

  deleteForward(): void {
    if (this.cursorPos >= this.value.length) return;
    this.value = this.value.slice(0, this.cursorPos) + this.value.slice(this.cursorPos + 1);
  }

  left(): void {
    if (this.cursorPos > 0) this.cursorPos--;
  }

  right(): void {
    if (this.cursorPos < this.value.length) this.cursorPos++;
  }

  home(): void {
    this.cursorPos = 0;
  }

  end(): void {
    this.cursorPos = this.value.length;
  }

  wordLeft(): void {
    let i = this.cursorPos - 1;
    while (i > 0 && this.value[i - 1] === ' ') i--;
    while (i > 0 && this.value[i - 1] !== ' ') i--;
    this.cursorPos = i;
  }

  /** 提交：加入历史并清空 */
  submit(): string {
    const v = this.value;
    if (v.trim()) {
      this.history.push(v);
      if (this.history.length > 200) this.history.shift();
    }
    this.value = '';
    this.cursorPos = 0;
    this.historyIdx = -1;
    return v;
  }

  historyPrev(): void {
    if (!this.history.length) return;
    if (this.historyIdx === -1) {
      this.draft = this.value;
      this.historyIdx = this.history.length - 1;
    } else if (this.historyIdx > 0) {
      this.historyIdx--;
    }
    this.value = this.history[this.historyIdx] ?? '';
    this.cursorPos = this.value.length;
  }

  historyNext(): void {
    if (this.historyIdx === -1) return;
    if (this.historyIdx < this.history.length - 1) {
      this.historyIdx++;
      this.value = this.history[this.historyIdx] ?? '';
    } else {
      this.historyIdx = -1;
      this.value = this.draft;
    }
    this.cursorPos = this.value.length;
  }

  /**
   * 供 Frame 使用的结构化版本：把输入行拆成
   * 「提示符 / 光标前文本 / 光标字符 / 光标后文本」四段，各带样式。
   * 这样调用方可以逐段写进画布，不会把 ANSI 打进格子里。
   */
  renderPlain(theme: Theme): { text: string; style: Partial<Cell>; cursor: number } {
    const before = this.value.slice(0, this.cursorPos);
    const at = this.value[this.cursorPos] ?? ' ';
    const after = this.value.slice(this.cursorPos + 1);
    const avail = Math.max(4, 80 - displayWidth(this.promptStr) - 1);
    let winBefore = before;
    const beforeW = displayWidth(before);
    if (beforeW >= avail) {
      winBefore = '…' + sliceByWidth(before, beforeW - avail + 1, beforeW);
    }
    const cursorCol = displayWidth(this.promptStr) + displayWidth(winBefore);
    return {
      text: this.promptStr + winBefore + at + after,
      style: { fg: theme.fg },
      cursor: cursorCol,
    };
  }

  /** 完整渲染（含 ANSI），供直接写终端用 */
  render(ctx: UiContext, width: number): string {
    const t = ctx.theme;
    const promptPart = paint(this.promptStr, { fg: t.accent, bold: true }, ctx.mode);
    // 光标前的文本 + 光标字符 + 光标后文本
    const before = this.value.slice(0, this.cursorPos);
    const at = this.value[this.cursorPos] ?? ' ';
    const after = this.value.slice(this.cursorPos + 1);
    // 保证光标可见：把 before 按「列」左移，不能按 UTF-16 单元切
    // （否则遇到中文或 ANSI 序列会切坏，光标位置和颜色都会错）
    const avail = Math.max(4, width - displayWidth(this.promptStr) - 1);
    let winBefore = before;
    const beforeW = displayWidth(before);
    if (beforeW >= avail) {
      winBefore = '…' + sliceByWidth(before, beforeW - avail + 1, beforeW);
    }
    const body =
      paint(winBefore, { fg: t.fg }, ctx.mode) +
      paint(at, { fg: t.bg, bg: t.accent }, ctx.mode) +
      paint(after, { fg: t.fg }, ctx.mode);
    return promptPart + body;
  }
}

/* ------------------------------------------------------------------ */
/* 菜单 / 选择器                                                        */
/* ------------------------------------------------------------------ */

export interface MenuItem {
  label: string;
  value: string;
  hint?: string;
  disabled?: boolean;
  /** 右侧徽标（如票数） */
  badge?: string;
}

export class Menu {
  private index = 0;
  private scroll = 0;

  constructor(public items: MenuItem[] = []) {}

  get selected(): MenuItem | undefined {
    return this.items[this.index];
  }

  get selectedIndex(): number {
    return this.index;
  }

  move(delta: number): void {
    if (!this.items.length) return;
    // 跳过禁用项
    let i = this.index;
    for (let n = 0; n < this.items.length; n++) {
      i = (i + delta + this.items.length) % this.items.length;
      if (!this.items[i]!.disabled) break;
    }
    this.index = i;
    this.ensureVisible(0);
  }

  select(i: number): void {
    if (i >= 0 && i < this.items.length && !this.items[i]!.disabled) {
      this.index = i;
      this.ensureVisible(0);
    }
  }

  private ensureVisible(_h: number): void {
    // 简单策略：始终让选中项在窗口中部
    this.scroll = Math.max(0, this.index - 2);
  }

  render(ctx: UiContext, width: number, height: number): string[] {
    const t = ctx.theme;
    const out: string[] = [];
    const start = Math.min(this.scroll, Math.max(0, this.items.length - height));
    const visible = this.items.slice(start, start + height);
    visible.forEach((item, i) => {
      const idx = start + i;
      const active = idx === this.index;
      const mark = active ? '▸' : ' ';
      const label = truncate(item.label, width - 6);
      let line = `${mark} ${label}`;
      if (item.badge) line += ' ' + item.badge;
      const style: Parameters<typeof paint>[1] = item.disabled
        ? { fg: t.dim }
        : active
          ? { fg: t.bg, bg: t.accent, bold: true }
          : { fg: t.fg };
      let s = paint(pad(line, width - 1), style, ctx.mode);
      if (item.hint && !active) {
        s = paint(pad(line, width - 1 - displayWidth(item.hint)), style, ctx.mode) + paint(item.hint, { fg: t.dim }, ctx.mode);
      }
      out.push(s);
    });
    return out;
  }
}

/* ------------------------------------------------------------------ */
/* 进度条 / 状态                                                       */
/* ------------------------------------------------------------------ */

export function progressBar(ctx: UiContext, ratio: number, width: number, label = ''): string {
  const t = ctx.theme;
  const filled = Math.max(0, Math.min(width, Math.round(ratio * width)));
  const bar = '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled));
  const pct = `${Math.round(ratio * 100)}%`.padStart(4);
  const col = ratio < 0.34 ? t.ok : ratio < 0.75 ? t.warn : t.err;
  return paint(bar, { fg: col }, ctx.mode) + ' ' + paint(pct, { fg: t.dim }, ctx.mode) + (label ? ' ' + paint(label, { fg: t.dim }, ctx.mode) : '');
}

/** 信号强度条（用于房间列表的新鲜度 / 蓝牙 RSSI） */
export function signalBar(ctx: UiContext, strength: number): string {
  const t = ctx.theme;
  const n = Math.max(0, Math.min(4, Math.round(strength * 4)));
  const cells = ['▁', '▂', '▃', '▄', '▅'];
  const filled = n;
  const empty = 4 - n;
  return (
    paint(cells[filled]!.repeat(filled), { fg: t.ok }, ctx.mode) +
    paint('·'.repeat(empty), { fg: t.dim }, ctx.mode)
  );
}

/* ------------------------------------------------------------------ */
/* 头部横幅                                                            */
/* ------------------------------------------------------------------ */

export interface HeaderInfo {
  roomName: string;
  roomId: string;
  peerCount: number;
  transport: string;
  nick: string;
  selfId: string;
  encrypted: boolean;
  /** 右侧可选状态（如游戏进行中） */
  status?: string;
}

export function renderHeader(ctx: UiContext, info: HeaderInfo): string {
  const t = ctx.theme;
  const w = ctx.width;
  const lock = info.encrypted ? '🔒' : '🔓';
  const left = `${lock} ${truncate(info.roomName, 20)} · ${info.peerCount} 人 · ${info.transport}`;
  const right = info.status ? truncate(info.status, 24) : '';
  const mid = `你是 ${info.nick}`;
  const avail = w - displayWidth(left) - displayWidth(right) - 4;
  const centered = avail > displayWidth(mid) + 2 ? pad(mid, avail, 'center') : '';
  const line = paint(left, { fg: t.accent, bold: true }, ctx.mode) + centered + paint(right, { fg: t.warn }, ctx.mode);
  const sep = paint('─'.repeat(w), { fg: t.border }, ctx.mode);
  return line + '\n' + sep;
}

/* ------------------------------------------------------------------ */
/* 滚动与布局辅助                                                      */
/* ------------------------------------------------------------------ */

/** 把内容按视口裁剪（支持底部对齐的聊天流） */
export function viewport(lines: string[], height: number, scrollFromBottom = 0): string[] {
  const end = lines.length - scrollFromBottom;
  const start = Math.max(0, end - height);
  const slice = lines.slice(start, end);
  while (slice.length < height) slice.unshift('');
  return slice;
}

/** 竖向堆叠多个渲染块 */
export function stack(blocks: string[]): string {
  return blocks.filter(Boolean).join('\n');
}

export const widgets = {
  Panel,
  makeContext,
  renderMessages,
  InputLine,
  Menu,
  progressBar,
  signalBar,
  renderHeader,
  viewport,
  stack,
};

export default widgets;
