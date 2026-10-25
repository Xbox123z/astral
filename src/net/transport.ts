/**
 * 传输抽象层。
 *
 * ASTRAL 要同时跑在三种链路上，因此定义统一接口：
 *   - tcp : 局域网直连 / 手机热点（主力，低延迟）
 *   - ws  : WebSocket，用于跨越 NAT 或浏览器型客户端接入
 *   - bt  : 蓝牙（可插拔，见 bluetooth.ts）
 *
 * 所有 transport 都是「字节流 + 消息边界由协议层负责」的模型。
 */

import { EventEmitter } from 'node:events';
import net from 'node:net';
import { Buffer } from 'node:buffer';

export type TransportKind = 'tcp' | 'ws' | 'bt' | 'loopback';

export interface TransportInfo {
  kind: TransportKind;
  /** 远端地址描述（ip:port / 设备名 / ws url） */
  remote: string;
  /** 本地地址描述 */
  local?: string;
  /** 估计 MTU，用于分片策略 */
  mtu: number;
  /** 是否可靠有序（蓝牙 RFCOMM 是，BLE notify 不是） */
  reliable: boolean;
}

export interface TransportEvents {
  data: [Buffer];
  close: [Error | null];
  error: [Error];
  ready: [];
}

/**
 * 传输接口。实现必须是 EventEmitter 并派发 data/close/error/ready。
 */
export interface Transport extends EventEmitter {
  readonly info: TransportInfo;
  /** 写入一段字节（自动分片由上层完成） */
  send(data: Buffer): void;
  /** 优雅关闭 */
  close(reason?: string): void;
  /** 是否已连接 */
  readonly connected: boolean;
}

/* ------------------------------------------------------------------ */
/* TCP                                                                 */
/* ------------------------------------------------------------------ */

export class TcpTransport extends EventEmitter implements Transport {
  readonly info: TransportInfo;
  private killed = false;

  constructor(private socket: net.Socket, kind: TransportKind = 'tcp') {
    super();
    const addr = socket.address() as net.AddressInfo | Record<string, never>;
    this.info = {
      kind,
      remote: `${socket.remoteAddress ?? '?'}:${socket.remotePort ?? '?'}`,
      local: 'port' in addr ? `${addr.address}:${addr.port}` : undefined,
      mtu: 64 * 1024,
      reliable: true,
    };
    socket.on('data', (d: Buffer) => this.emit('data', d));
    socket.on('close', (hadError: boolean) => {
      this.killed = true;
      this.emit('close', hadError ? new Error('socket closed with error') : null);
    });
    socket.on('error', (e: Error) => this.emit('error', e));
  }

  get connected(): boolean {
    return !this.killed && !this.socket.destroyed;
  }

  send(data: Buffer): void {
    if (!this.connected) return;
    this.socket.write(data);
  }

  close(reason?: string): void {
    if (reason) {
      // 尽力把原因写给对端（可能失败，忽略）
      try {
        this.socket.write(Buffer.from(reason, 'utf8'));
      } catch {
        /* ignore */
      }
    }
    this.socket.end();
    this.killed = true;
  }

  /** 禁用 Nagle：聊天/游戏动作要低延迟，宁可多一点小包 */
  noDelay(v = true): void {
    this.socket.setNoDelay(v);
  }

  static connect(host: string, port: number, timeoutMs = 5000): Promise<TcpTransport> {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection({ host, port });
      const t = new TcpTransport(sock);
      t.noDelay(true);
      const timer = setTimeout(() => {
        sock.destroy();
        reject(new Error(`connect timeout to ${host}:${port}`));
      }, timeoutMs);
      sock.once('connect', () => {
        clearTimeout(timer);
        resolve(t);
      });
      sock.once('error', (e: Error) => {
        clearTimeout(timer);
        reject(e);
      });
    });
  }
}

/* ------------------------------------------------------------------ */
/* 回环（测试 / 同进程多实例）                                          */
/* ------------------------------------------------------------------ */

export class LoopbackPair {
  public readonly a: LoopbackTransport;
  public readonly b: LoopbackTransport;

  constructor() {
    this.a = new LoopbackTransport('A');
    this.b = new LoopbackTransport('B');
    this.a.peer = this.b;
    this.b.peer = this.a;
  }
}

export class LoopbackTransport extends EventEmitter implements Transport {
  public peer: LoopbackTransport | null = null;
  readonly info: TransportInfo = {
    kind: 'loopback',
    remote: 'loopback',
    local: 'loopback',
    mtu: 1024 * 1024,
    reliable: true,
  };
  private open = true;

  constructor(private tag: string) {
    super();
    this.info.remote = `loopback:${tag}`;
  }

  get connected(): boolean {
    return this.open;
  }

  send(data: Buffer): void {
    if (!this.open) return;
    // 异步投递，避免同步递归
    setImmediate(() => this.peer?.emit('data', data));
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    const p = this.peer;
    setImmediate(() => {
      this.emit('close', null);
      p?.emit('close', null);
    });
  }
}

/* ------------------------------------------------------------------ */
/* 蓝牙：可插拔接口                                                     */
/* ------------------------------------------------------------------ */

export interface BluetoothDevice {
  name: string;
  address: string;
  /** 信号强度 0..1（越大约近） */
  rssi?: number;
}

/**
 * 蓝牙适配器接口。
 *
 * 真实实现放在 bluetooth.ts：Windows/Linux 走 RFCOMM（可选原生模块），
 * macOS 走 BLE。两者都缺失时返回「不可用」而不是崩溃——
 * 这正是用户要的「LAN 优先，蓝牙可插拔」。
 */
export interface BluetoothAdapter {
  readonly kind: TransportKind;
  /** 平台是否支持（缺少原生模块时为 false） */
  available(): boolean;
  /** 不可用的原因（给用户看） */
  unavailableReason(): string;
  scan(timeoutMs: number): Promise<BluetoothDevice[]>;
  /** 作为服务端广播，等待一个连接 */
  advertise(serviceName: string): Promise<BluetoothSession>;
  /** 主动连接 */
  connect(device: BluetoothDevice): Promise<BluetoothSession>;
  stop(): void;
}

export interface BluetoothSession {
  readonly transport: Transport;
  readonly device: BluetoothDevice;
  close(): void;
}

/* ------------------------------------------------------------------ */
/* 地址解析                                                            */
/* ------------------------------------------------------------------ */

export function parseHostPort(s: string, defaultPort: number): { host: string; port: number } {
  const trimmed = s.trim();
  // IPv6 带端口：[::1]:7331
  const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(trimmed);
  if (v6) return { host: v6[1]!, port: v6[2] ? Number(v6[2]) : defaultPort };
  const idx = trimmed.lastIndexOf(':');
  if (idx > 0 && !trimmed.slice(idx + 1).includes(':')) {
    const port = Number(trimmed.slice(idx + 1));
    if (Number.isInteger(port) && port > 0 && port < 65536) {
      return { host: trimmed.slice(0, idx), port };
    }
  }
  return { host: trimmed, port: defaultPort };
}

export const DEFAULT_PORT = 7331;

export const transport = {
  TcpTransport,
  LoopbackPair,
  LoopbackTransport,
  parseHostPort,
  DEFAULT_PORT,
};

export default transport;
