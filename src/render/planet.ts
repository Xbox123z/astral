/**
 * ASCII 行星渲染器 —— ASTRAL 的门面。
 *
 * 渲染管线（每帧）：
 *   1. 建立字符网格，按「字符宽高比 1:2」把屏幕坐标变换成球面坐标
 *   2. 球面法线 n = (x, y, sqrt(1-x²-y²))，光照在球面各向同性空间计算
 *   3. 纬度 -> 色带（bandColor）；经度+纬度 -> fbm 域扭曲，得到云带扰动
 *   4. Lambert + 环境项 + 边缘辉光 -> 亮度
 *   5. 亮度 -> 字符梯度 ramp（' .:-=+*#%@'）
 *   6. 土星：先画环背面 -> 行星 -> 环正面，保证遮挡关系正确
 *
 * 全部纯函数，给定 (planet, size, t, seed) 结果确定，便于动画与测试。
 */
import { Frame } from '../lib/frame.js';
import { Noise } from '../lib/noise.js';
import { bandColor, PLANETS, type PlanetPalette } from '../lib/palette.js';
import { mix, shade, luminance, type RGB } from '../lib/ansi.js';
import type { Cell } from '../lib/frame.js';

export interface PlanetOptions {
  /** 直径（列数） */
  diameter: number;
  /** 自转相位 0..1 */
  spin?: number;
  /** 光源方向（弧度，标准数学角：0=右，π/2=下） */
  lightAngle?: number;
  /** 是否绘制大气辉光 */
  glow?: boolean;
  /** 是否绘制土星环 */
  ring?: boolean;
  /** 噪声种子 */
  seed?: number | string;
  /** 字符梯度，缺省用调色板的 ramp */
  ramp?: string;
  /** 背景色 */
  bg?: RGB;
  /** 是否画极冠 */
  polarCap?: boolean;
  /** 大红斑等特征标记 */
  spot?: { lat: number; lon: number; size: number; color: RGB } | undefined;
  /** 环境光强度 0..1，越高暗面越亮 */
  ambient?: number;
}

/** 字符宽高比：终端一个字符 高:宽 ≈ 2:1 */
export const CELL_ASPECT = 2;
/** 环面倾角压缩系数 */
const RING_SQUASH = 0.34;

