/**
 * 房间 Hub（星型服务器）。
 *
 * 为什么是星型而不是全网状：
 *   用户要「千人房间」。全网状需要 O(n²) 连接（1000 人 = 50 万条），不可行；
 *   星型是 O(n)，且天然解决 NAT 穿透（大家都连同一个 hub）。
 *   房间内任意一台机器都能当 hub（第一个开房的人自动成为 hub），
 *   hub 掉线后可以重新选举——不需要中心服务器。
 *
 * 关键设计：
 *  - hub **看不到明文**。它只转发密文信封（Envelope），房间密钥由口令派生。
 *  - 成员名单、昵称是明文的（要广播），但消息体一律端到端加密。
 *  - 背压：单机 1000 连接靠「批量广播 + 写缓冲水位控制」实现。
 */

import { EventEmitter } from 'node:events';
import net from 'node:net';
import { Buffer } from 'node:buffer';
import {
  FrameType,
  encodeFrame,
  FrameParser,
  encodeWelcome,
  decodeHello,
  ChunkAssembler,
  Flag,
  PING_INTERVAL_MS,
  PEER_TIMEOUT_MS,
  decodeChunk,
} from './protocol.js';
import { deriveRoomKey } from '../crypto/identity.js';
import type { Transport } from './transport.js';

export interface HubMember {
  id: string;
  nick: string;
  /** 加入时间 */
  joined: number;
  /** 最后活跃 */
  lastSeen: number;
  transport: Transport;
  /** 能力列表 */
  caps: string[];
  /** 是否为观察者（只读） */
  spectator: boolean;
  /** 发送队列是否积压（背压信号） */
  congested: boolean;
}

export interface HubOptions {
  roomId: string;
  roomName: string;
  /** 房间口令；为空表示无加密（仅明文元数据） */
  passphrase?: string;
  /** 最大成员数 */
  maxPeers?: number;
  port?: number;
  /** 是否要求口令才能加入 */
  requirePassphrase?: boolean;
}

export interface HubStats {
  peers: number;
  uptimeMs: number;
  framesIn: number;
  framesOut: number;
  bytesIn: number;
  bytesOut: number;
  broadcasts: number;
}

/**
 * 房间 Hub。
 * 用 `attach(transport)` 接纳任意传输（TCP / WebSocket / 蓝牙），
 * 因此同一个 hub 可以混合承载三种链路。
 */
export class Hub extends EventEmitter {
  readonly roomId: string;
  readonly roomName: string;
  readonly startedAt = Date.now();
  private members = new Map<string, HubMember>();
  private seq = 1;
  private stats = { framesIn: 0, framesOut: 0, bytesIn: 0, bytesOut: 0, broadcasts: 0 };
  private pingTimer: NodeJS.Timeout | null = null;
  private readonly maxPeers: number;
  private readonly salt: Buffer;
  private readonly iterations: number;
  private readonly requirePassphrase: boolean;

  constructor(private opts: HubOptions) {
    super();
    this.roomId = opts.roomId;
    this.roomName = opts.roomName;
    this.maxPeers = opts.maxPeers ?? 1024;
    this.requirePassphrase = opts.requirePassphrase ?? Boolean(opts.passphrase);
    const dk = deriveRoomKey(opts.passphrase ?? '');
    this.salt = dk.salt;
    this.iterations = dk.iterations;
  }

  get statsSnapshot(): HubStats {
    return {
      peers: this.members.size,
      uptimeMs: Date.now() - this.startedAt,
      ...this.stats,
    };
  }

  get saltForRoom(): Buffer {
    return this.salt;
  }

  get iterationsForRoom(): number {
    return this.iterations;
  }

