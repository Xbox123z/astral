/**
 * 主界面：把星野背景、房间横幅、消息流、成员栏、输入框合成一屏。
 *
 * 布局（宽终端）：
 *   ┌─────────────────────────── 头部横幅 ───────────────────────────┐
 *   │  行星/星野 ASCII（左侧装饰）   │  消息流        │ 成员栏(右)   │
 *   ├─────────────────────────────────────────────────────────────────┤
 *   │  > 输入框                                          [状态提示]   │
 *   └─────────────────────────────────────────────────────────────────┘
 *
 * 窄终端（<70 列）自动退化为上下结构，保证手机热点场景下也能用。
 */

import { Frame } from '../lib/frame.js';
import { THEMES, userColor, roomColor, type Theme } from '../lib/palette.js';
import { paint, cursor, screen as screenCtl, type ColorMode, type RGB } from '../lib/ansi.js';
import { displayWidth, truncate, pad, wrapText } from '../lib/utf8.js';
import { Panel, renderMessages, InputLine, type ChatMessage, type UiContext, renderHeader, type HeaderInfo } from './widgets.js';
import { starfield } from '../render/starfield.js';
import { renderPlanet } from '../render/planet.js';
import type { RoomMember } from '../net/peer.js';

export interface ScreenState {
  ctx: UiContext;
  header: HeaderInfo;
  messages: ChatMessage[];
  members: RoomMember[];
  input: InputLine;
  /** 滚动偏移（0 = 贴底） */
  scroll: number;
  /** 底部提示 */
  toast: string | null;
  /** 右侧装饰：行星名 */
  planet: 'jupiter' | 'saturn' | 'mars' | 'earth' | 'neptune' | 'uranus';
  /** 动画时间（秒） */
  t: number;
  /** 当前正在进行的游戏面板（覆盖右侧） */
  gamePanel?: string;
  /** 投票面板 */
  pollPanel?: string;
  /** 打字中的人 */
  typing: string[];
}

export class ChatScreen {
  private lastRender = '';

  constructor(private state: ScreenState) {}

  get ctx(): UiContext {
    return this.state.ctx;
  }