export function renderPlanet(name: keyof typeof PLANETS | PlanetPalette, opts: PlanetOptions): Frame {
  const p: PlanetPalette = typeof name === 'string' ? PLANETS[name]! : name;
  const D = Math.max(6, Math.round(opts.diameter));
  const W = D % 2 === 0 ? D : D + 1; // 偶数宽，视觉对称
  const R = W / 2; // 赤道半径（列）
  const rowsRadius = Math.max(2, Math.round(R / CELL_ASPECT));

  const spin = opts.spin ?? 0;
  const ramp = opts.ramp ?? p.ramp;
  const bg = opts.bg ?? { r: 6, g: 6, b: 14 };
  const noise = new Noise(opts.seed ?? p.name);
  const wantRing = opts.ring ?? Boolean(p.ring);
  const polarCap = opts.polarCap ?? true;
  const ambient = opts.ambient ?? 0.13;
  const glow = opts.glow !== false;

  /* ---- 光源：默认左上经典布光 ---- */
  const la = opts.lightAngle ?? 2.35;
  let Lx = Math.cos(la);
  let Ly = Math.sin(la);
  let Lz = 0.72;
  const Ln = Math.hypot(Lx, Ly, Lz) || 1;
  Lx /= Ln;
  Ly /= Ln;
  Lz /= Ln;

  /* ---- 画布尺寸：同时容纳球体与环 ---- */
  const ringOuter = R * 1.9;
  const ringInner = R * 1.22;
  const ringCols = wantRing && p.ring ? Math.ceil(ringOuter) + 1 : 0;
  const ringRows = wantRing && p.ring ? Math.ceil(ringOuter * RING_SQUASH) + 1 : 0;
  const halfRows = Math.max(rowsRadius, ringRows);
  const H = halfRows * 2 + 1;
  const frameW = W + ringCols * 2 + 2;
  const frameH = H + 2;
  const frame = new Frame({ width: frameW, height: frameH, bg });
  const cx = Math.round(frameW / 2);
  const cy = Math.round(frameH / 2);
  const bodyTop = cy - rowsRadius;

  /* ---- 1. 环（背面：被行星遮挡的那一半） ---- */
  if (wantRing && p.ring) {
    drawRing(frame, cx, cy, R, ringInner, ringOuter, p, spin, 'back');
  }

  /* ---- 2. 球体 ---- */
  for (let row = 0; row <= rowsRadius * 2; row++) {
    const y = (row - rowsRadius) / rowsRadius; // -1(北) .. 1(南)
    const fy = bodyTop + row;
    for (let col = 0; col < W; col++) {
      const x = (col - R + 0.5) / R; // -1 .. 1
      const q = x * x + y * y;
      if (q > 1.0) continue;
      const nz = Math.sqrt(Math.max(0, 1 - q));
      const fx = cx - R + col;
      if (!frame.inside(fx, fy)) continue;

      /* --- 经纬度 --- */
      const latT = (y + 1) / 2;
      const lon = Math.atan2(x, nz) / (Math.PI * 2) + spin;

      /* --- 云带：色带分层 + 正弦扰动 + 域扭曲湍流 --- */
      const bandPhase = y * 7.5 + noise.fbm1(y * 6.4, 4) * 0.9;
      let bandT = latT + Math.sin(bandPhase * Math.PI) * 0.062;
      const warp = noise.warp2(lon * 7.5, y * 3.2 + 11, 0.85, 4);
      bandT += warp * 0.09;
      bandT = Math.max(0, Math.min(1, bandT));
      let col3: RGB = bandColor(p, bandT);

      // 湍流细节颗粒（低幅度，保留条带主体）
      const detail = noise.fbm2(lon * 20 + spin * 24, y * 8, 3);
      col3 = mix(col3, shade(col3, detail * 0.22), 0.5);

      /* --- 极冠 --- */
      if (polarCap && Math.abs(y) > 0.84) {
        const k = (Math.abs(y) - 0.84) / 0.16;
        col3 = mix(col3, p.polar, Math.min(1, k * 1.25));
      }

      /* --- 特征斑（大红斑） --- */
      if (opts.spot) {
        const dLat = (y - opts.spot.lat) / opts.spot.size;
        let dLon = lon - opts.spot.lon;
        dLon -= Math.round(dLon);
        const d = Math.hypot(dLat, dLon / (opts.spot.size * 1.75));
        if (d < 1) {
          const swirl = noise.fbm2(lon * 26, y * 26, 3) * 0.15;
          col3 = mix(col3, opts.spot.color, Math.min(1, (1 - d) * 1.25 + swirl));
        }
      }

      /* --- 光照（球面各向同性，不做 aspect 修正） --- */
      const dot = x * Lx + y * Ly + nz * Lz;
      // 终结线柔化：范围收窄，保留条带在夜侧的可见度
      const terminator = smoothstep(-0.3, 0.5, dot);
      let lit = mix(p.shadow, col3, ambient + (1 - ambient) * terminator);

      // 镜面高光
      const spec = Math.pow(Math.max(0, dot), 22) * 0.45;
      lit = mix(lit, p.highlight, Math.min(1, spec));

      // 边缘：limb darkening + 大气辉光
      const limb = 1 - Math.sqrt(q); // 中心 1 -> 边缘 0
      if (limb < 0.3) {
        const edge = (0.3 - limb) / 0.3;
        if (glow) {
          // 受光侧的边缘更亮（大气散射）
          const lit2 = Math.max(0, dot + 0.25);
          lit = mix(lit, mix(p.glow, p.highlight, 0.35), edge * edge * 0.5 * lit2);
        } else {
          lit = shade(lit, -edge * 0.35);
        }
      }

      /* --- 亮度 -> 字符 --- */
      const lum = Math.max(0, Math.min(1, luminance(lit) * 1.18 - 0.02));
      const idx = Math.min(ramp.length - 1, Math.max(0, Math.round(lum * (ramp.length - 1))));
      const cell: Partial<Cell> = { fg: lit };
      if (lum > 0.74) cell.bold = true;
      else if (lum < 0.2) cell.dim = true;
      frame.set(fx, fy, ramp[idx]!, cell);
    }
  }

  /* ---- 3. 环（正面：压在行星前半的那半） ---- */
  if (wantRing && p.ring) {
    drawRing(frame, cx, cy, R, ringInner, ringOuter, p, spin, 'front');
  }

  return frame;
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a || 1)));
  return t * t * (3 - 2 * t);
}

