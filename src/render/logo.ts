/**
 * ASTRAL 标题字 + 开机序列（boot sequence）。
 *
 * 用一个手写的大号 figlet 风格字符集渲染 "ASTRAL"，配行星升起动画。
 * 不依赖 figlet：字体表内联，跨平台一致。
 */
import { Frame, hjoin } from '../lib/frame.js';
import { Gradient, parseColor, type RGB } from '../lib/ansi.js';
import { Rng } from '../lib/rng.js';
import { starfield } from './starfield.js';
import { renderPlanet } from './planet.js';

/** 5 行高的 A-Z 0-9 字体表（等宽块字符） */
const FONT: Record<string, string[]> = {
  A: ['  ██  ', ' ████ ', '██  ██', '██████', '██  ██'],
  B: ['█████ ', '██  ██', '█████ ', '██  ██', '█████ '],
  C: [' █████', '██    ', '██    ', '██    ', ' █████'],
  D: ['████  ', '██  ██', '██  ██', '██  ██', '████  '],
  E: ['██████', '██    ', '████  ', '██    ', '██████'],
  F: ['██████', '██    ', '████  ', '██    ', '██    '],
  G: [' █████', '██    ', '██  ██', '██  ██', ' █████'],
  H: ['██  ██', '██  ██', '██████', '██  ██', '██  ██'],
  I: ['██████', '  ██  ', '  ██  ', '  ██  ', '██████'],
  J: ['██████', '   ██ ', '   ██ ', '██ ██ ', ' ███  '],
  K: ['██  ██', '██ ██ ', '███   ', '██ ██ ', '██  ██'],
  L: ['██    ', '██    ', '██    ', '██    ', '██████'],
  M: ['██   ██', '███ ███', '██ █ ██', '██   ██', '██   ██'],
  N: ['██   ██', '███  ██', '██ █ ██', '██  ███', '██   ██'],
  O: [' ████ ', '██  ██', '██  ██', '██  ██', ' ████ '],
  P: ['█████ ', '██  ██', '█████ ', '██    ', '██    '],
  Q: [' ████ ', '██  ██', '██  ██', '██ ██ ', ' █████'],
  R: ['█████ ', '██  ██', '█████ ', '██ ██ ', '██  ██'],
  S: [' █████', '██    ', ' ████ ', '    ██', '█████ '],
  T: ['██████', '  ██  ', '  ██  ', '  ██  ', '  ██  '],
  U: ['██  ██', '██  ██', '██  ██', '██  ██', ' █████'],
  V: ['██   ██', '██   ██', '██   ██', ' ██ ██ ', '  ███  '],
  W: ['██   ██', '██   ██', '██ █ ██', '███ ███', '██   ██'],
  X: ['██   ██', ' ██ ██ ', '  ███  ', ' ██ ██ ', '██   ██'],
  Y: ['██   ██', ' ██ ██ ', '  ██  ', '  ██  ', '  ██  '],
  Z: ['██████', '   ██ ', '  ██  ', ' ██   ', '██████'],
  '0': [' ████ ', '██  ██', '██  ██', '██  ██', ' ████ '],
  '1': ['  ██  ', ' ███  ', '  ██  ', '  ██  ', '██████'],
  '2': [' ████ ', '██  ██', '  ██  ', ' ██   ', '██████'],
  '3': ['█████ ', '    ██', ' ████ ', '    ██', '█████ '],
  '4': ['██  ██', '██  ██', '██████', '    ██', '    ██'],
  '5': ['██████', '██    ', '█████ ', '    ██', '█████ '],
  '6': [' █████', '██    ', '█████ ', '██  ██', ' ████ '],
  '7': ['██████', '    ██', '   ██ ', '  ██  ', '  ██  '],
  '8': [' ████ ', '██  ██', ' ████ ', '██  ██', ' ████ '],
  '9': [' ████ ', '██  ██', ' █████', '    ██', ' ████ '],
  ' ': ['   ', '   ', '   ', '   ', '   '],
  '.': ['  ', '  ', '  ', '  ', ' █'],
  '-': ['    ', '    ', '████', '    ', '    '],
  _: ['     ', '     ', '     ', '     ', '█████'],
};

/** 渲染大标题（自动渐变上色） */
export function bigText(text: string, gradStops: string[] = ['#7af', '#c9f', '#f9a', '#fc6']): Frame {
  const cols: Frame[] = [];
  for (const ch0 of text.toUpperCase()) {
    const glyph = FONT[ch0];
    if (!glyph) {
      if (ch0 === ' ') cols.push(new Frame({ width: 2, height: 5 }));
      continue;
    }
    const w = Math.max(...glyph.map((l) => l.length));
    const f = new Frame({ width: w, height: 5 });
    glyph.forEach((line, y) => {
      for (let x = 0; x < line.length; x++) f.set(x, y, line[x]!);
    });
    cols.push(f);
  }
  const out = hjoin(cols, 1);
  const g = new Gradient(gradStops);
  for (let y = 0; y < out.height; y++) {
    for (let x = 0; x < out.width; x++) {
      const c = out.get(x, y)!;
      if (c.ch === ' ') continue;
      // 垂直 + 水平双向渐变，让字有体积感
      const t = y / Math.max(1, out.height - 1) * 0.65 + (x / Math.max(1, out.width - 1)) * 0.35;
      c.fg = g.at(t);
      c.bold = true;
    }
  }
  return out;
}

