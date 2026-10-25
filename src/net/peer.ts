/**
 * 房间客户端（Peer）。
 *
 * 职责：
 *  - 连接 hub（TCP / WS / 蓝牙），完成 Hello/Welcome 握手
 *  - 由房间口令派生会话密钥（hub 永远不知道明文）
 *  - 收发加密信封：群聊、私聊、文件、投票、游戏动作
 *  - 私聊：与对端做 X25519 ECDH，得到 pairwise 密钥，hub 无法解密
 *  - 自动重连与心跳
 */

import { EventEmitter } from 'node:events';
import { Buffer } from 'node:buffer';
import {
  FrameType,
  encodeFrame,
  FrameParser,
  encodeHello,
  decodeWelcome,
  chunkPayload,
  Flag,
  decodeChunk,
  ChunkAssembler,
  DEFAULT_CHUNK,
} from './protocol.js';
import {
  deriveRoomKey,
  seal,
  open,
  packSealed,
  unpackSealed,
  ephemeralKeyPair,
  derivePairwiseKey,
  sha256,
} from '../crypto/identity.js';
import { TcpTransport } from './transport.js';
import type { Transport } from './transport.js';

export interface PeerConfig {
  peerId: string;
  nickname: string;
  roomId: string;
  /** 房间口令（不上传，仅本地派生密钥） */
  passphrase: string;
  capabilities?: string[];
}

export interface RoomMember {
  id: string;
  nick: string;
  spectator?: boolean;
}

/** 应用消息（明文结构，传输前会被加密） */
export type AppMessage =
  | { t: 'chat'; id: string; from: string; nick: string; text: string; ts: number }
  | { t: 'dm'; id: string; from: string; to: string; nick: string; text: string; ts: number }
  | { t: 'system'; id: string; text: string; ts: number }
  | { t: 'presence'; peers: RoomMember[] }
  | { t: 'file-offer'; id: string; from: string; nick: string; name: string; size: number; hash: string; ts: number }
  | { t: 'file-chunk'; id: string; from: string; name: string; seq: number; total: number; data: string; ts: number }
  | { t: 'file-accept'; id: string; from: string; to: string; name: string; ts: number }
  | { t: 'poll-create'; id: string; from: string; nick: string; question: string; options: string[]; multi: boolean; ts: number }
  | { t: 'poll-vote'; id: string; from: string; pollId: string; choices: number[]; ts: number }
  | { t: 'poll-state'; id: string; pollId: string; counts: number[]; voters: number; ts: number }
  | { t: 'game'; id: string; from: string; game: string; action: string; payload: unknown; ts: number }
  | { t: 'typing'; id: string; from: string; nick: string; ts: number };

export class Peer extends EventEmitter {
  private transport: Transport | null = null;
  private parser = new FrameParser();
  private chunks = new ChunkAssembler();
  private roomKey: Buffer | null = null;
  private members: RoomMember[] = [];
  private corrSeq = 1;
  private ephemeral = ephemeralKeyPair();
  /** 已协商的私聊密钥：peerId -> key */
  private pairwise = new Map<string, Buffer>();
  /** 对端临时公钥缓存 */
  private peerEphPub = new Map<string, Buffer>();
  private closed = false;

  constructor(private cfg: PeerConfig) {
    super();
    this.parser.onFrame = (h, payload) => this.onFrame(h, payload);
    this.parser.onError = (e) => this.emit('error', e);
  }

  get id(): string {
    return this.cfg.peerId;
  }

  get nick(): string {
    return this.cfg.nickname;
  }

  get roomMembers(): RoomMember[] {
    return this.members;
  }

  get isConnected(): boolean {
    return this.transport?.connected === true && this.roomKey !== null;
  }

  /** 连接 hub。transportKind='tcp' 时自己建连接；否则由调用方传入 transport */
  async connect(kind: 'tcp' | 'custom', target?: string | Transport): Promise<void> {
    let t: Transport;
    if (kind === 'tcp') {
      if (typeof target !== 'string') throw new Error('tcp connect requires "host:port"');
      const idx = target.lastIndexOf(':');
      const host = target.slice(0, idx);
      const port = Number(target.slice(idx + 1));
      t = await TcpTransport.connect(host, port);
    } else {
      if (!target || typeof target === 'string') throw new Error('custom transport required');
      t = target;
    }
    this.attach(t);
  }

