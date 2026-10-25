/**
 * 星际调色板。
 *
 * 真实感来源：不是随便取几个渐变，而是按每颗行星的「实测反照率分层」建模——
 * 赤道带（暖、亮）、中纬度（冷、暗）、极冠（去饱和）、终结线（晨昏线）压暗。
 */
import { mix, hslToRgb, rgbToHsl, type RGB } from './ansi.js';

export interface PlanetPalette {
  name: string;
  /** 赤道 -> 极地的纬度色带（从上到下） */
  bands: RGB[];
  /** 高光（受光面最亮处） */
  highlight: RGB;
  /** 阴影侧 */
  shadow: RGB;
  /** 极冠 */
  polar: RGB;
  /** 大气边缘辉光 */
  glow: RGB;
  /** 环（若有） */
  ring?: { inner: RGB; outer: RGB };
  /** 字符密度阶梯（暗 -> 亮），越靠后越"实" */
  ramp: string;
}

export const PLANETS: Record<string, PlanetPalette> = {
  jupiter: {
    name: 'JUPITER',
    bands: [
      { r: 168, g: 122, b: 96 },
      { r: 214, g: 168, b: 128 },
      { r: 236, g: 214, b: 186 },
      { r: 190, g: 130, b: 104 },
      { r: 226, g: 196, b: 160 },
      { r: 168, g: 116, b: 92 },
      { r: 214, g: 176, b: 142 },
      { r: 150, g: 112, b: 92 },
    ],
    highlight: { r: 255, g: 240, b: 214 },
    shadow: { r: 44, g: 28, b: 24 },
    polar: { r: 128, g: 108, b: 100 },
    glow: { r: 255, g: 196, b: 128 },
    ramp: ' .:-=+*#%@',
  },
  saturn: {
    name: 'SATURN',
    bands: [
      { r: 186, g: 168, b: 130 },
      { r: 226, g: 208, b: 168 },
      { r: 246, g: 232, b: 198 },
      { r: 214, g: 190, b: 148 },
      { r: 238, g: 220, b: 182 },
      { r: 196, g: 172, b: 134 },
    ],
    highlight: { r: 255, g: 250, b: 228 },
    shadow: { r: 52, g: 42, b: 30 },
    polar: { r: 168, g: 162, b: 148 },
    glow: { r: 255, g: 226, b: 160 },
    ring: { inner: { r: 158, g: 140, b: 108 }, outer: { r: 244, g: 228, b: 196 } },
    ramp: ' .:-=+*#%@',
  },
  mars: {
    name: 'MARS',
    bands: [
      { r: 158, g: 76, b: 48 },
      { r: 196, g: 96, b: 56 },
      { r: 214, g: 122, b: 74 },
      { r: 176, g: 84, b: 52 },
      { r: 208, g: 108, b: 66 },
    ],
    highlight: { r: 255, g: 196, b: 148 },
    shadow: { r: 48, g: 18, b: 12 },
    polar: { r: 240, g: 244, b: 248 },
    glow: { r: 255, g: 138, b: 84 },
    ramp: ' .:-=+*#%@',
  },
  neptune: {
    name: 'NEPTUNE',
    bands: [
      { r: 32, g: 62, b: 148 },
      { r: 48, g: 92, b: 200 },
      { r: 76, g: 128, b: 232 },
      { r: 40, g: 78, b: 176 },
      { r: 92, g: 148, b: 240 },
    ],
    highlight: { r: 176, g: 214, b: 255 },
    shadow: { r: 10, g: 16, b: 44 },
    polar: { r: 132, g: 176, b: 248 },
    glow: { r: 96, g: 160, b: 255 },
    ramp: ' .:-=+*#%@',
  },
  uranus: {
    name: 'URANUS',
    bands: [
      { r: 118, g: 186, b: 190 },
      { r: 152, g: 216, b: 218 },
      { r: 178, g: 232, b: 232 },
      { r: 132, g: 198, b: 202 },
    ],
    highlight: { r: 226, g: 252, b: 252 },
    shadow: { r: 26, g: 56, b: 62 },
    polar: { r: 206, g: 240, b: 240 },
    glow: { r: 168, g: 240, b: 240 },
    ramp: ' .:-=+*#%@',
  },
  venus: {
    name: 'VENUS',
    bands: [
      { r: 214, g: 186, b: 138 },
      { r: 238, g: 214, b: 166 },
      { r: 250, g: 232, b: 190 },
      { r: 224, g: 196, b: 148 },
    ],
    highlight: { r: 255, g: 252, b: 226 },
    shadow: { r: 62, g: 48, b: 30 },
    polar: { r: 250, g: 248, b: 236 },
    glow: { r: 255, g: 224, b: 176 },
    ramp: ' .:-=+*#%@',
  },
  mercury: {
    name: 'MERCURY',
    bands: [
      { r: 128, g: 124, b: 118 },
      { r: 156, g: 152, b: 144 },
      { r: 176, g: 170, b: 162 },
      { r: 138, g: 132, b: 126 },
    ],
    highlight: { r: 232, g: 228, b: 220 },
    shadow: { r: 34, g: 32, b: 30 },
    polar: { r: 206, g: 202, b: 196 },
    glow: { r: 226, g: 220, b: 208 },
    ramp: ' .:-=+*#%@',
  },
  earth: {
    name: 'EARTH',
    bands: [
      { r: 122, g: 152, b: 186 },
      { r: 58, g: 108, b: 178 },
      { r: 40, g: 118, b: 186 },
      { r: 74, g: 142, b: 92 },
      { r: 46, g: 116, b: 176 },
      { r: 148, g: 176, b: 202 },
    ],
    highlight: { r: 226, g: 242, b: 255 },
    shadow: { r: 12, g: 20, b: 44 },
    polar: { r: 244, g: 248, b: 252 },
    glow: { r: 128, g: 186, b: 255 },
    ramp: ' .:-=+*#%@',
  },
};

