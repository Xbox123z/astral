/**
 * 局域网零配置发现。
 *
 * 手机热点 / 家用 WiFi / 公司 LAN 本质上都是「同一广播域」，
 * 所以发现策略是：UDP 广播 + 多播双发，谁先回就用谁。
 *
 * 隐私设计：信标里只有 sha256(roomId) 的前 12 字节，**不含房间名**。
 * 不知道房间名+口令的人，即使抓到广播也推不出房间是什么。
 *
 * 跨平台要点：
 *  - macOS/Linux：广播到 255.255.255.255 与 224.0.0.x 多播均可。
 *  - Windows：广播通常可用；多播需要绑定到具体网卡，故逐个网卡遍历。
 *  - 多网卡机器（WiFi + 以太网 + 虚拟机网卡）必须每个都发，否则发现不到。
 */

import dgram from 'node:dgram';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { Buffer } from 'node:buffer';
import { encodeBeacon, decodeBeacon, FrameType, encodeFrame, decodeHeader, HEADER_LEN } from './protocol.js';
import { sha256 } from '../crypto/identity.js';
import type { BeaconPayload } from './protocol.js';

export const DISCOVERY_PORT = 7330;
export const MULTICAST_GROUP = '224.0.73.31';

export interface DiscoveredRoom {
  roomHash: string;
  host: string;
  port: number;
  transports: string[];
  peerCount: number;
  secured: boolean;
  /** 最后一次收到的时间 */
  lastSeen: number;
  /** 信号新鲜度 0..1（刚收到=1，快过期=0） */
  freshness: number;
}

export interface DiscoveryOptions {
  /** 要宣告的房间（可选；不宣告则为纯监听模式） */
  announce?: {
    roomId: string;
    port: number;
    transports: string[];
    peerCount: number;
    secured: boolean;
  };
  port?: number;
  /** 信标间隔 */
  intervalMs?: number;
  /** 多久没收到就认为对方离线 */
  ttlMs?: number;
}

/**
 * 发现器：既能广播自己，也能监听别人。
 * 一个进程开一个即可。
 */
export class Discovery extends EventEmitter {
  private sock: dgram.Socket | null = null;
  private timer: NodeJS.Timeout | null = null;
  private rooms = new Map<string, DiscoveredRoom>(); // key = roomHash@host:port
  private readonly port: number;
  private readonly intervalMs: number;
  private readonly ttlMs: number;
  private announce: DiscoveryOptions['announce'];
  private bound = false;

  constructor(opts: DiscoveryOptions = {}) {
    super();
    this.port = opts.port ?? DISCOVERY_PORT;
    this.intervalMs = opts.intervalMs ?? 2000;
    this.ttlMs = opts.ttlMs ?? 8000;
    this.announce = opts.announce;
  }

  /** 当前宣告的房间参数（可在运行时更新 peerCount） */
  setAnnounce(a: DiscoveryOptions['announce']): void {
    this.announce = a;
  }

  async start(): Promise<void> {
    if (this.sock) return;
    this.sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    this.sock.on('message', (msg, rinfo) => {
      void this.handleMessage(msg, rinfo);
    });
    this.sock.on('error', (e: Error) => {
      // 常见于 Windows 上某张网卡不支持多播：不能让整个发现器挂掉
      this.emit('error', e);
    });

    await new Promise<void>((resolve, reject) => {
      const onErr = (e: Error): void => reject(e);
      this.sock!.once('error', onErr);
      this.sock!.bind(this.port, () => {
        this.sock!.removeListener('error', onErr);
        this.bound = true;
        try {
          this.sock!.setBroadcast(true);
          this.sock!.setMulticastTTL(2);
          // 尽可能加入多播组（失败不影响广播通路）
          try {
            this.sock!.addMembership(MULTICAST_GROUP);
          } catch {
            /* 某些平台/网卡不支持，忽略 */
          }
        } catch {
          /* ignore */
        }
        resolve();
      });
    });

    this.emit('ready');
    if (this.announce) this.timer = setInterval(() => this.broadcast(), this.intervalMs);
  }

  private handleMessage(msg: Buffer, rinfo: dgram.RemoteInfo): void {
    if (msg.length < HEADER_LEN) return;
    let type: number;
    let payload: Buffer;
    try {
      const h = decodeHeader(msg);
      type = h.type;
      payload = Buffer.from(msg.subarray(HEADER_LEN, HEADER_LEN + h.len));
    } catch {
      return; // 不是我们的包，静默丢弃
    }
    if (type !== FrameType.Beacon) return;

    let b: BeaconPayload;
    try {
      b = decodeBeacon(payload);
    } catch {
      return;
    }
    // 忽略自己发的
    if (this.announce && b.port === this.announce.port && this.isLocalAddress(rinfo.address)) {
      return;
    }

    const key = `${b.roomHash.toString('hex')}@${rinfo.address}:${b.port}`;
    const now = Date.now();
    const existing = this.rooms.get(key);
    this.rooms.set(key, {
      roomHash: b.roomHash.toString('hex'),
      host: rinfo.address,
      port: b.port,
      transports: b.transports,
      peerCount: b.peerCount,
      secured: b.secured,
      lastSeen: now,
      freshness: 1,
    });
    if (!existing) this.emit('room', this.rooms.get(key)!);
    else this.emit('update', this.rooms.get(key)!);
  }

