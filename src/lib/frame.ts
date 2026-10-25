/**
 * 字符画布（Frame）：ASCII 行星 / 星野 / TUI 的共同底座。
 *
 * 每个 cell 是一个 grapheme + 前景色 + 背景色 + 属性。
 * 渲染时做「游程合并」：相邻同色 cell 合并成一段 SGR，
 * 这样 200x60 的满屏彩色画面也能在 60fps 下刷新而不糊终端。
 */
import {
  ESC,
  RESET,
  parseColor,
  styleSeq,
  toAnsi256,
  toAnsi16,
  type ColorInput,
  type ColorMode,
  type RGB,
  getColorMode,
} from './ansi.js';
import { stripEscapes } from './utf8.js';

export interface Cell {
  ch: string;
  fg?: RGB | undefined;
  bg?: RGB | undefined;
  bold?: boolean | undefined;
  dim?: boolean | undefined;
  italic?: boolean | undefined;
  underline?: boolean | undefined;
}

export interface FrameOptions {
  width: number;
  height: number;
  /** 背景填充字符 */
  fill?: string | undefined;
  /** 默认前景色 */
  fg?: ColorInput | undefined;
  /** 默认背景色 */
  bg?: ColorInput | undefined;
}

function rgbOf(c: ColorInput): RGB {
  return typeof c === 'string' || Array.isArray(c) ? parseColor(c) : c;
}

function fgSeq(c: RGB, mode: ColorMode): string {
  if (mode === 'truecolor') return `${ESC}38;2;${c.r};${c.g};${c.b}m`;
  if (mode === 'ansi256') return `${ESC}38;5;${toAnsi256(c)}m`;
  const i = toAnsi16(c);
  return `${ESC}${i < 8 ? 3 : 9}${i % 8}m`;
}

function bgSeq(c: RGB, mode: ColorMode): string {
  if (mode === 'truecolor') return `${ESC}48;2;${c.r};${c.g};${c.b}m`;
  if (mode === 'ansi256') return `${ESC}48;5;${toAnsi256(c)}m`;
  const i = toAnsi16(c);
  return `${ESC}${i < 8 ? 4 : 10}${i % 8}m`;
}

export class Frame {
  readonly width: number;
  readonly height: number;
  readonly cells: Cell[];
  readonly defaultFg?: RGB | undefined;
  readonly defaultBg?: RGB | undefined;

  constructor(opts: FrameOptions) {
    this.width = Math.max(1, opts.width | 0);
    this.height = Math.max(1, opts.height | 0);
    this.defaultFg = opts.fg !== undefined ? rgbOf(opts.fg) : undefined;
    this.defaultBg = opts.bg !== undefined ? rgbOf(opts.bg) : undefined;
    const fill = opts.fill ?? ' ';
    this.cells = new Array(this.width * this.height);
    for (let i = 0; i < this.cells.length; i++) {
      this.cells[i] = { ch: fill, fg: this.defaultFg, bg: this.defaultBg };
    }
  }

  index(x: number, y: number): number {
    return y * this.width + x;
  }

