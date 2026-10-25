/**
 * 键盘输入解析：把原始字节流翻译成语义化按键。
 *
 * 跨平台差异都在这里吸收：
 *  - Windows conhost / Windows Terminal：方向键发 3 字节 \x1b[K
 *  - Linux / macOS：同样发 CSI 序列，但修饰键编码不同（CSI 1;5A 等）
 *  - 粘贴：启用 bracketed paste 后是 \x1b[200~ ... \x1b[201~
 *  - UTF-8 多字节：必须攒够完整字符再解析，中文一次 3 字节
 */

import { EventEmitter } from 'node:events';

export interface Key {
  /** 可打印字符（含中文），非打印键为空 */
  ch: string;
  /** 语义名 */
  name:
    | 'enter'
    | 'backspace'
    | 'delete'
    | 'left'
    | 'right'
    | 'up'
    | 'down'
    | 'home'
    | 'end'
    | 'pageup'
    | 'pagedown'
    | 'tab'
    | 'escape'
    | 'char'
    | 'unknown';
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
  /** 原始序列（调试用） */
  seq: string;
}

const CSI_NAMES: Record<string, Key['name']> = {
  A: 'up',
  B: 'down',
  C: 'right',
  D: 'left',
  H: 'home',
  F: 'end',
  Z: 'tab',
};

export class KeyReader extends EventEmitter {
  private buf = Buffer.alloc(0);
  private pasting = false;
  private pasteBuf: string[] = [];

  constructor(private stream: NodeJS.ReadStream = process.stdin) {
    super();
    this.stream.on('data', (d: Buffer) => this.feed(d));
    this.stream.on('keypress', (...args: unknown[]) => {
      // Node 的 readline 在某些平台已解析好 keypress，这里兼容接收
      void args;
    });
  }

  /** 喂入原始字节，解析出 0..n 个按键 */
  feed(d: Buffer): void {
    this.buf = Buffer.concat([this.buf, d]);
    this.parse();
  }

  private parse(): void {
    for (;;) {
      if (this.buf.length === 0) return;
      const b = this.buf[0]!;

      /* ---- 粘贴模式 ---- */
      if (this.pasting) {
        const s = this.buf.toString('utf8');
        const end = s.indexOf('\x1b[201~');
        if (end < 0) {
          // 未结束，等更多数据（保留不完整尾部以正确处理多字节）
          if (this.buf.length > 0 && this.buf[this.buf.length - 1]! >= 0x80) {
            // 可能截断了一个 UTF-8 字符，等待
            for (let i = this.buf.length - 1; i >= 0 && i > this.buf.length - 4; i--) {
              if ((this.buf[i]! & 0xc0) === 0xc0) {
                const need = this.buf[i]! >= 0xf0 ? 4 : this.buf[i]! >= 0xe0 ? 3 : 2;
                if (this.buf.length - i < need) return; // 等完整
                break;
              }
            }
          }
          return;
        }
        const text = s.slice(0, end);
        this.buf = Buffer.from(s.slice(end + 6), 'utf8');
        this.pasting = false;
        this.emit('paste', text);
        continue;
      }

      /* ---- C0 控制字符 ---- */
      if (b === 0x1b) {
        const key = this.parseEscape();
        if (!key) return; // 序列不完整，等数据
        this.emit('key', key);
        continue;
      }
      if (b === 0x0d || b === 0x0a) {
        this.buf = this.buf.subarray(1);
        this.emit('key', mk('enter', '\r'));
        continue;
      }
      if (b === 0x7f || b === 0x08) {
        this.buf = this.buf.subarray(1);
        this.emit('key', mk('backspace', String.fromCharCode(b)));
        continue;
      }
      if (b === 0x09) {
        this.buf = this.buf.subarray(1);
        this.emit('key', mk('tab', '\t'));
        continue;
      }
      if (b === 0x03) {
        // Ctrl+C：交给上层决定（退出 or 复制）
        this.buf = this.buf.subarray(1);
        const k = mk('char', '\x03');
        k.ctrl = true;
        this.emit('key', k);
        continue;
      }
      if (b === 0x04) {
        this.buf = this.buf.subarray(1);
        const k = mk('char', '\x04');
        k.ctrl = true;
        this.emit('key', k);
        continue;
      }
      if (b < 0x20) {
        // 其他控制字符：Ctrl+字母
        const ch = String.fromCharCode(0x60 + b);
        this.buf = this.buf.subarray(1);
        const k = mk('char', ch);
        k.ctrl = true;
        this.emit('key', k);
        continue;
      }
      if (b < 0x80) {
        // ASCII 可打印
        const ch = String.fromCharCode(b);
        this.buf = this.buf.subarray(1);
        this.emit('key', mk('char', ch));
        continue;
      }

      /* ---- UTF-8 多字节 ---- */
      const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
      if (this.buf.length < need) return; // 等完整字符
      const ch = this.buf.subarray(0, need).toString('utf8');
      this.buf = this.buf.subarray(need);
      this.emit('key', mk('char', ch));
    }
  }

