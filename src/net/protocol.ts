/**
 * ASTRAL 线上协议。
 *
 * 设计约束：
 *  - 单帧二进制：4 字节长度前缀 + 报头 + 载荷，TCP/WebSocket/蓝牙都能承载。
 *  - 加密在业务层之上：payload 一律是 AES-GCM 密文，明文永不出网卡。
 *  - 支持分片：蓝牙/低功耗链路 MTU 小，文件与长消息要能切片重组。
 *  - 版本化：magic + version，不兼容直接拒绝并给出可读原因。
 */

import { Buffer } from 'node:buffer';
import { Writer, Reader } from '../lib/byte-order.js';

export const MAGIC = 0x4153_5452; // 'ASTR'
export const VERSION = 1;

/**
 * 帧类型。
 * 使用普通 const 对象而非 `const enum`：const enum 无法作为值导出，
 * 而 FRAME_TYPE_NAME 需要按值索引。
 */
export const FrameType = {
  /** 握手：交换临时公钥与能力 */
  Hello: 1,
  /** 握手应答 */
  Welcome: 2,
  /** 加密的业务载荷 */
  Envelope: 3,
  /** 心跳 / 保活 */
  Ping: 4,
  Pong: 5,
  /** 优雅断开 */
  Bye: 6,
  /** 错误通告（明文原因，不含敏感数据） */
  Error: 7,
  /** 分片载荷 */
  Chunk: 8,
  /** UDP 发现广播（不加密，只含房间 id 哈希与端口） */
  Beacon: 9,
} as const;

export type FrameType = (typeof FrameType)[keyof typeof FrameType];

/** 旧式枚举别名（保持外部代码可读） */
export type FrameTypeValue = FrameType;

export const FRAME_TYPE_NAME: Record<number, string> = {
  [FrameType.Hello]: 'HELLO',
  [FrameType.Welcome]: 'WELCOME',
  [FrameType.Envelope]: 'ENVELOPE',
  [FrameType.Ping]: 'PING',
  [FrameType.Pong]: 'PONG',
  [FrameType.Bye]: 'BYE',
  [FrameType.Error]: 'ERROR',
  [FrameType.Chunk]: 'CHUNK',
  [FrameType.Beacon]: 'BEACON',
};

export interface FrameHeader {
  magic: number;
  version: number;
  type: FrameType;
  flags: number;
  /** 关联 id：请求/响应、分片组 */
  corr: number;
  /** 载荷长度（不含报头） */
  len: number;
}

export const HEADER_LEN = 16; // magic4 + ver2 + type1 + flags1 + corr4 + len4
export const MAX_FRAME = 8 * 1024 * 1024; // 8 MiB 硬上限，防内存耗尽

export const Flag = {
  /** 这是分片序列的最后一帧 */
  ChunkLast: 1 << 0,
  /** 需要对方 ACK */
  NeedAck: 1 << 1,
  /** 压缩（deflate） */
  Compressed: 1 << 2,
  /** 高优先级（游戏动作、投票） */
  Priority: 1 << 3,
} as const;

export function encodeFrame(type: FrameType, payload: Buffer, corr = 0, flags = 0): Buffer {
  const head = new Writer()
    .u32(MAGIC)
    .u16(VERSION)
    .u8(type)
    .u8(flags)
    .u32(corr)
    .u32(payload.length)
    .done();
  return Buffer.concat([head, payload]);
}

export function decodeHeader(b: Buffer): FrameHeader {
  if (b.length < HEADER_LEN) throw new RangeError('frame header truncated');
  const r = new Reader(b);
  const magic = r.u32();
  if (magic !== MAGIC) {
    throw new ProtocolError(`bad magic 0x${magic.toString(16)} (expected ASTR)`);
  }
  const version = r.u16();
  if (version !== VERSION) {
    throw new ProtocolError(`unsupported protocol version ${version} (this build speaks ${VERSION})`);
  }
  return {
    magic,
    version,
    type: r.u8() as FrameType,
    flags: r.u8(),
    corr: r.u32(),
    len: r.u32(),
  };
}

export class ProtocolError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'ProtocolError';
  }
}

/**
 * 分帧器：把 TCP/WebSocket 的字节流切成完整帧。
 * 长度前缀是报头里的 len 字段，不是额外前缀——这样蓝牙链路也能一次写满。
 */
