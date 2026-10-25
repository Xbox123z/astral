/**
 * 星野 / 星云 / 深空背景。
 *
 * 提供：
 *  - starfield：视差滚动的星野（三层深度 + 闪烁）
 *  - nebula：fbm 星云（用来做页面背景，不是纯黑）
 *  - shootingStar：流星轨迹
 *  - hyperspace：曲速跃迁（开机转场）
 *  - warpTunnel：隧道穿越动画帧
 */
import { Frame } from '../lib/frame.js';
import { Noise } from '../lib/noise.js';
import { Rng, rand } from '../lib/rng.js';
import { mix, shade, hslToRgb, type RGB } from '../lib/ansi.js';

export interface Star {
  x: number;
  y: number;
  z: number; // 深度 0(远) .. 1(近)
  tw: number; // 闪烁相位
  hue: number;
  mag: number; // 星等 0..1
}

const STAR_CHARS = ['·', '˙', '∙', '•', '✦', '✧', '*', '+'];

/** 生成一片星野（确定性） */
export function makeStars(width: number, height: number, count: number, seed: number | string): Star[] {
  const rng = new Rng(seed);
  const stars: Star[] = [];
  for (let i = 0; i < count; i++) {
    stars.push({
      x: rng.next() * width,
      y: rng.next() * height,
      z: rng.next(),
      tw: rng.next() * Math.PI * 2,
      hue: rng.bool(0.82) ? rng.range(200, 260) : rng.range(20, 60), // 多数偏蓝白，少数暖色
      mag: rng.next() ** 2.2,
    });
  }
  return stars;
}

export interface StarfieldOptions {
  width: number;
  height: number;
  /** 时间（秒） */
  t?: number;
  /** 视差漂移速度 */
  drift?: number;
  /** 星数密度（每 1000 格） */
  density?: number;
  seed?: number | string;
  bg?: RGB;
  /** 星云强度 0..1 */
  nebula?: number;
  /** 叠加的星云色相 */
  hue?: number;
}

export function starfield(opts: StarfieldOptions): Frame {
  const w = Math.max(1, opts.width);
  const h = Math.max(1, opts.height);
  const t = opts.t ?? 0;
  const drift = opts.drift ?? 1.2;
  const bg = opts.bg ?? { r: 5, g: 5, b: 12 };
  const dens = opts.density ?? 3.2;
  const seed = opts.seed ?? 20250101;
  const neb = opts.nebula ?? 0.35;
  const hue = opts.hue ?? 232;

  const frame = new Frame({ width: w, height: h, bg });
  const noise = new Noise(String(seed));

  /* 星云底层 */
  if (neb > 0) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const n = noise.fbm2(x * 0.035 + t * 0.008, y * 0.07, 4);
        const m = noise.warp2(x * 0.02, y * 0.04, 0.7, 3);
        const v = Math.max(0, (n * 0.6 + m * 0.6 + 0.35) * neb);
        if (v < 0.08) continue;
        const c = hslToRgb((hue + m * 60) % 360, 0.62, 0.1 + v * 0.34);
        frame.set(x, y, ' ', { bg: mix(bg, c, Math.min(1, v)) });
      }
    }
  }

  /* 星点 */
  const count = Math.round((w * h * dens) / 1000);
  const stars = makeStars(w, h, count, seed);
  for (const s of stars) {
    // 视差：近处的星移动更快
    const speed = 0.25 + s.z * drift;
    let x = (s.x - t * speed) % w;
    if (x < 0) x += w;
    const y = s.y;
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    if (!frame.inside(xi, yi)) continue;

    // 闪烁
    const twinkle = 0.62 + 0.38 * Math.sin(t * (1.1 + s.z * 2.6) + s.tw);
    const bright = Math.max(0, Math.min(1, (0.25 + s.mag * 0.95) * twinkle));
    const l = 0.42 + bright * 0.58;
    const c = hslToRgb(s.hue, 0.28 * (1 - s.mag * 0.5), l);
    const ch = STAR_CHARS[Math.min(STAR_CHARS.length - 1, Math.floor(bright * STAR_CHARS.length))]!;
    frame.set(xi, yi, ch, { fg: c, bold: bright > 0.78, dim: bright < 0.3 });
  }
  return frame;
}

/** 流星（一帧） */
export interface ShootingStar {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  len: number;
}

export function spawnShooter(w: number, h: number): ShootingStar {
  const fromLeft = rand.bool();
  return {
    x: fromLeft ? rand.range(-2, w * 0.4) : rand.range(w * 0.6, w + 2),
    y: rand.range(0, h * 0.45),
    vx: (fromLeft ? 1 : -1) * rand.range(28, 58),
    vy: rand.range(9, 22),
    life: rand.range(0.5, 1.1),
    len: rand.int(4, 11),
  };
}