/**
 * 土星环：倾斜椭圆盘。
 * 屏幕行 < 0 视为「远侧」（被行星遮挡），> 0 视为「近侧」（盖在行星前）。
 */
function drawRing(
  frame: Frame,
  cx: number,
  cy: number,
  R: number,
  innerR: number,
  outerR: number,
  p: PlanetPalette,
  spin: number,
  half: 'back' | 'front',
): void {
  const ring = p.ring;
  if (!ring) return;
  const noise = new Noise(`${p.name}-ring`);
  const rowMax = Math.ceil(outerR * RING_SQUASH) + 1;
  const ramp = ' .·:-=+*#%@';

  for (let row = -rowMax; row <= rowMax; row++) {
    const isBack = row < 0;
    if (isBack !== (half === 'back')) continue;
    const ry = row / RING_SQUASH;
    for (let col = -Math.ceil(outerR); col <= Math.ceil(outerR); col++) {
      const dist = Math.hypot(col, ry);
      if (dist < innerR || dist > outerR) continue;

      // 行星本体遮挡（球体在屏幕上是 rowsRadius 高的椭圆）
      const dx = col / R;
      const dy = row / (R / CELL_ASPECT);
      if (isBack && dx * dx + dy * dy < 1) continue;

      const fx = cx + col;
      const fy = cy + row;
      if (!frame.inside(fx, fy)) continue;

      const t = (dist - innerR) / (outerR - innerR); // 0=内缘 1=外缘
      let density = noise.ring(t + 0.15, 6);
      // 卡西尼缝 + 恩克缝
      density *= 1 - Math.exp(-((t - 0.46) ** 2) / 0.0022) * 0.9;
      density *= 1 - Math.exp(-((t - 0.8) ** 2) / 0.0012) * 0.55;
      if (density < 0.1) continue;

      let c: RGB = mix(ring.inner, ring.outer, t);
      c = shade(c, (density - 0.5) * 0.42);
      c = shade(c, noise.fbm1(t * 12 + spin * 2, 3) * 0.12);

      // 行星投在环上的阴影：光源左上 -> 阴影落在右下方环面
      if (col > 0 && col < outerR && row > 0) {
        const sh = Math.max(0, 1 - Math.abs(row - 1.5) / 2.5) * Math.max(0, 1 - col / outerR);
        c = shade(c, -0.6 * sh);
      }
      // 环背侧被行星遮蔽的半影
      if (isBack) c = shade(c, -0.18);

      const lum = Math.max(0, Math.min(1, luminance(c) * 1.15));
      const idx = Math.min(ramp.length - 1, Math.max(0, Math.round(lum * (ramp.length - 1))));
      frame.set(fx, fy, ramp[idx]!, { fg: c, dim: lum < 0.28 });
    }
  }
}

/** 木星大红斑的标准参数 */
export const GREAT_RED_SPOT = {
  lat: 0.24,
  lon: 0.6,
  size: 0.16,
  color: { r: 216, g: 88, b: 58 } as RGB,
};

/** 便捷入口：木星（默认带大红斑） */
export function jupiter(opts: PlanetOptions & { spot?: boolean } = { diameter: 40 }): Frame {
  const { spot, ...rest } = opts;
  return renderPlanet('jupiter', { ...rest, spot: spot === false ? undefined : GREAT_RED_SPOT });
}

/** 便捷入口：土星（默认带环） */
export function saturn(opts: PlanetOptions): Frame {
  return renderPlanet('saturn', { ...opts, ring: true });
}

/** 便捷入口：地球 */
export function earth(opts: PlanetOptions): Frame {
  return renderPlanet('earth', opts);
}

export const planets = {
  renderPlanet,
  jupiter,
  saturn,
  earth,
  GREAT_RED_SPOT,
  CELL_ASPECT,
};
export default planets;
