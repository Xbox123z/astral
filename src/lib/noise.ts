/**
 * 值噪声 / FBM / 域扭曲 —— ASCII 行星云带的物理来源。
 *
 * 木星的「斑马纹」用 1D fbm（只在纬度上采样）+ 域扭曲（模拟湍流涡旋）；
 * 土星的环用径向 1D 噪声调制亮度；星云用 2D fbm。
 * 全部纯函数，同一 seed 三端结果一致。
 */
import { Rng, hash32 } from './rng.js';

const PERM_SIZE = 512;

function buildPerm(seed: number): Uint8Array {
  const rng = new Rng(seed);
  const p = new Uint8Array(PERM_SIZE);
  const base = new Uint8Array(256);
  for (let i = 0; i < 256; i++) base[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = rng.int(0, i);
    const t = base[i]!;
    base[i] = base[j]!;
    base[j] = t;
  }
  for (let i = 0; i < PERM_SIZE; i++) p[i] = base[i & 255]!;
  return p;
}

const fade = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export class Noise {
  private perm: Uint8Array;

  constructor(seed: number | string = 1337) {
    this.perm = buildPerm(typeof seed === 'string' ? hash32(seed) : seed);
  }

  private grad1(i: number, x: number): number {
    const h = this.perm[i & 511]!;
    const g = (h & 15) / 7.5 - 1; // [-1,1]
    return g * x;
  }

  /** 1D 值噪声，返回 [-1,1] */
  noise1(x: number): number {
    const xi = Math.floor(x);
    const xf = x - xi;
    const u = fade(xf);
    const a = this.grad1(xi, xf);
    const b = this.grad1(xi + 1, xf - 1);
    return lerp(a, b, u) * 2;
  }

  /** 2D 值噪声，返回 [-1,1] */
  noise2(x: number, y: number): number {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    const u = fade(xf);
    const v = fade(yf);
    const g = (hx: number, hy: number, dx: number, dy: number): number => {
      const h = this.perm[(this.perm[hx & 511]! + hy) & 511]!;
      const ang = (h / 255) * Math.PI * 2;
      return Math.cos(ang) * dx + Math.sin(ang) * dy;
    };
    const n00 = g(xi, yi, xf, yf);
    const n10 = g(xi + 1, yi, xf - 1, yf);
    const n01 = g(xi, yi + 1, xf, yf - 1);
    const n11 = g(xi + 1, yi + 1, xf - 1, yf - 1);
    return lerp(lerp(n00, n10, u), lerp(n01, n11, u), v) * 1.4;
  }

  /** 分形叠加 */
  fbm1(x: number, octaves = 4, lacunarity = 2, gain = 0.5): number {
    let amp = 1;
    let freq = 1;
    let sum = 0;
    let norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += amp * this.noise1(x * freq);
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return sum / (norm || 1);
  }

  fbm2(x: number, y: number, octaves = 4, lacunarity = 2, gain = 0.5): number {
    let amp = 1;
    let freq = 1;
    let sum = 0;
    let norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += amp * this.noise2(x * freq, y * freq);
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return sum / (norm || 1);
  }

  /** 域扭曲后的 fbm：制造木星那种被撕扯的涡旋边缘 */
  warp2(x: number, y: number, strength = 0.6, octaves = 4): number {
    const qx = this.fbm2(x + 0.0, y + 0.0, 3);
    const qy = this.fbm2(x + 5.2, y + 1.3, 3);
    return this.fbm2(x + strength * qx, y + strength * qy, octaves);
  }

  /** 湍流（绝对值叠加），云带边缘更锐利 */
  turbulence2(x: number, y: number, octaves = 4): number {
    let amp = 1;
    let freq = 1;
    let sum = 0;
    for (let i = 0; i < octaves; i++) {
      sum += amp * Math.abs(this.noise2(x * freq, y * freq));
      amp *= 0.5;
      freq *= 2;
    }
    return sum;
  }

  /** 环向噪声：土星环的周期性密度调制 */
  ring(x: number, bands = 7): number {
    const base = Math.sin(x * Math.PI * 2 * bands) * 0.5 + 0.5;
    const rough = this.fbm1(x * 24, 4) * 0.35;
    return Math.max(0, Math.min(1, base * 0.75 + rough + 0.15));
  }
}

/** 轻量哈希噪声（不需要对象、一次性的场景） */
export function hashNoise2(x: number, y: number, seed = 0): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export default Noise;