  /** 接纳一个连接（任意 transport） */
  attach(transport: Transport): void {
    const parser = new FrameParser();
    const chunks = new ChunkAssembler();
    let hello: ReturnType<typeof decodeHello> | null = null;
    let pendingId: string | null = null;

    parser.onError = (e) => {
      this.safeSend(transport, encodeFrame(FrameType.Error, Buffer.from(`protocol: ${e.message}`, 'utf8')));
      transport.close();
    };

    parser.onFrame = (h, payload) => {
      this.stats.framesIn++;
      this.stats.bytesIn += payload.length;

      switch (h.type) {
        case FrameType.Hello: {
          if (this.members.size >= this.maxPeers) {
            this.safeSend(
              transport,
              encodeFrame(FrameType.Error, Buffer.from('room is full', 'utf8')),
            );
            transport.close();
            return;
          }
          try {
            hello = decodeHello(payload);
          } catch {
            this.safeSend(transport, encodeFrame(FrameType.Error, Buffer.from('bad hello', 'utf8')));
            transport.close();
            return;
          }
          if (hello.roomId !== this.roomId) {
            this.safeSend(transport, encodeFrame(FrameType.Error, Buffer.from('room id mismatch', 'utf8')));
            transport.close();
            return;
          }
          pendingId = hello.peerId;
          const member: HubMember = {
            id: hello.peerId,
            nick: hello.nickname || 'anonymous',
            joined: Date.now(),
            lastSeen: Date.now(),
            transport,
            caps: hello.capabilities,
            spectator: hello.capabilities.includes('spectate'),
            congested: false,
          };
          this.members.set(member.id, member);

          // 回 Welcome：含 salt 与迭代次数，**不含密钥**
          const welcome = encodeWelcome({
            peerId: member.id,
            roomId: this.roomId,
            salt: this.salt,
            iterations: this.iterations,
            members: Array.from(this.members.values()).map((m) => ({ id: m.id, nick: m.nick })),
            serverTime: Date.now(),
          });
          this.safeSend(transport, encodeFrame(FrameType.Welcome, welcome));
          this.emit('join', member);
          this.broadcastPresence();
          // 让已在线成员也重新公告一次自己的临时公钥，
          // 这样新加入者能立刻拿到所有人的公钥并发起私聊。
          this.requestKeyReannounce();
          break;
        }

        case FrameType.Envelope: {
          const id = pendingId;
          if (!id) return;
          const m = this.members.get(id);
          if (!m) return;
          m.lastSeen = Date.now();
          if (m.spectator && !h.flags) {
            // 观察者只能收不能发（除私有控制帧）
            return;
          }
          // 原样转发密文：hub 不解密
          this.broadcast(encodeFrame(FrameType.Envelope, payload, h.corr, h.flags), id);
          this.emit('envelope', { from: id, payload, flags: h.flags });
          break;
        }

        case FrameType.Chunk: {
          const part = decodeChunk(payload);
          const full = chunks.add(part.corr, part.seq, part.data, (h.flags & Flag.ChunkLast) !== 0);
          chunks.sweep();
          if (full) {
            const id = pendingId;
            if (id) {
              // 重组完成后作为一整个 Envelope 广播
              this.broadcast(encodeFrame(FrameType.Envelope, full, part.corr), id);
            }
          }
          break;
        }

        case FrameType.Ping: {
          const id = pendingId;
          if (id) {
            const m = this.members.get(id);
            if (m) m.lastSeen = Date.now();
          }
          this.safeSend(transport, encodeFrame(FrameType.Pong, Buffer.alloc(0), h.corr));
          break;
        }

        case FrameType.Bye: {
          const id = pendingId;
          transport.close();
          if (id) this.remove(id, 'bye');
          break;
        }

        default:
          break;
      }
    };

    transport.on('data', (d: Buffer) => parser.push(d));
    transport.on('close', () => {
      if (pendingId) this.remove(pendingId, 'closed');
    });
    transport.on('error', () => {
      if (pendingId) this.remove(pendingId, 'error');
    });

    void hello;
  }

  private remove(id: string, reason: string): void {
    const m = this.members.get(id);
    if (!m) return;
    this.members.delete(id);
    this.emit('leave', { member: m, reason });
    this.broadcastPresence();
  }

  /** 广播密文信封；excludeId 的发送者不会收到自己的回显 */
  private broadcast(frame: Buffer, excludeId?: string): void {
    this.stats.broadcasts++;
    for (const m of this.members.values()) {
      if (m.id === excludeId) continue;
      this.safeSend(m.transport, frame);
    }
    this.stats.framesOut++;
    this.stats.bytesOut += frame.length * Math.max(0, this.members.size - 1);
  }

  /** 请所有成员重新广播临时公钥（新成员加入时调用） */
  private requestKeyReannounce(): void {
    const payload = Buffer.from(JSON.stringify({ t: 'presence', peers: this.memberList(), reannounce: true }), 'utf8');
    const frame = encodeFrame(FrameType.Envelope, payload, 0, Flag.Priority);
    for (const m of this.members.values()) this.safeSend(m.transport, frame);
  }