export class FrameParser {
  private buf: Buffer = Buffer.alloc(0);
  public onFrame: ((h: FrameHeader, payload: Buffer) => void) | null = null;
  public onError: ((e: Error) => void) | null = null;

  push(chunk: Buffer): void {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    for (;;) {
      if (this.buf.length < HEADER_LEN) return;
      let h: FrameHeader;
      try {
        h = decodeHeader(this.buf);
      } catch (e) {
        // 头部损坏，无法恢复：丢弃全部缓冲并要求上层重连
        this.buf = Buffer.alloc(0);
        this.onError?.(e instanceof Error ? e : new Error(String(e)));
        return;
      }
      if (h.len > MAX_FRAME) {
        this.buf = Buffer.alloc(0);
        this.onError?.(new ProtocolError(`frame too large: ${h.len} bytes`));
        return;
      }
      if (this.buf.length < HEADER_LEN + h.len) return; // 等更多数据
      const payload = Buffer.from(this.buf.subarray(HEADER_LEN, HEADER_LEN + h.len));
      this.buf = this.buf.subarray(HEADER_LEN + h.len);
      this.onFrame?.(h, payload);
    }
  }

  get pending(): number {
    return this.buf.length;
  }

  reset(): void {
    this.buf = Buffer.alloc(0);
  }
}

/* ------------------------------------------------------------------ */
/* 载荷结构                                                            */
/* ------------------------------------------------------------------ */

/** Hello：宣告身份与能力 */
export interface HelloPayload {
  peerId: string;
  nickname: string;
  /** 临时 X25519 公钥，用于协商会话密钥 */
  ephPub: Buffer;
  /** 长期 Ed25519 公钥 */
  idPub: Buffer;
  capabilities: string[];
  /** 想加入的房间 id */
  roomId: string;
}

export function encodeHello(p: HelloPayload): Buffer {
  const w = new Writer()
    .str(p.peerId)
    .str(p.nickname)
    .bytes(p.ephPub)
    .bytes(p.idPub)
    .u16(p.capabilities.length);
  for (const c of p.capabilities) w.str(c);
  w.str(p.roomId);
  return w.done();
}

export function decodeHello(b: Buffer): HelloPayload {
  const r = new Reader(b);
  const peerId = r.str();
  const nickname = r.str();
  const ephPub = r.bytes();
  const idPub = r.bytes();
  const n = r.u16();
  const capabilities: string[] = [];
  for (let i = 0; i < n; i++) capabilities.push(r.str());
  const roomId = r.str();
  return { peerId, nickname, ephPub, idPub, capabilities, roomId };
}

/** Welcome：房间参数（含 salt 与迭代次数，密钥本身不出网） */
export interface WelcomePayload {
  peerId: string;
  roomId: string;
  salt: Buffer;
  iterations: number;
  /** 已在线成员（用于快速建立名册） */
  members: { id: string; nick: string }[];
  /** 服务器时间，用于时钟偏移校正 */
  serverTime: number;
}

export function encodeWelcome(p: WelcomePayload): Buffer {
  const w = new Writer()
    .str(p.peerId)
    .str(p.roomId)
    .bytes(p.salt)
    .u32(p.iterations)
    .u16(p.members.length);
  for (const m of p.members) w.str(m.id).str(m.nick);
  w.u64(p.serverTime);
  return w.done();
}

export function decodeWelcome(b: Buffer): WelcomePayload {
  const r = new Reader(b);
  const peerId = r.str();
  const roomId = r.str();
  const salt = r.bytes();
  const iterations = r.u32();
  const n = r.u16();
  const members: { id: string; nick: string }[] = [];
  for (let i = 0; i < n; i++) {
    const id = r.str();
    const nick = r.str();
    members.push({ id, nick });
  }
  const serverTime = Number(r.u64());
  return { peerId, roomId, salt, iterations, members, serverTime };
}

/** UDP 发现信标：只广播房间 id 哈希，不泄露房间名 */
export interface BeaconPayload {
  roomHash: Buffer; // sha256(roomId) 前 12 字节
  port: number;
  /** 传输类型：tcp / ws / bt */
  transports: string[];
  peerCount: number;
  /** 房间是否加密（口令保护） */
  secured: boolean;
}