export const PLANET_IDS = Object.keys(PLANETS) as PlanetId[];
export type PlanetId = keyof typeof PLANETS;

/** 取纬度 t∈[0,1]（0=北极，1=南极）的色带颜色 */
export function bandColor(p: PlanetPalette, t: number): RGB {
  const n = p.bands.length;
  const f = Math.max(0, Math.min(1, t)) * (n - 1);
  const i = Math.min(n - 2, Math.floor(f));
  return mix(p.bands[i]!, p.bands[i + 1]!, f - i);
}

/** UI 主题：一套统一的星际配色 */
export interface Theme {
  bg: RGB;
  fg: RGB;
  dim: RGB;
  accent: RGB;
  accent2: RGB;
  ok: RGB;
  warn: RGB;
  err: RGB;
  self: RGB;
  border: RGB;
}

export const THEMES: Record<string, Theme> = {
  nebula: {
    bg: { r: 8, g: 8, b: 16 },
    fg: { r: 226, g: 230, b: 240 },
    dim: { r: 110, g: 118, b: 140 },
    accent: { r: 158, g: 122, b: 255 },
    accent2: { r: 86, g: 196, b: 255 },
    ok: { r: 92, g: 220, b: 168 },
    warn: { r: 255, g: 202, b: 92 },
    err: { r: 255, g: 108, b: 108 },
    self: { r: 255, g: 176, b: 108 },
    border: { r: 66, g: 72, b: 104 },
  },
  ember: {
    bg: { r: 12, g: 8, b: 8 },
    fg: { r: 240, g: 230, b: 224 },
    dim: { r: 132, g: 116, b: 112 },
    accent: { r: 255, g: 138, b: 76 },
    accent2: { r: 255, g: 206, b: 96 },
    ok: { r: 150, g: 216, b: 120 },
    warn: { r: 255, g: 214, b: 92 },
    err: { r: 255, g: 96, b: 86 },
    self: { r: 132, g: 214, b: 255 },
    border: { r: 96, g: 68, b: 60 },
  },
  ice: {
    bg: { r: 6, g: 12, b: 20 },
    fg: { r: 222, g: 236, b: 246 },
    dim: { r: 108, g: 128, b: 148 },
    accent: { r: 96, g: 196, b: 255 },
    accent2: { r: 148, g: 236, b: 240 },
    ok: { r: 108, g: 224, b: 196 },
    warn: { r: 250, g: 214, b: 120 },
    err: { r: 255, g: 122, b: 140 },
    self: { r: 255, g: 186, b: 232 },
    border: { r: 58, g: 88, b: 116 },
  },
  mono: {
    bg: { r: 0, g: 0, b: 0 },
    fg: { r: 255, g: 255, b: 255 },
    dim: { r: 128, g: 128, b: 128 },
    accent: { r: 220, g: 220, b: 220 },
    accent2: { r: 180, g: 180, b: 180 },
    ok: { r: 255, g: 255, b: 255 },
    warn: { r: 220, g: 220, b: 220 },
    err: { r: 255, g: 255, b: 255 },
    self: { r: 245, g: 245, b: 245 },
    border: { r: 96, g: 96, b: 96 },
  },
};

export const THEME_IDS = Object.keys(THEMES);
export type ThemeId = keyof typeof THEMES;

/** 根据用户 id 稳定地派发一个识别色（聊天里每个人的名字颜色） */
export function userColor(id: string, theme: Theme = THEMES['nebula']!): RGB {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  const base = rgbToHsl(theme.accent);
  return hslToRgb((base.h + hue) % 360, 0.62, 0.68);
}

/** 房间色相：房间名 -> 主题色，用于房间 banner */
export function roomColor(room: string): RGB {
  let h = 0;
  for (let i = 0; i < room.length; i++) h = (h * 131 + room.charCodeAt(i)) >>> 0;
  return hslToRgb(h % 360, 0.7, 0.62);
}

export const palette = { PLANETS, PLANET_IDS, bandColor, THEMES, THEME_IDS, userColor, roomColor };
export default palette;