  /** 渲染整屏（返回可一次性写入的字符串） */
  render(): string {
    const s = this.state;
    const { width, height, theme: t, mode } = s.ctx;

    if (width < 70 || height < 14) return this.renderCompact();

    const root = new Frame({ width, height, bg: t.bg });

    // 背景：星野（低速漂移）
    const bg = starfield({
      width,
      height,
      t: s.t,
      density: 1.6,
      nebula: 0.18,
      seed: 'astral-bg',
    });
    root.blit(0, 0, bg);

    // 头部（2 行）。截断必须按「列」算并按列切：这些行里含 ANSI 颜色，
    // 用 String.length/slice 会把转义序列切断，终端就会漏色。
    const headerText = renderHeader(s.ctx, s.header);
    const headerLines = headerText.split('\n');
    headerLines.forEach((l, i) => {
      root.text(0, i, truncate(l, width));
    });

    const top = 2;
    const bottomH = 3; // 输入框区域
    const bodyH = Math.max(4, height - top - bottomH);

    // 右：成员栏（宽 22，窄屏缩到 16）
    const memberW = width >= 100 ? 22 : 18;
    const memberX = width - memberW;
    const msgW = width - memberW - 1;

    // 左：行星装饰（仅在有空间时）
    const planetW = width >= 110 ? Math.min(30, Math.floor(msgW * 0.32)) : 0;
    const chatX = planetW > 0 ? planetW + 1 : 0;
    const chatW = msgW - chatX;

    if (planetW > 0) {
      const pf = renderPlanet(s.planet, {
        diameter: Math.min(planetW - 2, Math.floor(bodyH * 1.7)),
        spin: s.t * 0.06,
        seed: s.planet,
        glow: true,
      });
      const px = 1;
      const py = top + Math.max(0, Math.floor((bodyH - pf.height) / 2));
      root.blit(px, py, pf);
    }

    // 中：消息流
    // 投票/游戏面板放在消息区**上方**（固定高度），消息流从它下面开始排，
    // 这样两者不会互相覆盖。
    const sidePanel = s.pollPanel ?? s.gamePanel;
    const sideH = sidePanel ? Math.min(8, Math.max(3, sidePanel.split('\n').length)) : 0;
    const msgTop = top + sideH + (sideH > 0 ? 1 : 0);
    const rows = renderMessages(s.ctx, s.messages, chatW - 1, Math.max(1, top + bodyH - msgTop), s.header.selfId);
    let y = msgTop;
    for (const row of rows) {
      if (y >= top + bodyH) break;
      root.text(chatX, y, row.text, row.style);
      y++;
    }

    if (sidePanel) {
      const lines = sidePanel.split('\n').slice(0, sideH);
      for (let i = 0; i < lines.length; i++) {
        root.text(chatX, top + i, truncate(lines[i]!, chatW - 1), { fg: i === 0 ? t.accent : t.fg });
      }
      // 面板与消息之间的分隔
      root.text(chatX, top + sideH, '─'.repeat(Math.max(1, chatW - 1)), { fg: t.border });
    }

    // 右：成员栏
    const memberPanel = new Panel(s.ctx, memberX, top, memberW, bodyH, {
      title: `成员 ${s.members.length}`,
      focused: false,
    });
    memberPanel.clearContent();
    memberPanel.line(0, '', undefined);
    s.members.slice(0, memberPanel.innerHeight - 1).forEach((m, i) => {
      const color = m.id === s.header.selfId ? t.self : userColor(m.id, t);
      const isTyping = s.typing.includes(m.id);
      const mark = m.id === s.header.selfId ? '● ' : '○ ';
      const label = `${mark}${truncate(m.nick, memberW - 6)}${isTyping ? ' ✎' : ''}`;
      memberPanel.line(i + 1, label, { fg: color, bold: m.id === s.header.selfId, dim: isTyping });
    });
    memberPanel.blitTo(root);

    // 底部：输入区
    const inputY = height - 3;
    const sep = paint('─'.repeat(width), { fg: t.border }, mode);
    root.text(0, inputY, truncate(sep, width), undefined);

    const typingStr = s.typing.length
      ? `${s.typing.map((id) => s.members.find((m) => m.id === id)?.nick ?? '?').join('、')} 正在输入…`
      : (s.toast ?? '');
    root.text(0, inputY + 1, truncate(typingStr, width), { fg: t.dim, italic: true });

    const inputLine = s.input.render(s.ctx, width - 2);
    root.text(0, inputY + 2, truncate(inputLine, width), undefined);

    const out = root.render(mode);
    this.lastRender = out;
    return out;
  }

  /** 窄屏/极小终端的退化布局 */
  private renderCompact(): string {
    const s = this.state;
    const { width, height, theme: t } = s.ctx;
    const root = new Frame({ width, height, bg: t.bg });
    root.text(0, 0, truncate(`${s.header.roomName} · ${s.header.peerCount}人`, width), { fg: t.accent, bold: true });
    root.text(0, 1, '─'.repeat(width), { fg: t.border });
    const bodyH = Math.max(2, height - 4);
    const rows = renderMessages(s.ctx, s.messages, width - 1, bodyH, s.header.selfId);
    rows.forEach((row, i) => root.text(0, 2 + i, row.text, row.style));
    root.text(0, 2 + bodyH, '─'.repeat(width), { fg: t.border });
    // 输入框：同样只传纯文本 + 样式（光标单独处理）
    const inp = s.input.renderPlain(t);
    root.text(0, 3 + bodyH, truncate(inp.text, width), inp.style);
    return root.render(s.ctx.mode);
  }

  get last(): string {
    return this.lastRender;
  }
}

/* ------------------------------------------------------------------ */
/* 房间列表 / 发现界面                                                  */
/* ------------------------------------------------------------------ */

