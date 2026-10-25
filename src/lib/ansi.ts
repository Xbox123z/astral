/**
 * ANSI / 真彩色渲染层：零依赖。
 *
 * 设计要点：
 * 1. 支持 Windows（Win10+ VT）、Linux、macOS 终端；Windows 老控制台自动降级。
 * 2. 提供 24bit 真彩色与 256 色两种降级策略，用 `ColorMode` 统一探测。
 * 3. 渐变 / 噪声 / 量化：给 ASCII 行星上色用的核心工具。
 */

export const ESC = '\x1b[';
export const BEL = '\x07';
export const CSI = '\x1b[';

export type ColorMode = 'truecolor' | 'ansi256' | 'ansi16' | 'none';

export interface RGB {
  r: number;
  g: number;
  b: number;
}

export type ColorInput = RGB | string | [number, number, number];

/* ------------------------------------------------------------------ */
/* 色彩解析                                                            */
/* ------------------------------------------------------------------ */

const NAMED: Record<string, RGB> = {
  black: { r: 0, g: 0, b: 0 },
  red: { r: 205, g: 49, b: 49 },
  green: { r: 13, g: 188, b: 121 },
  yellow: { r: 229, g: 229, b: 16 },
  blue: { r: 36, g: 114, b: 200 },
  magenta: { r: 188, g: 63, b: 188 },
  cyan: { r: 17, g: 168, b: 205 },
  white: { r: 229, g: 229, b: 229 },
  gray: { r: 128, g: 128, b: 128 },
  grey: { r: 128, g: 128, b: 128 },
  orange: { r: 255, g: 135, b: 0 },
  gold: { r: 255, g: 199, b: 92 },
  jupiter: { r: 214, g: 160, b: 110 },
  saturn: { r: 233, g: 214, b: 168 },
  mars: { r: 199, g: 87, b: 51 },
  neptune: { r: 63, g: 118, b: 242 },
  uranus: { r: 148, g: 224, b: 226 },
  venus: { r: 240, g: 214, b: 165 },
  mercury: { r: 156, g: 151, b: 145 },
  starlight: { r: 255, g: 250, b: 240 },
  void: { r: 12, g: 12, b: 22 },
};

export function parseColor(input: ColorInput): RGB {
  if (Array.isArray(input)) return { r: input[0]!, g: input[1]!, b: input[2]! };
  if (typeof input === 'string') {
    const s = input.trim().toLowerCase();
    if (s.startsWith('#')) {
      const hex = s.slice(1);
      if (hex.length === 3 || hex.length === 4) {
        const r = parseInt(hex[0]! + hex[0]!, 16);
        const g = parseInt(hex[1]! + hex[1]!, 16);
        const b = parseInt(hex[2]! + hex[2]!, 16);
        return { r, g, b };
      }
      if (hex.length === 6 || hex.length === 8) {
        return {
          r: parseInt(hex.slice(0, 2), 16),
          g: parseInt(hex.slice(2, 4), 16),
          b: parseInt(hex.slice(4, 6), 16),
        };
      }
    }
    if (NAMED[s]) return NAMED[s]!;
    const m = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/.exec(s);
    if (m) return { r: +m[1]!, g: +m[2]!, b: +m[3]! };
    throw new Error(`unparseable color: ${input}`);
  }
  return input;
}

