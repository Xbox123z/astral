/**
 * Unicode 安全的显示宽度处理。
 *
 * 终端里做 ASCII 行星时，我们要么按「显示列」铺字符（CJK 占 2 列），
 * 要么按 grapheme cluster 切分（emoji / 组合记号不能拆），
 * 否则 Windows Terminal 与 iTerm2 的换行位置会不一致。
 */

/** 简易 East Asian Width：返回 0 / 1 / 2 */
export function charWidth(cp: number): 0 | 1 | 2 {
  // 组合记号（Mn / Me）与零宽
  if (cp === 0) return 0;
  if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) return 0;

  // 组合用区间
  if (
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0x0483 && cp <= 0x0489) ||
    (cp >= 0x0591 && cp <= 0x05bd) ||
    (cp >= 0x0610 && cp <= 0x061a) ||
    (cp >= 0x064b && cp <= 0x065f) ||
    (cp >= 0x0670 && cp <= 0x0670) ||
    (cp >= 0x06d6 && cp <= 0x06dc) ||
    (cp >= 0x0730 && cp <= 0x074a) ||
    (cp >= 0x07a6 && cp <= 0x07b0) ||
    (cp >= 0x0900 && cp <= 0x0903) ||
    (cp >= 0x093c && cp <= 0x094d) ||
    (cp >= 0x0951 && cp <= 0x0957) ||
    (cp >= 0x0e31 && cp <= 0x0e31) ||
    (cp >= 0x0e34 && cp <= 0x0e3a) ||
    (cp >= 0x0e47 && cp <= 0x0e4e) ||
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) ||
    (cp >= 0x20d0 && cp <= 0x20f0) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    (cp >= 0xfe20 && cp <= 0xfe2f) ||
    (cp >= 0x101fd && cp <= 0x101fd) ||
    (cp >= 0x1f1e6 && cp <= 0x1f1ff) // regional indicator 单独处理
  ) {
    return 0;
  }

  // 宽 / 全角
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x20000 && cp <= 0x2fffd) ||
    (cp >= 0x30000 && cp <= 0x3fffd)
  ) {
    return 2;
  }

  // emoji 主体按 2 列处理（多数终端如此）
  if (
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x1f680 && cp <= 0x1f6ff) ||
    (cp >= 0x2600 && cp <= 0x27bf)
  ) {
    return 2;
  }

  return 1;
}

const GRAPHEME_CACHE = new Map<string, string[]>();

/** 按 grapheme cluster 切分（够用的近似实现：处理 emoji ZWJ、VS16、肤色、旗帜） */
export function graphemes(s: string): string[] {
  const hit = GRAPHEME_CACHE.get(s);
  if (hit) return hit;
  const out: string[] = [];
  const chars = Array.from(s);
  for (let i = 0; i < chars.length; i++) {
    let cluster = chars[i]!;
    // 变体选择符 / 肤色 / 键帽
    while (i + 1 < chars.length) {
      const next = chars[i + 1]!;
      const cp = next.codePointAt(0)!;
      const isModifier =
        (cp >= 0xfe00 && cp <= 0xfe0f) ||
        (cp >= 0x1f3fb && cp <= 0x1f3ff) ||
        cp === 0x20e3 ||
        cp === 0x200d;
      if (!isModifier) break;
      cluster += next;
      i++;
      if (cp === 0x200d && i + 1 < chars.length) {
        cluster += chars[i + 1]!;
        i++;
      }
    }
    // 国旗：连续两个 regional indicator
    if (
      i + 1 < chars.length &&
      cluster.length === 1 &&
      /^[\u{1F1E6}-\u{1F1FF}]$/u.test(cluster) &&
      /^[\u{1F1E6}-\u{1F1FF}]$/u.test(chars[i + 1]!)
    ) {
      cluster += chars[i + 1]!;
      i++;
    }
    out.push(cluster);
  }
  if (out.length < 4096) GRAPHEME_CACHE.set(s, out);
  return out;
}

/**
 * ANSI 转义序列（CSI / OSC）。
 *
 * 为什么必须单独处理：displayWidth / sliceByWidth / truncate 全都要算列数，
 * 而 ESC(0x1b) 在 charWidth 里被判为 0 宽，但它后面的 `[`、`3`、`8`、`m`
 * 都是普通字符，会被各算 1 列。结果一段颜色代码能让宽度虚增十几列，
 * truncate 就会切在序列中间，终端收到 `ESC[0` 这种残片后行为未定义
 * （实测表现为边框错位、颜色漏到下一行）。
 *
 * 所以：任何涉及宽度的函数都先把转义序列整体摘出来再算。
 */
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