  inside(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  get(x: number, y: number): Cell | undefined {
    return this.inside(x, y) ? this.cells[this.index(x, y)] : undefined;
  }

  /** 写单个字符；越界静默丢弃（行星边缘裁剪需要） */
  set(x: number, y: number, ch: string, style?: Partial<Cell>): void {
    if (!this.inside(x, y)) return;
    const i = this.index(x, y);
    const c = this.cells[i]!;
    c.ch = ch;
    if (style?.fg !== undefined) c.fg = style.fg;
    if (style?.bg !== undefined) c.bg = style.bg;
    if (style?.bold !== undefined) c.bold = style.bold;
    if (style?.dim !== undefined) c.dim = style.dim;
    if (style?.italic !== undefined) c.italic = style.italic;
    if (style?.underline !== undefined) c.underline = style.underline;
  }

  /**
   * 写字符串（按 grapheme 展开，CJK/emoji 占多列时写多格占位）。
   *
   * 注意：这里写的是「字符 + 样式」，不是「已上色的文本」。
   * 如果传入的字符串里含 ANSI 转义序列，ESC/[0/m 这些字符会被当成
   * 普通字符逐格写进画布，既占列又把颜色代码打成碎片。
   * 所以进来先剥掉转义序列 —— 想要颜色请用 style 参数。
   */
  text(x: number, y: number, s: string, style?: Partial<Cell>): void {
    let cx = Math.round(x);
    // 防御：把误传进来的 ANSI 序列剥掉，否则 ESC/[0/m 会被当普通字符
    // 逐格写进画布，既占列又把颜色代码打碎。
    const plain = s.includes('\x1b') ? stripEscapes(s) : s;
    for (const g of Array.from(plain) as string[]) {
      const w = g.codePointAt(0)! > 0x1100 ? 2 : 1;
      this.set(cx, Math.round(y), g, style);
      // 宽字符右侧补一个零宽占位，避免被后续绘制覆盖成半个字符
      if (w === 2 && this.inside(cx + 1, Math.round(y))) {
        this.set(cx + 1, Math.round(y), '\u200b', style);
      }
      cx += w;
    }
  }

  fill(style: Partial<Cell> & { ch?: string }): void {
    for (const c of this.cells) {
      if (style.ch !== undefined) c.ch = style.ch;
      if (style.fg !== undefined) c.fg = style.fg;
      if (style.bg !== undefined) c.bg = style.bg;
      if (style.bold !== undefined) c.bold = style.bold;
      if (style.dim !== undefined) c.dim = style.dim;
    }
  }

  clear(): void {
    this.fill({ ch: ' ', fg: this.defaultFg, bg: this.defaultBg, bold: false, dim: false });
  }

  /** 矩形填充 */
  rect(x0: number, y0: number, w: number, h: number, ch: string, style?: Partial<Cell>): void {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) this.set(x, y, ch, style);
  }

  /** 描边矩形（单线/双线/粗线） */
  box(
    x0: number,
    y0: number,
    w: number,
    h: number,
    style?: Partial<Cell>,
    kind: 'single' | 'double' | 'round' | 'heavy' | 'dashed' = 'single',
  ): void {
    const sets: Record<string, [string, string, string, string, string, string]> = {
      single: ['─', '│', '┌', '┐', '└', '┘'],
      double: ['═', '║', '╔', '╗', '╚', '╝'],
      round: ['─', '│', '╭', '╮', '╰', '╯'],
      heavy: ['━', '┃', '┏', '┓', '┗', '┛'],
      dashed: ['┄', '┆', '┌', '┐', '└', '┘'],
    };
    const [h1, v1, tl, tr, bl, br] = sets[kind]!;
    const x1 = x0 + w - 1;
    const y1 = y0 + h - 1;
    for (let x = x0 + 1; x < x1; x++) {
      this.set(x, y0, h1, style);
      this.set(x, y1, h1, style);
    }
    for (let y = y0 + 1; y < y1; y++) {
      this.set(x0, y, v1, style);
      this.set(x1, y, v1, style);
    }
    if (w > 1 && h > 1) {
      this.set(x0, y0, tl, style);
      this.set(x1, y0, tr, style);
      this.set(x0, y1, bl, style);
      this.set(x1, y1, br, style);
    }
  }

  /** 水平线 */
  hline(x0: number, y: number, w: number, ch = '─', style?: Partial<Cell>): void {
    for (let x = x0; x < x0 + w; x++) this.set(x, y, ch, style);
  }

  /** 把另一个 Frame 按左上角混合进来（跳过透明 = 未指定 fg/bg 且 ch 为 '\0' 的格） */
  blit(fx: number, fy: number, src: Frame, transparentCh = '\u0000'): void {
    for (let y = 0; y < src.height; y++) {
      for (let x = 0; x < src.width; x++) {
        const s = src.cells[y * src.width + x]!;
        if (s.ch === transparentCh) continue;
        this.set(fx + x, fy + y, s.ch, s);
      }
    }
  }