export function drawShooter(frame: Frame, s: ShootingStar, age: number): void {
  const alpha = Math.max(0, 1 - age / s.life);
  if (alpha <= 0) return;
  const hx = s.x + s.vx * age;
  const hy = s.y + s.vy * age;
  const nx = s.vx;
  const ny = s.vy;
  const n = Math.hypot(nx, ny) || 1;
  for (let i = 0; i < s.len; i++) {
    const d = i / s.len;
    const px = Math.round(hx - (nx / n) * i);
    const py = Math.round(hy - (ny / n) * i * 0.5);
    if (!frame.inside(px, py)) continue;
    const a = alpha * (1 - d) ** 1.6;
    if (a < 0.06) continue;
    const c = mix({ r: 150, g: 190, b: 255 }, { r: 255, g: 255, b: 255 }, a);
    const chars = '·:∙•*✦';
    const ch = chars[Math.min(chars.length - 1, Math.floor(a * chars.length))]!;
    frame.set(px, py, ch, { fg: c, dim: a < 0.45 });
  }
}

/** 曲速隧道：给 t 返回一帧 */
export function hyperspace(width: number, height: number, t: number, seed = 7, bg: RGB = { r: 4, g: 4, b: 10 }): Frame {
  const w = width;
  const h = height;
  const frame = new Frame({ width: w, height: h, bg });
  const cx = w / 2;
  const cy = h / 2;
  const rng = new Rng(seed);
  const N = Math.round((w * h) / 26);
  const ramp = ' .·:-=+*#%@';
  for (let i = 0; i < N; i++) {
    const ang = rng.next() * Math.PI * 2;
    const rad = rng.next() ** 0.6;
    const speed = 0.35 + rng.next() * 1.5;
    const z = ((rng.next() + t * speed) % 1);
    const dist = 0.12 + z * 1.5;
    const px = Math.round(cx + Math.cos(ang) * rad * w * 0.52 * dist);
    const py = Math.round(cy + Math.sin(ang) * rad * h * 0.52 * dist);
    if (!frame.inside(px, py)) continue;
    const bright = Math.max(0, Math.min(1, (z - 0.1) * 1.25));
    const idx = Math.min(ramp.length - 1, Math.floor(bright * ramp.length));
    const c = mix({ r: 90, g: 120, b: 220 }, { r: 235, g: 245, b: 255 }, bright);
    frame.set(px, py, ramp[idx]!, { fg: c, bold: bright > 0.7, dim: bright < 0.25 });
  }
  return frame;
}

/** 星云单独的贴图（用于 banner 背景） */
export function nebula(width: number, height: number, hue = 240, seed = 'nebula', intensity = 0.55): Frame {
  const frame = new Frame({ width, height, bg: { r: 4, g: 4, b: 10 } });
  const noise = new Noise(seed);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const a = noise.fbm2(x * 0.05, y * 0.1, 5);
      const b = noise.warp2(x * 0.03 + 40, y * 0.06 - 20, 0.9, 4);
      const v = Math.max(0, a * 0.7 + b * 0.5 + 0.28) * intensity;
      const c = hslToRgb((hue + b * 90) % 360, 0.68, 0.06 + v * 0.38);
      frame.set(x, y, ' ', { bg: c });
    }
  }
  return frame;
}

/** 给背景叠加一层暗角（vignette），让中心更聚焦 */
export function vignette(frame: Frame, strength = 0.55): void {
  const cx = (frame.width - 1) / 2;
  const cy = (frame.height - 1) / 2;
  const maxD = Math.hypot(cx, cy) || 1;
  for (let y = 0; y < frame.height; y++) {
    for (let x = 0; x < frame.width; x++) {
      const d = Math.hypot(x - cx, (y - cy) * 0.62) / maxD;
      const k = Math.max(0, d - 0.45) / 0.55;
      if (k <= 0) continue;
      const c = frame.get(x, y)!;
      const amount = k * strength;
      const fg = c.fg ? shade(c.fg, -amount) : undefined;
      const bg = c.bg ? shade(c.bg, -amount * 0.85) : undefined;
      frame.set(x, y, c.ch, { fg, bg, bold: c.bold, dim: c.dim || k > 0.75 });
    }
  }
}

export const sky = { starfield, makeStars, spawnShooter, drawShooter, hyperspace, nebula, vignette };
export default sky;