/** 去掉字符串里的 ANSI 转义序列 */
export function stripEscapes(s: string): string {
  return s.replace(ANSI_RE, '');
}

/** 按 grapheme 切分，但把每个 ANSI 转义序列当作一个「零宽原子」保留 */
function splitAtoms(s: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    if (s.charCodeAt(i) === 0x1b) {
      // 吃掉整个转义序列（含结尾字节）
      ANSI_RE.lastIndex = i;
      const m = ANSI_RE.exec(s);
      if (m && m.index === i) {
        out.push(m[0]);
        i += m[0].length;
        continue;
      }
      // 不完整/无法识别：单个 ESC 当零宽原子，避免死循环
      out.push(s[i]!);
      i++;
      continue;
    }
    // 普通文本：取一个 grapheme cluster
    const g = graphemes(s.slice(i, i + 16))[0] ?? s[i]!;
    out.push(g);
    i += g.length;
  }
  return out;
}

/** 显示宽度（列数）；自动忽略 ANSI 转义序列 */
export function displayWidth(s: string): number {
  let w = 0;
  for (const a of splitAtoms(s)) {
    if (a.charCodeAt(0) === 0x1b) continue; // 转义序列零宽
    // 这里不能用 displayWidth(a) 递归（自调用），改成直接按码点累加
    for (const ch of Array.from(a)) w += charWidth(ch.codePointAt(0)!);
  }
  return w;
}

/**
 * 按显示列切片。
 *
 * ANSI 转义序列是不可分割的原子，且必须**整段保留**：
 *  - 切片点落在序列之前就带上它（否则切出的残片会让终端漏色）
 *  - 序列本身零宽，不消耗列数
 *  - 切片结束后如果后面还跟着序列（例如 RESET），也要带上，
 *    否则颜色会一直延续到本行末尾之外
 */
export function sliceByWidth(s: string, startCol: number, endCol: number): string {
  let col = 0;
  let out = '';
  let pending = ''; // 已进入范围但还没遇到可见字符时，暂存连续的转义序列
  for (const a of splitAtoms(s)) {
    const isEsc = a.charCodeAt(0) === 0x1b;
    const w = isEsc ? 0 : displayWidth(a);
    if (isEsc) {
      // 转义序列总是保留（零宽，不占列），保证颜色完整不断裂
      if (out || col >= startCol) out += a;
      else pending += a;
      continue;
    }
    if (col >= endCol) {
      // 可见字符已超出范围：把暂存的转义序列补上再结束
      return out + pending;
    }
    if (col + w > startCol) {
      out += pending + a;
      pending = '';
    }
    col += w;
  }
  return out + pending;
}

/** 截断到 maxCols 列，溢出加省略符 */
export function truncate(s: string, maxCols: number, ellipsis = '…'): string {
  if (displayWidth(s) <= maxCols) return s;
  const ew = displayWidth(ellipsis);
  const cut = sliceByWidth(s, 0, Math.max(0, maxCols - ew));
  return cut + ellipsis;
}

/** 左侧 / 右侧 / 居中填充到 width 列 */
export function pad(s: string, width: number, align: 'left' | 'right' | 'center' = 'left', fill = ' '): string {
  const w = displayWidth(s);
  const pad = Math.max(0, width - w);
  if (align === 'right') return fill.repeat(pad) + s;
  if (align === 'center') {
    const l = Math.floor(pad / 2);
    return fill.repeat(l) + s + fill.repeat(pad - l);
  }
  return s + fill.repeat(pad);
}

/**
 * 按显示宽度做硬换行。
 * 转义序列整体搬运到下一行（不会把一个序列切断），所以着色能跨越换行。
 */
export function wrapText(s: string, width: number): string[] {
  const lines: string[] = [];
  let cur = '';
  let curW = 0;
  for (const a of splitAtoms(s)) {
    const isEsc = a.charCodeAt(0) === 0x1b;
    const w = isEsc ? 0 : displayWidth(a);
    if (!isEsc && curW + w > width) {
      lines.push(cur);
      cur = '';
      curW = 0;
      if (a === ' ') continue;
    }
    cur += a;
    curW += w;
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}

export const uni = {
  charWidth,
  graphemes,
  displayWidth,
  sliceByWidth,
  truncate,
  pad,
  wrapText,
};
export default uni;