  /** 缩放采样（整数倍放大/缩小），用于分辨率自适应 */
  scaled(targetW: number, targetH: number): Frame {
    const out = new Frame({ width: targetW, height: targetH });
    for (let y = 0; y < targetH; y++) {
      const sy = Math.min(this.height - 1, Math.floor((y * this.height) / targetH));
      for (let x = 0; x < targetW; x++) {
        const sx = Math.min(this.width - 1, Math.floor((x * this.width) / targetW));
        const s = this.cells[sy * this.width + sx]!;
        out.set(x, y, s.ch, s);
      }
    }
    return out;
  }

  /* --------------------------------------------------------------- */

  /** 渲染成字符串（含 ANSI），行尾不带换行 */
  render(mode: ColorMode = getColorMode()): string {
    const parts: string[] = [];
    for (let y = 0; y < this.height; y++) {
      let line = '';
      let cur = ''; // 当前生效的 SGR 序列（游程合并的键）
      for (let x = 0; x < this.width; x++) {
        const c = this.cells[y * this.width + x]!;
        // 直接复用 ansi.ts 的 styleSeq：它负责模式降级、属性与颜色拼接，
        // 并且正确地剥掉 ESC 前缀。自己拼 SGR 容易漏掉结尾的 'm'。
        const seq = mode === 'none' ? '' : styleSeq(c, mode);
        if (seq !== cur) {
          if (seq) line += seq;
          else if (cur) line += RESET;
          cur = seq;
        }
        line += c.ch === '\u200b' ? '' : c.ch;
      }
      if (cur) line += RESET;
      parts.push(line.replace(/\s+$/, ''));
    }
    return parts.join('\n');
  }

  toString(): string {
    return this.render();
  }

  /** 无 ANSI 的纯文本（测试与日志） */
  toPlain(): string {
    const lines: string[] = [];
    for (let y = 0; y < this.height; y++) {
      let line = '';
      for (let x = 0; x < this.width; x++) {
        const ch = this.cells[y * this.width + x]!.ch;
        line += ch === '\u200b' ? '' : ch;
      }
      lines.push(line.replace(/\s+$/, ''));
    }
    return lines.join('\n');
  }

  clone(): Frame {
    const f = new Frame({ width: this.width, height: this.height });
    for (let i = 0; i < this.cells.length; i++) f.cells[i] = { ...this.cells[i]! };
    return f;
  }
}

/** 上下拼接多个 Frame */
export function vjoin(frames: Frame[], gap = 0, bg?: ColorInput): Frame {
  const w = Math.max(...frames.map((f) => f.width));
  const h = frames.reduce((n, f) => n + f.height, 0) + gap * Math.max(0, frames.length - 1);
  const out = new Frame({ width: w, height: h, bg });
  let y = 0;
  for (const f of frames) {
    out.blit(0, y, f);
    y += f.height + gap;
  }
  return out;
}

/** 左右拼接 */
export function hjoin(frames: Frame[], gap = 0, bg?: ColorInput): Frame {
  const h = Math.max(...frames.map((f) => f.height));
  const w = frames.reduce((n, f) => n + f.width, 0) + gap * Math.max(0, frames.length - 1);
  const out = new Frame({ width: w, height: h, bg });
  let x = 0;
  for (const f of frames) {
    out.blit(x, 0, f);
    x += f.width + gap;
  }
  return out;
}

/** 终端尺寸（带 fallback 与最小尺寸保护） */
export function terminalSize(fallback: { width: number; height: number } = { width: 100, height: 30 }): {
  width: number;
  height: number;
} {
  const envW = Number(process.env['COLUMNS'] ?? 0);
  const envH = Number(process.env['LINES'] ?? 0);
  const w = process.stdout?.columns || envW || 0;
  const h = process.stdout?.rows || envH || 0;
  return {
    width: Math.max(40, Math.min(w || fallback.width, 400)),
    height: Math.max(12, Math.min(h || fallback.height, 200)),
  };
}