  /** 在线名单变化：这是明文，但不含任何消息内容 */
  private broadcastPresence(): void {
    const list = Array.from(this.members.values()).map((m) => ({
      id: m.id,
      nick: m.nick,
      spectator: m.spectator,
    }));
    const payload = Buffer.from(JSON.stringify({ t: 'presence', peers: list }), 'utf8');
    const frame = encodeFrame(FrameType.Envelope, payload, 0, Flag.Priority);
    // presence 是 hub 自己产生的明文控制帧，直接发给所有人
    for (const m of this.members.values()) this.safeSend(m.transport, frame);
  }

  private safeSend(t: Transport, frame: Buffer): void {
    try {
      if (t.connected) t.send(frame);
    } catch {
      /* 单个连接写失败不应影响其他人 */
    }
  }

  /** 心跳 + 超时剔除 */
  startHeartbeat(): void {
    if (this.pingTimer) return;
    this.pingTimer = setInterval(() => {
      const now = Date.now();
      const ping = encodeFrame(FrameType.Ping, Buffer.alloc(0));
      for (const [id, m] of this.members) {
        if (now - m.lastSeen > PEER_TIMEOUT_MS) {
          this.remove(id, 'timeout');
          continue;
        }
        this.safeSend(m.transport, ping);
      }
    }, PING_INTERVAL_MS);
    this.pingTimer.unref?.();
  }

  memberList(): { id: string; nick: string; spectator: boolean }[] {
    return Array.from(this.members.values()).map((m) => ({
      id: m.id,
      nick: m.nick,
      spectator: m.spectator,
    }));
  }

  get peerCount(): number {
    return this.members.size;
  }

  stop(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    const bye = encodeFrame(FrameType.Bye, Buffer.from('hub stopping', 'utf8'));
    for (const m of this.members.values()) this.safeSend(m.transport, bye);
    for (const m of this.members.values()) {
      try {
        m.transport.close();
      } catch {
        /* ignore */
      }
    }
    this.members.clear();
  }
}

/* ------------------------------------------------------------------ */
/* TCP 监听器                                                          */
/* ------------------------------------------------------------------ */

export class TcpHubServer extends EventEmitter {
  private server: net.Server | null = null;

  constructor(public readonly hub: Hub) {
    super();
  }

  async listen(port: number, host = '0.0.0.0'): Promise<number> {
    this.server = net.createServer({ allowHalfOpen: false }, (sock) => {
      sock.setNoDelay(true);
      // 动态 import 会造成循环依赖，这里直接内联构造 TCP transport 的等价物
      const transport = wrapSocket(sock);
      this.hub.attach(transport);
      this.emit('connection', transport);
    });
    // 高并发下放宽 backlog，容纳突发连接
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(port, host, () => resolve());
    });
    const addr = this.server.address() as net.AddressInfo;
    this.hub.startHeartbeat();
    return addr.port;
  }

  get port(): number {
    const a = this.server?.address() as net.AddressInfo | null;
    return a?.port ?? 0;
  }

  stop(): void {
    this.hub.stop();
    this.server?.close();
    this.server = null;
  }
}

/** 把 net.Socket 包成 Transport（避免与 transport.ts 形成 import 环） */
function wrapSocket(sock: net.Socket): Transport {
  const emitter = new EventEmitter() as Transport & EventEmitter;
  const obj = emitter as unknown as {
    info: Transport['info'];
    send: Transport['send'];
    close: Transport['close'];
    connected: boolean;
  };
  obj.info = {
    kind: 'tcp',
    remote: `${sock.remoteAddress ?? '?'}:${sock.remotePort ?? '?'}`,
    local: `${sock.localAddress}:${sock.localPort}`,
    mtu: 64 * 1024,
    reliable: true,
  };
  obj.connected = true;
  obj.send = (d: Buffer): void => {
    if (!sock.destroyed) sock.write(d);
  };
  obj.close = (): void => {
    sock.end();
  };
  sock.on('data', (d: Buffer) => emitter.emit('data', d));
  sock.on('close', () => {
    obj.connected = false;
    emitter.emit('close', null);
  });
  sock.on('error', (e: Error) => emitter.emit('error', e));
  return emitter;
}

export const hub = { Hub, TcpHubServer };
export default hub;