export function toHex(c: RGB): string {
  const h = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

/* ------------------------------------------------------------------ */
/* 色彩空间运算（HSL / 插值 / 256 量化）                                */
/* ------------------------------------------------------------------ */

export function rgbToHsl(c: RGB): { h: number; s: number; l: number } {
  const r = c.r / 255;
  const g = c.g / 255;
  const b = c.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  return { h: h * 360, s, l };
}

export function hslToRgb(h: number, s: number, l: number): RGB {
  const hh = ((h % 360) + 360) % 360 / 360;
  if (s === 0) {
    const v = Math.round(l * 255);
    return { r: v, g: v, b: v };
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue = (t: number): number => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  return {
    r: Math.round(hue(hh + 1 / 3) * 255),
    g: Math.round(hue(hh) * 255),
    b: Math.round(hue(hh - 1 / 3) * 255),
  };
}

export function mix(a: RGB, b: RGB, t: number): RGB {
  const k = Math.max(0, Math.min(1, t));
  return {
    r: Math.round(a.r + (b.r - a.r) * k),
    g: Math.round(a.g + (b.g - a.g) * k),
    b: Math.round(a.b + (b.b - a.b) * k),
  };
}

export function shade(c: RGB, amount: number): RGB {
  return amount >= 0 ? mix(c, { r: 255, g: 255, b: 255 }, amount) : mix(c, { r: 0, g: 0, b: 0 }, -amount);
}

/** 亮度感知（0..1） */
export function luminance(c: RGB): number {
  return (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255;
}

const ANSI16_TABLE: RGB[] = [
  { r: 0, g: 0, b: 0 },
  { r: 205, g: 0, b: 0 },
  { r: 0, g: 205, b: 0 },
  { r: 205, g: 205, b: 0 },
  { r: 0, g: 0, b: 238 },
  { r: 205, g: 0, b: 205 },
  { r: 0, g: 205, b: 205 },
  { r: 229, g: 229, b: 229 },
  { r: 127, g: 127, b: 127 },
  { r: 255, g: 0, b: 0 },
  { r: 0, g: 255, b: 0 },
  { r: 255, g: 255, b: 0 },
  { r: 92, g: 92, b: 255 },
  { r: 255, g: 0, b: 255 },
  { r: 0, g: 255, b: 255 },
  { r: 255, g: 255, b: 255 },
];

/** 24bit -> xterm-256 量化 */
export function toAnsi256(c: RGB): number {
  const r = Math.max(0, Math.min(255, Math.round(c.r)));
  const g = Math.max(0, Math.min(255, Math.round(c.g)));
  const b = Math.max(0, Math.min(255, Math.round(c.b)));
  if (r === g && g === b) {
    if (r < 8) return 16;
    if (r > 248) return 231;
    return Math.round(((r - 8) / 247) * 24) + 232;
  }
  const idx =
    36 * Math.round((r / 255) * 5) + 6 * Math.round((g / 255) * 5) + Math.round((b / 255) * 5) + 16;
  return idx;
}

/** 任意 RGB -> 最接近的 16 色索引 */
export function toAnsi16(c: RGB): number {
  let best = 0;
  let bestD = Infinity;
  ANSI16_TABLE.forEach((t, i) => {
    const d = (t.r - c.r) ** 2 + (t.g - c.g) ** 2 + (t.b - c.b) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}

/* ------------------------------------------------------------------ */
/* 样式                                                                */
/* ------------------------------------------------------------------ */

export interface Style {
  fg?: ColorInput | undefined;
  bg?: ColorInput | undefined;
  bold?: boolean | undefined;
  dim?: boolean | undefined;
  italic?: boolean | undefined;
  underline?: boolean | undefined;
  blink?: boolean | undefined;
  inverse?: boolean | undefined;
  strike?: boolean | undefined;
}

let GLOBAL_MODE: ColorMode | null = null;

export function setColorMode(mode: ColorMode | null): void {
  GLOBAL_MODE = mode;
}

export function getColorMode(): ColorMode {
  return GLOBAL_MODE ?? detectColorMode();
}

/** 探测终端色彩能力；环境变量优先，三端通用 */
export function detectColorMode(): ColorMode {
  if (GLOBAL_MODE) return GLOBAL_MODE;
  const env = process.env ?? {};
  if (env['NO_COLOR'] || env['ASTRAL_NO_COLOR']) return 'none';
  if (env['ASTRAL_COLOR'] === 'truecolor') return 'truecolor';
  if (env['ASTRAL_COLOR'] === '256') return 'ansi256';
  if (env['ASTRAL_COLOR'] === '16') return 'ansi16';
  if (!process.stdout || !process.stdout.isTTY) return 'ansi256';

  const ct = env['COLORTERM'];
  if (ct && /truecolor|24bit/i.test(ct)) return 'truecolor';
  if (env['WT_SESSION'] || env['ConEmuANSI'] === 'ON') return 'truecolor'; // Windows Terminal
  if (env['TERM_PROGRAM'] === 'iTerm.app' || env['TERM_PROGRAM'] === 'Apple_Terminal') return 'truecolor';
  if (env['ITERM_SESSION_ID']) return 'truecolor';

  const term = env['TERM'] ?? '';
  if (/256color/i.test(term)) return 'ansi256';
  if (/^screen|^xterm|^vt100|^rxvt|color/i.test(term)) return 'ansi16';
  return 'ansi16';
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

/** 生成一段样式的 SGR 序列（含模式降级） */
export function styleSeq(s: Style, mode: ColorMode = getColorMode()): string {
  if (mode === 'none') return '';
  const out: string[] = [];
  if (s.bold) out.push('1');
  if (s.dim) out.push('2');
  if (s.italic) out.push('3');
  if (s.underline) out.push('4');
  if (s.blink) out.push('5');
  if (s.inverse) out.push('7');
  if (s.strike) out.push('9');
  // fgSeq/bgSeq 返回的是完整序列（形如 ESC[38;2;r;g;bm）。
  // 这里必须同时剥掉开头的 ESC[ 和结尾的 'm'，否则 join(';') 拼出来的
  // 会是 [38;2;r;g;bm 这样的残片，终端会把它当普通字符显示成一堆裸露的 m。
  if (s.fg) out.push(stripSgr(fgSeq(parseColor(s.fg), mode)));
  if (s.bg) out.push(stripSgr(bgSeq(parseColor(s.bg), mode)));
  return out.length ? `${ESC}${out.join(';')}m` : '';
}

/** 把 `ESC[38;2;r;g;bm` 剥成 `38;2;r;g;b` */
function stripSgr(seq: string): string {
  return seq.replace(/^\x1b\[/, '').replace(/m$/, '');
}

export const RESET = `${ESC}0m`;

/** 套用样式；mode=none 时原样返回 */
export function paint(text: string, s: Style, mode: ColorMode = getColorMode()): string {
  if (mode === 'none' || !text) return text;
  const open = styleSeq(s, mode);
  if (!open) return text;
  return `${open}${text}${RESET}`;
}

/** 链式构建器，用于 `ansi.fg('#f0a').bold().paint('x')` */
export class Styler {
  private s: Style = {};
  private content = '';
  fg(c: ColorInput): this {
    this.s.fg = c;
    return this;
  }
  bg(c: ColorInput): this {
    this.s.bg = c;
    return this;
  }
  bold(v = true): this {
    this.s.bold = v;
    return this;
  }
  dim(v = true): this {
    this.s.dim = v;
    return this;
  }
  italic(v = true): this {
    this.s.italic = v;
    return this;
  }
  underline(v = true): this {
    this.s.underline = v;
    return this;
  }
  inverse(v = true): this {
    this.s.inverse = v;
    return this;
  }
  text(t: string): this {
    this.content = t;
    return this;
  }
  paint(t?: string): string {
    return paint(t ?? this.content, this.s);
  }
  get style(): Style {
    return { ...this.s };
  }
}

/* ------------------------------------------------------------------ */
/* 渐变                                                                */
/* ------------------------------------------------------------------ */

export type GradientStop = ColorInput | { at: number; color: ColorInput };

/** 多停靠点渐变采样器 */
export class Gradient {
  private stops: { at: number; rgb: RGB }[];

  constructor(stops: GradientStop[]) {
    if (stops.length === 0) throw new Error('gradient needs at least one stop');
    if (stops.length === 1) {
      const s = stops[0]!;
      const rgb = parseColor(typeof s === 'object' && 'color' in s ? s.color : s);
      this.stops = [
        { at: 0, rgb },
        { at: 1, rgb },
      ];
      return;
    }
    this.stops = stops.map((s, i) => {
      if (typeof s === 'object' && 'color' in s) return { at: s.at, rgb: parseColor(s.color) };
      return { at: i / (stops.length - 1), rgb: parseColor(s as ColorInput) };
    });
  }

  at(t: number): RGB {
    const k = Math.max(0, Math.min(1, t));
    const st = this.stops;
    if (k <= st[0]!.at) return st[0]!.rgb;
    if (k >= st[st.length - 1]!.at) return st[st.length - 1]!.rgb;
    for (let i = 0; i < st.length - 1; i++) {
      const a = st[i]!;
      const b = st[i + 1]!;
      if (k >= a.at && k <= b.at) {
        const span = b.at - a.at || 1;
        return mix(a.rgb, b.rgb, (k - a.at) / span);
      }
    }
    return st[st.length - 1]!.rgb;
  }

  /** 给一段纯文本着色（每字符一色，可传 grapheme 数组以免破坏 emoji） */
  paint(text: string, mode: ColorMode = getColorMode()): string {
    const chars = Array.from(text);
    if (chars.length <= 1) return paint(text, { fg: this.at(0.5) }, mode);
    let out = '';
    let prev = -1;
    for (let i = 0; i < chars.length; i++) {
      const rgb = this.at(i / (chars.length - 1));
      out += fgSeq(rgb, mode);
      out += chars[i];
      prev = i;
    }
    void prev;
    return out + RESET;
  }

  /** 按列渐变：给一整行背景上色（用于行星条带） */
  paintRow(width: number, ch: string, mode: ColorMode = getColorMode()): string {
    let out = '';
    for (let i = 0; i < width; i++) out += fgSeq(this.at(i / Math.max(1, width - 1)), mode) + ch;
    return out + RESET;
  }
}

export function gradient(stops: GradientStop[]): Gradient {
  return new Gradient(stops);
}

/* ------------------------------------------------------------------ */
/* 光标 / 屏幕控制                                                      */
/* ------------------------------------------------------------------ */

export const cursor = {
  hide: `${ESC}?25l`,
  show: `${ESC}?25h`,
  home: `${ESC}H`,
  to: (row: number, col: number): string => `${ESC}${row};${col}H`,
  up: (n = 1): string => `${ESC}${n}A`,
  down: (n = 1): string => `${ESC}${n}B`,
  right: (n = 1): string => `${ESC}${n}C`,
  left: (n = 1): string => `${ESC}${n}D`,
  save: `${ESC}s`,
  restore: `${ESC}u`,
  column: (n: number): string => `${ESC}${n}G`,
};

export const screen = {
  clear: `${ESC}2J`,
  clearFromCursor: `${ESC}J`,
  clearToCursor: `${ESC}1J`,
  clearLine: `${ESC}2K`,
  clearLineAfter: `${ESC}K`,
  /** 进入备用屏幕（TUI 模式） */
  altEnter: `${ESC}?1049h`,
  /** 退出备用屏幕，恢复用户原来的回滚缓冲 */
  altExit: `${ESC}?1049l`,
  mouseOn: `${ESC}?1000h${ESC}?1002h${ESC}?1015h${ESC}?1006h`,
  mouseOff: `${ESC}?1000l${ESC}?1002l${ESC}?1015l${ESC}?1006l`,
  /** 启用自动换行关闭，避免宽字符把边框挤歪 */
  nowrapOn: `${ESC}?7l`,
  nowrapOff: `${ESC}?7h`,
  bracketedPasteOn: `${ESC}?2004h`,
  bracketedPasteOff: `${ESC}?2004l`,
  title: (t: string): string => `\x1b]0;${t.replace(/\x1b/g, '')}${BEL}`,
  /** 终端通知（OSC 9;4 桌面通知，iTerm2 / Windows Terminal 支持） */
  notify: (t: string): string => `\x1b]9;${t.replace(/\x1b/g, '')}${BEL}`,
};

/** 剥掉所有 ANSI（用于计算真实列宽） */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '');
}

/** 带 ANSI 的可见宽度 */
export function visibleWidth(s: string): number {
  return stripAnsi(s)
    .split('')
    .reduce((n, ch) => n + (ch.codePointAt(0)! > 0x1100 ? 2 : 1), 0);
}

/** 超链接（OSC 8），不支持的终端自动忽略超参 */
export function link(text: string, url: string): string {
  return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}

export const ansi = {
  ESC,
  CSI,
  RESET,
  parseColor,
  toHex,
  rgbToHsl,
  hslToRgb,
  mix,
  shade,
  luminance,
  toAnsi256,
  toAnsi16,
  paint,
  styleSeq,
  setColorMode,
  getColorMode,
  detectColorMode,
  Gradient,
  gradient,
  cursor,
  screen,
  stripAnsi,
  visibleWidth,
  link,
  NAMED,
  Styler,
};

export default ansi;