export function encodeBeacon(p: BeaconPayload): Buffer {
  const w = new Writer().bytes(p.roomHash).u16(p.port).u16(p.transports.length);
  for (const t of p.transports) w.str(t);
  w.u16(p.peerCount).u8(p.secured ? 1 : 0);
  return w.done();
}

export function decodeBeacon(b: Buffer): BeaconPayload {
  const r = new Reader(b);
  const roomHash = r.bytes();
  const port = r.u16();
  const n = r.u16();
  const transports: string[] = [];
  for (let i = 0; i < n; i++) transports.push(r.str());
  const peerCount = r.u16();
  const secured = r.u8() === 1;
  return { roomHash, port, transports, peerCount, secured };
}

/* ------------------------------------------------------------------ */
/* 分片                                                                */
/* ------------------------------------------------------------------ */

/** 默认分片大小：蓝牙 RFCOMM 常见 MTU 附近 */
export const DEFAULT_CHUNK = 24 * 1024;

export function chunkPayload(payload: Buffer, corr: number, size = DEFAULT_CHUNK): Buffer[] {
  const out: Buffer[] = [];
  let off = 0;
  let seq = 0;
  while (off < payload.length) {
    const slice = payload.subarray(off, off + size);
    off += size;
    const last = off >= payload.length;
    const w = new Writer().u32(corr).u32(seq).bytes(slice);
    out.push(encodeFrame(FrameType.Chunk, w.done(), corr, last ? Flag.ChunkLast : 0));
    seq++;
  }
  if (out.length === 0) {
    const w = new Writer().u32(corr).u32(0).bytes(Buffer.alloc(0));
    out.push(encodeFrame(FrameType.Chunk, w.done(), corr, Flag.ChunkLast));
  }
  return out;
}

export interface ChunkPart {
  corr: number;
  seq: number;
  data: Buffer;
}

export function decodeChunk(b: Buffer): ChunkPart {
  const r = new Reader(b);
  const corr = r.u32();
  const seq = r.u32();
  const data = r.bytes();
  return { corr, seq, data };
}

/** 收集分片，返回完整载荷（收到 last 且序号连续时） */
export class ChunkAssembler {
  private parts = new Map<number, { got: Map<number, Buffer>; last: number | null }>();

  add(corr: number, seq: number, data: Buffer, isLast: boolean): Buffer | null {
    let e = this.parts.get(corr);
    if (!e) {
      e = { got: new Map(), last: null };
      this.parts.set(corr, e);
    }
    e.got.set(seq, data);
    if (isLast) e.last = seq;
    if (e.last === null) return null;
    for (let i = 0; i <= e.last; i++) {
      if (!e.got.has(i)) return null; // 还缺片
    }
    const buf = Buffer.concat(Array.from({ length: e.last + 1 }, (_, i) => e.got.get(i)!));
    this.parts.delete(corr);
    return buf;
  }

  /** 清理超时未完成的组，防内存泄漏 */
  sweep(maxAgeMs = 30_000): void {
    void maxAgeMs;
    if (this.parts.size > 64) {
      // 简单策略：超过 64 个未完成组就丢弃最早的
      const keys = Array.from(this.parts.keys()).slice(0, this.parts.size - 64);
      for (const k of keys) this.parts.delete(k);
    }
  }
}

/* ------------------------------------------------------------------ */
/* 心跳与超时                                                          */
/* ------------------------------------------------------------------ */

export const PING_INTERVAL_MS = 15_000;
export const PEER_TIMEOUT_MS = 45_000;

export const protocol = {
  MAGIC,
  VERSION,
  FrameType,
  FRAME_TYPE_NAME,
  HEADER_LEN,
  MAX_FRAME,
  Flag,
  encodeFrame,
  decodeHeader,
  FrameParser,
  ProtocolError,
  encodeHello,
  decodeHello,
  encodeWelcome,
  decodeWelcome,
  encodeBeacon,
  decodeBeacon,
  chunkPayload,
  decodeChunk,
  ChunkAssembler,
  DEFAULT_CHUNK,
  PING_INTERVAL_MS,
  PEER_TIMEOUT_MS,
};

export default protocol;
