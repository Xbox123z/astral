/**
 * 跨平台终端控制：原始模式、VT 启用、大小变化、尺寸探测。
 *
 * Windows：Win10 1511+ 需要显式 SetConsoleMode(ENABLE_VIRTUAL_TERMINAL_PROCESSING)，
 *          这里通过 `mode con` 之外的方式不可行，故退化为依赖 Windows Terminal /
 *          ConEmu / ANSICON；同时旧 conhost 由 ColorMode 自动降级到 16 色。
 * POSIX  ：直接 tcsetattr 进 raw mode。
 */
import { EventEmitter } from 'node:events';
import os from 'node:os';
import process from 'node:process';

export type PlatformName = 'windows' | 'linux' | 'macos' | 'unknown';

export function platform(): PlatformName {
  switch (process.platform) {
    case 'win32':
      return 'windows';
    case 'darwin':
      return 'macos';
    case 'linux':
      return 'linux';
    default:
      return 'unknown';
  }
}

export const IS_WIN = process.platform === 'win32';

/** 是否支持 VT 序列（Windows 老终端会 false -> 降级） */
export function supportsAnsi(): boolean {
  if (!IS_WIN) return true;
  if (process.env['WT_SESSION']) return true; // Windows Terminal
  if (process.env['TERM_PROGRAM']) return true;
  if (process.env['ConEmuANSI'] === 'ON') return true;
  if (process.env['ANSICON']) return true;
  // Windows 10 1607+ 的 conhost 也支持，但无法可靠探测；假定支持
  const [maj] = os.release().split('.').map(Number);
  return (maj ?? 0) >= 10;
}

/**
 * 进入 raw mode：按键即时到达、关闭回显、接管 Ctrl-C。
 * 退出时务必 restore()，否则用户终端会留在无回显状态。
 */
export class RawMode extends EventEmitter {
  private isRaw = false;
  private prev: unknown = undefined;
  private listenersAttached = false;

  constructor(private stream: NodeJS.ReadStream = process.stdin) {
    super();
  }

  get active(): boolean {
    return this.isRaw;
  }

  enable(): void {
    if (this.isRaw || !this.stream.isTTY) return;
    this.prev = this.stream.isRaw ? true : false;
    try {
      this.stream.setRawMode(true);
      this.stream.resume();
      this.isRaw = true;
    } catch {
      this.isRaw = false;
    }
  }

  disable(): void {
    if (!this.isRaw) return;
    try {
      this.stream.setRawMode(Boolean(this.prev));
    } catch {
      /* ignore */
    }
    this.isRaw = false;
  }

  /** 保证进程退出时一定还原 */
  guard(): () => void {
    const restore = (): void => this.disable();
    if (!this.listenersAttached) {
      process.once('exit', restore);
      process.once('SIGINT', () => {
        this.disable();
        process.exit(130);
      });
      process.once('SIGTERM', () => {
        this.disable();
        process.exit(143);
      });
      this.listenersAttached = true;
    }
    return restore;
  }
}

export interface Size {
  width: number;
  height: number;
}

export function size(): Size {
  const envW = Number(process.env['COLUMNS'] ?? 0);
  const envH = Number(process.env['LINES'] ?? 0);
  return {
    width: Math.max(40, Math.min(process.stdout?.columns || envW || 100, 500)),
    height: Math.max(12, Math.min(process.stdout?.rows || envH || 30, 240)),
  };
}

/** 窗口尺寸变化通知 */
export function onResize(cb: (s: Size) => void): () => void {
  const handler = (): void => cb(size());
  process.stdout?.on?.('resize', handler);
  return () => process.stdout?.off?.('resize', handler);
}

/** Windows 上强制启用 VT（对支持的新版 conhost 有效，失败静默） */
export function enableWindowsVt(): boolean {
  if (!IS_WIN) return true;
  // Node 在 Win10+ 已自动尝试；这里只做兜底：写一次 DSR 查询不可靠，直接返回探测结果
  return supportsAnsi();
}

/** 设置窗口标题（含 tmux/screen 兼容） */
export function setTitle(t: string): string {
  const safe = t.replace(/[\x00-\x1f\x7f]/g, '');
  if (process.env['TMUX']) return `\x1bPtmux;\x1b\x1b]0;${safe}\x07\x1b\\`;
  return `\x1b]0;${safe}\x07`;
}

/** 响一声（Bell），某些终端支持 OSC 9;4 桌面通知 */
export function bell(): string {
  return '\x07';
}

/** 复制文本到剪贴板（OSC 52），终端支持时无需额外依赖 */
export function clipboard(text: string): string {
  const b64 = Buffer.from(text, 'utf8').toString('base64');
  return `\x1b]52;c;${b64}\x07`;
}

/**
 * 逐帧写入器：合并多次写、按目标 FPS 节流，避免终端被刷爆。
 */
export class FrameWriter {
  private timer: NodeJS.Timeout | null = null;
  private queued: string | null = null;
  private frameCount = 0;
  private lastFlush = 0;

  constructor(
    private out: NodeJS.WriteStream = process.stdout,
    private fps = 24,
  ) {}

  /** 提交一帧（同帧内多次调用只保留最后一次） */
  submit(chunk: string): void {
    this.queued = chunk;
    if (this.timer) return;
    const interval = Math.max(8, Math.round(1000 / this.fps));
    const wait = Math.max(0, interval - (Date.now() - this.lastFlush));
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, wait);
    this.timer.unref?.();
  }

  flush(): void {
    if (this.queued != null) {
      this.out.write(this.queued);
      this.queued = null;
      this.frameCount++;
      this.lastFlush = Date.now();
    }
  }

  get frames(): number {
    return this.frameCount;
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.flush();
  }
}

/** UTF-8 / 代码页：Windows 下 Node 20+ 默认 UTF-8，这里只做提示性标记 */
export function ensureUtf8(): void {
  if (IS_WIN) {
    // 旧 conhost 若出现制表符乱码，用户可 `chcp 65001` 后重启。
    // 不在此处 spawn 子进程：会阻塞启动且在某些沙箱下失败。
  }
}

export const term = {
  platform,
  IS_WIN,
  supportsAnsi,
  RawMode,
  size,
  onResize,
  enableWindowsVt,
  setTitle,
  bell,
  clipboard,
  FrameWriter,
  ensureUtf8,
};
export default term;