  private localAddrs: Set<string> | null = null;

  private isLocalAddress(addr: string): boolean {
    if (!this.localAddrs) {
      this.localAddrs = new Set<string>();
      for (const list of Object.values(os.networkInterfaces())) {
        for (const ni of list ?? []) this.localAddrs.add(ni.address);
      }
    }
    return this.localAddrs.has(addr);
  }

  /** 广播一次信标（广播 + 多播双发，覆盖不同网络环境） */
  broadcast(): void {
    if (!this.sock || !this.bound || !this.announce) return;
    const a = this.announce;
    const payload = encodeBeacon({
      roomHash: roomHashOf(a.roomId),
      port: a.port,
      transports: a.transports,
      peerCount: a.peerCount,
      secured: a.secured,
    });
    const frame = encodeFrame(FrameType.Beacon, payload);
    const targets = new Set<string>(['255.255.255.255', MULTICAST_GROUP]);
    // 同时发往各子网定向广播（虚拟机 / 多网段环境常见）
    for (const list of Object.values(os.networkInterfaces())) {
      for (const ni of list ?? []) {
        if (ni.family !== 'IPv4' || !ni.address) continue;
        // 由 netmask 推导广播地址
        const bc = broadcastAddress(ni.address, ni.netmask);
        if (bc) targets.add(bc);
      }
    }
    for (const t of targets) {
      try {
        this.sock.send(frame, 0, frame.length, this.port, t);
      } catch {
        /* 某张网卡失败不影响其他 */
      }
    }
    this.prune();
  }

  /** 主动探测一次（发出后等待 ttl 收集回应） */
  async scanOnce(waitMs = 1200): Promise<DiscoveredRoom[]> {
    if (!this.sock) await this.start();
    // 发一个「探测信标」：roomHash 全 0 表示查询所有房间
    const probe = encodeFrame(
      FrameType.Beacon,
      encodeBeacon({
        roomHash: Buffer.alloc(12),
        port: 0,
        transports: ['probe'],
        peerCount: 0,
        secured: false,
      }),
    );
    for (const t of ['255.255.255.255', MULTICAST_GROUP]) {
      try {
        this.sock!.send(probe, 0, probe.length, this.port, t);
      } catch {
        /* ignore */
      }
    }
    await new Promise((r) => setTimeout(r, waitMs));
    return this.list();
  }

  /** 清理过期房间 */
  prune(): DiscoveredRoom[] {
    const now = Date.now();
    const gone: DiscoveredRoom[] = [];
    for (const [key, r] of this.rooms) {
      const age = now - r.lastSeen;
      if (age > this.ttlMs) {
        this.rooms.delete(key);
        gone.push(r);
      } else {
        r.freshness = Math.max(0, 1 - age / this.ttlMs);
      }
    }
    for (const g of gone) this.emit('gone', g);
    return gone;
  }

  list(): DiscoveredRoom[] {
    this.prune();
    return Array.from(this.rooms.values()).sort((a, b) => b.peerCount - a.peerCount || b.lastSeen - a.lastSeen);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.sock) {
      try {
        this.sock.close();
      } catch {
        /* ignore */
      }
      this.sock = null;
    }
    this.bound = false;
  }
}

/** 房间哈希：只暴露这个，不暴露房间名 */
export function roomHashOf(roomId: string): Buffer {
  return Buffer.from(sha256('astral-beacon', roomId).subarray(0, 12));
}

/** 由 IP + netmask 推导子网广播地址 */
export function broadcastAddress(ip: string, netmask: string): string | null {
  const a = ip.split('.').map(Number);
  const m = netmask.split('.').map(Number);
  if (a.length !== 4 || m.length !== 4 || a.some(Number.isNaN) || m.some(Number.isNaN)) return null;
  const out = a.map((v, i) => (v & m[i]!) | (~m[i]! & 0xff));
  return out.join('.');
}

/** 列出本机可用于监听的 IPv4 地址 */
export function localAddresses(): { address: string; netmask: string; family: string; name: string }[] {
  const out: { address: string; netmask: string; family: string; name: string }[] = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) {
        out.push({ address: ni.address, netmask: ni.netmask, family: ni.family, name });
      }
    }
  }
  return out;
}

export const discovery = { Discovery, roomHashOf, broadcastAddress, localAddresses, DISCOVERY_PORT, MULTICAST_GROUP };
export default discovery;