export interface RoomRow {
  name: string;
  host: string;
  port: number;
  peers: number;
  secured: boolean;
  freshness: number;
  transports: string[];
}

export function renderRoomList(ctx: UiContext, rooms: RoomRow[], selected: number): string {
  const { width, theme: t, mode } = ctx;
  const lines: string[] = [];
  lines.push(paint(pad(`  房间`, 28) + pad('主机', 22) + pad('人数', 8) + '加密', { fg: t.dim, bold: true }, mode));
  lines.push(paint('─'.repeat(Math.min(width, 70)), { fg: t.border }, mode));
  if (!rooms.length) {
    lines.push(paint('  （未发现房间 —— 确认大家在同一 WiFi / 热点下）', { fg: t.dim, italic: true }, mode));
  }
  rooms.forEach((r, i) => {
    const active = i === selected;
    const c = roomColor(r.name);
    const name = truncate(r.name, 24);
    const host = truncate(`${r.host}:${r.port}`, 20);
    const peers = String(r.peers);
    const lock = r.secured ? '🔒' : '  ';
    const row = `  ${pad(name, 26)}${pad(host, 22)}${pad(peers, 8)}${lock}`;
    lines.push(
      active
        ? paint(pad(row, Math.min(width, 70)), { fg: t.bg, bg: t.accent, bold: true }, mode)
        : paint(row, { fg: c }, mode),
    );
  });
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* 启动横幅                                                            */
/* ------------------------------------------------------------------ */

/** 一次性输出的欢迎横幅（不进 alt screen） */
export function welcomeBanner(mode: ColorMode, width = 80, themeId = 'nebula'): string {
  const t = THEMES[themeId] ?? THEMES['nebula']!;
  const art = [
    '   ▄▄▄  ▄▄▄▄ ▄▄▄▄▄ ▄▄▄▄  ▄▄▄   ▄    ',
    '  █   █ █    █ ▄▄▄ █   █ █   █ █    ',
    '  █████ ████ █▄▄▄▄ █████ █████ █    ',
    '  █   █    █ █  ▄▄ █   █ █   █ █    ',
    '  █   █ ████ █  ▀▀ █   █ █   █ ████ ',
  ];
  const g = ['#7af', '#b9f', '#f9a', '#fc6', '#f66'];
  const colored = art.map((line, i) => paint(line, { fg: g[i]!, bold: true }, mode)).join('\n');
  const sub = paint(
    '   终端星河 · 局域网 / 热点 / 蓝牙 · 端到端加密 · 千人房间',
    { fg: t.dim },
    mode,
  );
  return colored + '\n' + sub;
}

/** 帮助面板文本 */
export const HELP_TEXT = [
  '命令：',
  '  /help              显示本帮助',
  '  /nick <名字>       修改昵称',
  '  /dm <昵称> <内容>  私聊（端到端加密，服务器看不到）',
  '  /members           在线成员',
  '  /send <文件路径>    发送文件（分片传输，带 SHA-256 校验）',
  '  /get <文件名>       接收他人提供的文件',
  '  /poll "问题" A|B|C  发起投票',
  '  /vote <序号>       投票',
  '  /game <名称>       开局：werewolf / sanguosha / monopoly',
  '  /act <参数>        游戏内行动（或按提示选择）',
  '  /theme <名称>      切换主题：nebula / ember / ice / mono',
  '  /planet <名称>     切换装饰行星',
  '  /quit              离开房间',
  '',
  '快捷键：',
  '  Enter 发送   ↑↓ 历史   Tab 补全昵称   Ctrl+C 退出',
];

export function renderHelp(ctx: UiContext): string {
  const { theme: t, mode } = ctx;
  return HELP_TEXT.map((l, i) =>
    paint(l, { fg: i === 0 || l.startsWith('快捷键') ? t.accent : t.fg, bold: l.endsWith('：') }, mode),
  ).join('\n');
}

export const uiScreen = { ChatScreen, renderRoomList, welcomeBanner, renderHelp, HELP_TEXT };
export default uiScreen;