/** 小号副标题（单行，块状） */
export function tagline(text: string, color: string = '#8ad'): Frame {
  const f = new Frame({ width: text.length, height: 1 });
  const rgb = parseColor(color);
  for (let i = 0; i < text.length; i++) f.set(i, 0, text[i]!, { fg: rgb });
  return f;
}

export interface BootFrameOptions {
  width: number;
  height: number;
  /** 进度 0..1 */
  progress: number;
  /** 行星名 */
  planet?: 'jupiter' | 'saturn' | 'mars' | 'neptune' | 'earth';
  seed?: number;
  /** 是否已连上网络 */
  linked?: boolean;
}

/** 开机动画的每一帧：行星从下方升起 + 标题淡入 + 状态行 */
export function bootFrame(opts: BootFrameOptions): Frame {
  const { width, height, progress } = opts;
  const bg = starfield({
    width,
    height,
    t: progress * 6,
    density: 2.4,
    nebula: 0.32,
    seed: opts.seed ?? 99,
  });

  const planetName = opts.planet ?? 'jupiter';
  const D = Math.max(14, Math.min(Math.round(Math.min(width * 0.42, height * 1.5)), 60));
  const pf = renderPlanet(planetName, {
    diameter: D,
    spin: progress * 0.9,
    seed: planetName,
    glow: true,
  });
  // 行星从底部升起
  const rise = easeOutCubic(clamp(progress / 0.55, 0, 1));
  const py = Math.round(height - pf.height * rise + pf.height * 0.12);
  const px = Math.round(width / 2 - pf.width / 2);
  bg.blit(px, py, pf);

  // 标题：进度 > 0.45 才出现，带缩放淡入
  if (progress > 0.42) {
    const titleScale = clamp((progress - 0.42) / 0.3, 0, 1);
    const logo = bigText('ASTRAL');
    const lw = Math.min(width - 4, logo.width);
    const lf = logo.scaled(lw, Math.max(3, Math.round((logo.height * lw) / logo.width / 2)));
    const alpha = easeOutCubic(titleScale);
    const lx = Math.round(width / 2 - lf.width / 2);
    const ly = Math.max(0, Math.round(height * 0.14 - (1 - alpha) * 6));
    for (let y = 0; y < lf.height; y++) {
      for (let x = 0; x < lf.width; x++) {
        const c = lf.get(x, y)!;
        if (c.ch === ' ') continue;
        const tx = lx + x;
        const ty = ly + y;
        if (!bg.inside(tx, ty)) continue;
        if (alpha < 0.98 && ((x + y) % 3 === 0) && alpha < 0.6) continue; // 简易抖动淡入
        bg.set(tx, ty, c.ch, { fg: c.fg, bold: c.bold });
      }
    }
  }

  // 底部状态行
  const lines = [
    'initializing orbital mesh',
    'scanning lan / wifi / hotspot',
    'deriving identity keypair',
    'negotiating room key',
    opts.linked ? 'link established' : 'awaiting peers',
  ];
  const stepIdx = Math.min(lines.length - 1, Math.floor(progress * lines.length));
  const bar = progressBar(progress, Math.min(width - 6, 46));
  const status = `${bar}  ${lines[stepIdx]}`;
  const sx = Math.round(width / 2 - status.length / 2);
  const sy = height - 2;
  const cBar: RGB = parseColor('#fc6');
  const cText: RGB = parseColor('#9ab');
  for (let i = 0; i < status.length; i++) {
    const ch = status[i]!;
    bg.set(sx + i, sy, ch, { fg: ch === '█' || ch === '░' ? cBar : cText, dim: ch === '░' });
  }
  return bg;
}

export function progressBar(p: number, width: number): string {
  const filled = Math.round(clamp(p, 0, 1) * width);
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled));
}

export function clamp(v: number, a: number, b: number): number {
  return Math.max(a, Math.min(b, v));
}

export function easeOutCubic(t: number): number {
  const k = clamp(t, 0, 1);
  return 1 - Math.pow(1 - k, 3);
}

/** 随机化开机行星（每次启动不一样，但同 seed 可复现） */
export function pickBootPlanet(seed = Date.now()): 'jupiter' | 'saturn' | 'mars' | 'neptune' | 'earth' {
  const rng = new Rng(seed);
  return rng.pick(['jupiter', 'saturn', 'mars', 'neptune', 'earth'] as const);
}

export const logo = { bigText, tagline, bootFrame, progressBar, pickBootPlanet };
export default logo;
