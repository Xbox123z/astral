/**
 * 确定性随机源。
 *
 * 星空、行星云带、大富翁骰子都需要「同一颗种子 → 同一幅画面」：
 * 开机动画重放、游戏回放、远端房间同步骰子结果，全靠它。
 * 用 xoshiro128**，速度快、周期够、跨平台结果完全一致（纯整数运算）。
 */

export class Rng {
  private s0 = 0;
  private s1 = 0;
  private s2 = 0;
  private s3 = 0;

  constructor(seed: number | string = Date.now()) {
    this.reseed(seed);
  }

  reseed(seed: number | string): this {
    let h = 0x9e3779b9;
    if (typeof seed === 'number') h = seed >>> 0 || 0x9e3779b9;
    else {
      for (let i = 0; i < seed.length; i++) {
        h ^= seed.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
      }
    }
    // splitmix32 展开成 4 个状态
    let z = h >>> 0;
    const next = (): number => {
      z = (z + 0x9e3779b9) >>> 0;
      let t = z;
      t = Math.imul(t ^ (t >>> 16), 0x21f0aaad);
      t = Math.imul(t ^ (t >>> 15), 0x735a2d97);
      return (t ^ (t >>> 15)) >>> 0;
    };
    this.s0 = next();
    this.s1 = next();
    this.s2 = next();
    this.s3 = next();
    // 预热，避免低质量的起始状态
    for (let i = 0; i < 8; i++) this.u32();
    return this;
  }

  u32(): number {
    const rotl = (x: number, k: number): number => ((x << k) | (x >>> (32 - k))) >>> 0;
    const r = Math.imul(rotl(Math.imul(this.s1, 5) >>> 0, 7), 9) >>> 0;
    const t = (this.s1 << 9) >>> 0;
    this.s2 = (this.s2 ^ this.s0) >>> 0;
    this.s3 = (this.s3 ^ this.s1) >>> 0;
    this.s1 = (this.s1 ^ this.s2) >>> 0;
    this.s0 = (this.s0 ^ this.s3) >>> 0;
    this.s2 = (this.s2 ^ t) >>> 0;
    this.s3 = rotl(this.s3, 11);
    return r;
  }

  /** [0,1) */
  next(): number {
    return this.u32() / 4294967296;
  }

  /** [min,max) */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** [min,max] 整数 */
  int(min: number, max: number): number {
    return Math.floor(this.range(min, max + 1));
  }

  bool(p = 0.5): boolean {
    return this.next() < p;
  }

  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)]!;
  }

  /** 原地 Fisher-Yates */
  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [arr[i], arr[j]] = [arr[j]!, arr[i]!];
    }
    return arr;
  }

  /** 近似正态分布（Box-Muller），用于云带扰动 */
  gauss(mu = 0, sigma = 1): number {
    let u = 0;
    let v = 0;
    while (u === 0) u = this.next();
    while (v === 0) v = this.next();
    return mu + sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /** 导出可复现的种子串 */
  snapshot(): string {
    return [this.s0, this.s1, this.s2, this.s3].map((n) => n.toString(16).padStart(8, '0')).join('-');
  }
}

/** 全局默认随机（非确定性） */
export const rand = new Rng();

/** 快速哈希字符串 -> u32（房间色相、头像色等） */
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export default Rng;