  attach(t: Transport): void {
    this.transport = t;
    t.on('data', (d: Buffer) => this.parser.push(d));
    t.on('close', () => {
      this.roomKey = null;
      this.emit('disconnected');
    });
    t.on('error', (e: Error) => this.emit('error', e));

    const hello = encodeHello({
      peerId: this.cfg.peerId,
      nickname: this.cfg.nickname,
      ephPub: this.ephemeral.publicKey,
      idPub: sha256(this.cfg.peerId), // 稳定派生，用于 pairwise salt
      capabilities: this.cfg.capabilities ?? ['chat', 'file', 'poll', 'game'],
      roomId: this.cfg.roomId,
    });
    t.send(encodeFrame(FrameType.Hello, hello));
    this.emit('connecting');
  }

  private onFrame(h: { type: number; flags: number; corr: number }, payload: Buffer): void {
    switch (h.type) {
      case FrameType.Welcome: {
        const w = decodeWelcome(payload);
        // 用 hub 下发的 salt 派生房间密钥（口令永远不出本机）
        const dk = deriveRoomKey(this.cfg.passphrase, w.salt, w.iterations);
        this.roomKey = dk.key;
        this.members = w.members.map((m) => ({ id: m.id, nick: m.nick }));
        this.emit('ready', { members: this.members, serverTime: w.serverTime });
        // 把我方的临时公钥广播给房间，供他人发起私聊
        this.announceKey();
        break;
      }

      case FrameType.Envelope: {
        this.handleEnvelope(payload);
        break;
      }

      case FrameType.Chunk: {
        const part = decodeChunk(payload);
        const full = this.chunks.add(part.corr, part.seq, part.data, (h.flags & Flag.ChunkLast) !== 0);
        this.chunks.sweep();
        if (full) this.handleEnvelope(full);
        break;
      }

      case FrameType.Ping: {
        this.transport?.send(encodeFrame(FrameType.Pong, Buffer.alloc(0), h.corr));
        break;
      }

      case FrameType.Bye: {
        this.emit('bye', payload.toString('utf8'));
        this.close();
        break;
      }

      case FrameType.Error: {
        this.emit('error', new Error(`hub error: ${payload.toString('utf8')}`));
        break;
      }

      default:
        break;
    }
  }

  private handleEnvelope(payload: Buffer): void {
    // presence 等控制帧是 hub 产生的明文 JSON（'{'->
    if (payload.length > 0 && payload[0] === 0x7b) {
      try {
        const obj = JSON.parse(payload.toString('utf8')) as AppMessage & { reannounce?: boolean };
        if (obj.t === 'presence') {
          this.members = obj.peers;
          this.emit('presence', obj.peers);
          if (obj.reannounce) this.announceKey();
          return;
        }
      } catch {
        /* 不是 JSON，按密文处理 */
      }
    }
    if (!this.roomKey) return;
    let plain: Buffer;
    try {
      const sealed = unpackSealed(payload);
      plain = open(this.roomKey, sealed, this.cfg.roomId);
    } catch {
      // 密钥不匹配（口令错误）或数据被篡改：静默丢弃并上报
      this.emit('decrypt-failed');
      return;
    }

    // 房间层解封后，可能是特殊信封：
    //   0x01 = 私聊：1 + 32 字节发送方临时公钥 + 明文发送方 id + pairwise 密文
    //   0x02 = 公钥公告：1 + 32 字节 X25519 公钥（由 presence 关联到具体 peer）
    if (plain.length > 33 && plain[0] === 1) {
      const peerPub = Buffer.from(plain.subarray(1, 33));
      const rest = Buffer.from(plain.subarray(33));
      const sep = rest.indexOf(0);
      if (sep > 0) {
        const fromId = rest.subarray(0, sep).toString('utf8');
        const cipher = Buffer.from(rest.subarray(sep + 1));
        const key = derivePairwiseKey(this.ephemeral.privateKey, peerPub, this.cfg.peerId, fromId);
        this.pairwise.set(fromId, key);
        try {
          const inner = open(key, unpackSealed(cipher));
          const msg = JSON.parse(inner.toString('utf8')) as AppMessage;
          this.emit('message', msg);
          this.emit('dm', msg);
        } catch {
          this.emit('decrypt-failed');
        }
      }
      return;
    }
    if (plain.length > 34 && plain[0] === 2) {
      const idLen = plain[1]!;
      if (plain.length >= 2 + idLen + 32) {
        const peerId = plain.subarray(2, 2 + idLen).toString('utf8');
        const peerPub = Buffer.from(plain.subarray(2 + idLen, 2 + idLen + 32));
        if (peerId !== this.cfg.peerId) {
          this.peerEphPub.set(peerId, peerPub);
          this.emit('key-announce', { peerId, pub: peerPub });
        }
      }
      return;
    }

    let msg: AppMessage;
    try {
      msg = JSON.parse(plain.toString('utf8')) as AppMessage;
    } catch {
      return;
    }
    this.emit('message', msg);
  }