  private parseEscape(): Key | null {
    if (this.buf.length < 2) return null;
    const s = this.buf.toString('utf8');

    // 单独一个 ESC
    if (this.buf.length === 1) return null;
    if (s[1] !== '[' && s[1] !== 'O') {
      // Alt+键
      const rest = s.slice(1);
      this.buf = Buffer.alloc(0);
      const k = mk('char', rest);
      k.alt = true;
      return k;
    }

    // 粘贴开始
    if (s.startsWith('\x1b[200~')) {
      this.buf = Buffer.from(s.slice(6), 'utf8');
      this.pasting = true;
      return mk('unknown', '');
    }

    // CSI 序列：\x1b[<n>;<m><final>
    const m = /^\x1b\[([0-9;?]*)([a-zA-Z~])/.exec(s);
    if (!m) {
      if (s.length < 6 && '\x1b[0123456789;'.includes(s[s.length - 1] ?? '')) return null; // 不完整
      this.buf = Buffer.alloc(0);
      return mk('unknown', s);
    }
    const params = m[1] ?? '';
    const final = m[2]!;
    const consumed = m[0].length;
    this.buf = Buffer.from(s.slice(consumed), 'utf8');

    if (final === '~') {
      const code = Number(params || '1');
      const map: Record<number, Key['name']> = {
        1: 'home',
        2: 'unknown', // insert
        3: 'delete',
        4: 'end',
        5: 'pageup',
        6: 'pagedown',
        7: 'home',
        8: 'end',
      };
      const name = map[code] ?? 'unknown';
      const k = mk(name, m[0]!);
      parseModifiers(params, k);
      return k;
    }

    const name = CSI_NAMES[final] ?? 'unknown';
    const k = mk(name, m[0]!);
    if (final === 'Z') k.shift = true;
    parseModifiers(params, k);
    return k;
  }
}

function parseModifiers(params: string, k: Key): void {
  // CSI 1;2A -> shift+up ; 1;5A -> ctrl+up ; 1;3A -> alt+up
  const parts = params.split(';').map(Number);
  const mod = parts.length > 1 ? parts[parts.length - 1]! : 1;
  if (mod === 2) k.shift = true;
  if (mod === 3) k.alt = true;
  if (mod === 4) k.shift = true, (k.alt = true);
  if (mod === 5) k.ctrl = true;
  if (mod === 6) k.ctrl = true, (k.shift = true);
  if (mod === 7) k.ctrl = true, (k.alt = true);
  if (mod === 8) k.ctrl = true, (k.alt = true), (k.shift = true);
}

function mk(name: Key['name'], seq: string, ch = ''): Key {
  return { ch, name, ctrl: false, alt: false, shift: false, meta: false, seq };
}

export const keys = { KeyReader };
export default keys;