  /**
   * 把自己的临时公钥广播出去，让其他人能发起私聊。
   * 信封格式（房间密钥保护内）：0x02 + id 长度 + id + 32 字节公钥。
   * 公钥本身不是秘密，但放在房间密钥里可以避免房间外的人嗅探「谁在线」。
   */
  private announceKey(): void {
    if (!this.roomKey || !this.transport?.connected) return;
    const id = Buffer.from(this.cfg.peerId, 'utf8');
    // 0x02 + 1 字节 id 长度 + id + 32 字节公钥
    const body = Buffer.concat([
      Buffer.from([2]),
      Buffer.from([id.length]),
      id,
      this.ephemeral.publicKey,
    ]);
    this.writeEnvelope(body, 0);
  }

  /** 广播一条应用消息（群聊/文件/投票/游戏） */
  send(msg: AppMessage): void {
    if (!this.roomKey || !this.transport?.connected) return;
    const plain = Buffer.from(JSON.stringify(msg), 'utf8');
    this.writeEnvelope(plain, msg.t === 'game' || msg.t === 'poll-vote' ? Flag.Priority : 0);
  }

  /**
   * 发出一个信封：用房间密钥封装后发送。
   * 这里统一做加密，保证**所有**出网卡的载荷都是密文——
   * 包括公钥公告与私聊外层，不给流量分析留明文元数据。
   */
  private writeEnvelope(body: Buffer, flags = 0): void {
    if (!this.roomKey || !this.transport?.connected) return;
    const sealed = seal(this.roomKey, body, this.cfg.roomId);
    const wire = packSealed(sealed);
    const corr = this.corrSeq++;
    const mtu = this.transport.info.mtu ?? DEFAULT_CHUNK;
    if (wire.length + 32 <= mtu) {
      this.transport.send(encodeFrame(FrameType.Envelope, wire, corr, flags));
      return;
    }
    // 超过 MTU（蓝牙常见）：走分片
    for (const c of chunkPayload(wire, corr, Math.max(512, mtu - 64))) {
      this.transport.send(c);
    }
  }

  /**
   * 私聊：与指定 peer 做 ECDH 后加密，hub 完全看不到内容。
   *
   * 双层封装：
   *   内层 = pairwise 密钥（只有收发双方能解）
   *   外层 = 房间密钥（隐藏元数据：谁在跟谁私聊）
   * 外层里附带我方临时公钥，因此对端无需预先交换即可解密。
   */
  sendDm(toId: string, text: string): void {
    if (!this.roomKey || !this.transport?.connected) return;
    const pub = this.peerEphPub.get(toId) ?? this.ephemeral.publicKey;
    const key = derivePairwiseKey(this.ephemeral.privateKey, pub, this.cfg.peerId, toId);
    this.pairwise.set(toId, key);

    const inner = Buffer.from(
      JSON.stringify({
        t: 'dm',
        id: `dm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        from: this.cfg.peerId,
        to: toId,
        nick: this.cfg.nickname,
        text,
        ts: Date.now(),
      }),
      'utf8',
    );
    const sealed = seal(key, inner);
    // 0x01 + 我方临时公钥 + 我方 id + 0 分隔 + 密文
    const body = Buffer.concat([
      Buffer.from([1]),
      this.ephemeral.publicKey,
      Buffer.from(this.cfg.peerId, 'utf8'),
      Buffer.from([0]),
      packSealed(sealed),
    ]);
    this.writeEnvelope(body, Flag.Priority);
  }

  /** 记录某 peer 的临时公钥（来自 key-announce，由上层按 presence 顺序关联） */
  rememberPeerKey(peerId: string, pub: Buffer): void {
    this.peerEphPub.set(peerId, Buffer.from(pub));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      if (this.transport?.connected) {
        this.transport.send(encodeFrame(FrameType.Bye, Buffer.from('client leaving', 'utf8')));
        this.transport.close();
      }
    } catch {
      /* ignore */
    }
    this.transport = null;
    this.roomKey = null;
  }
}

export const peer = { Peer };
export default peer;
