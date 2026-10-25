/**
 * 端到端加密文件传输。
 *
 * 流程：
 *   1. /send：计算 SHA-256，把文件切成块，逐块广播（每块独立 AES-GCM）
 *   2. 接收端按 (fileId, seq) 重组，全部到齐后校验哈希
 *   3. 哈希不符直接丢弃并告警 —— 传输层被篡改也不会写入磁盘
 *
 * 分片大小自适应：LAN 用 24KB，蓝牙 MTU 小则降到 512B。
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import os from 'node:os';
import { seal, open, packSealed, unpackSealed } from '../crypto/identity.js';
import type { Peer } from '../net/peer.js';

export const CHUNK_SIZE_LAN = 24 * 1024;
export const CHUNK_SIZE_BT = 512;
/** 单次传输上限（默认 64MB），防止内存被撑爆 */
export const MAX_FILE_SIZE = 64 * 1024 * 1024;

export interface FileOffer {
  id: string;
  from: string;
  fromNick: string;
  name: string;
  size: number;
  sha256: string;
  chunks: number;
  ts: number;
}

export interface IncomingFile {
  offer: FileOffer;
  received: Map<number, Buffer>;
  startedAt: number;
}

/** 对外暴露的进度回调 */
export interface TransferProgress {
  fileId: string;
  name: string;
  done: number;
  total: number;
  bytes: number;
  size: number;
}

export class FileTransfer {
  private incoming = new Map<string, IncomingFile>();
  private outgoing = new Map<string, { name: string; total: number; sent: number }>();
  private onProgress: ((p: TransferProgress) => void) | null = null;
  private onComplete: ((info: { name: string; path: string; sha256: string; from: string }) => void) | null = null;
  private onOffer: ((o: FileOffer) => void) | null = null;
  private onError: ((msg: string) => void) | null = null;
  /** 去重：已处理过的 offer id */
  private seen = new Set<string>();

  constructor(
    private peer: Peer,
    private downloadDir: string = path.join(os.homedir(), 'astral-downloads'),
  ) {}

  setHandlers(h: {
    onProgress?: (p: TransferProgress) => void;
    onComplete?: (info: { name: string; path: string; sha256: string; from: string }) => void;
    onOffer?: (o: FileOffer) => void;
    onError?: (msg: string) => void;
  }): void {
    if (h.onProgress) this.onProgress = h.onProgress;
    if (h.onComplete) this.onComplete = h.onComplete;
    if (h.onOffer) this.onOffer = h.onOffer;
    if (h.onError) this.onError = h.onError;
  }

  get pendingOffers(): FileOffer[] {
    return Array.from(this.incoming.values()).map((f) => f.offer);
  }

  /* ---------------- 发送 ---------------- */

  /** 发送文件；返回 offer（供本地显示进度） */
  async sendFile(filePath: string, chunkSize = CHUNK_SIZE_LAN): Promise<FileOffer> {
    const abs = path.resolve(filePath);
    const st = await fs.promises.stat(abs);
    if (!st.isFile()) throw new Error(`不是文件：${abs}`);
    if (st.size > MAX_FILE_SIZE) {
      throw new Error(`文件过大（${formatBytes(st.size)}），上限 ${formatBytes(MAX_FILE_SIZE)}`);
    }
    const data = await fs.promises.readFile(abs);
    const hash = createHash('sha256').update(data).digest('hex');
    const name = path.basename(abs);
    const fileId = hash.slice(0, 16);
    const total = Math.max(1, Math.ceil(data.length / chunkSize));

    const offer: FileOffer = {
      id: fileId,
      from: this.peer.id,
      fromNick: this.peer.nick,
      name,
      size: data.length,
      sha256: hash,
      chunks: total,
      ts: Date.now(),
    };
    this.outgoing.set(fileId, { name, total, sent: 0 });

    // 1) 广播 offer
    this.peer.send({
      t: 'file-offer',
      id: fileId,
      from: this.peer.id,
      nick: this.peer.nick,
      name,
      size: data.length,
      hash,
      ts: Date.now(),
    });

    // 2) 逐块发送（带小延时，避免刷爆小 MTU 链路）
    const roomKey = roomKeyOf(this.peer);
    for (let seq = 0; seq < total; seq++) {
      const slice = data.subarray(seq * chunkSize, Math.min((seq + 1) * chunkSize, data.length));
      const body = Buffer.concat([u32be(fileIdNum(fileId)), u32be(seq), u32be(total), slice]);
      const sealed = seal(roomKey, body, `file:${fileId}`);
      const b64 = packSealed(sealed).toString('base64');
      this.peer.send({
        t: 'file-chunk',
        id: `${fileId}:${seq}`,
        from: this.peer.id,
        name,
        seq,
        total,
        data: b64,
        ts: Date.now(),
      });
      const rec = this.outgoing.get(fileId)!;
      rec.sent = seq + 1;
      this.onProgress?.({ fileId, name, done: seq + 1, total, bytes: Math.min((seq + 1) * chunkSize, data.length), size: data.length });
      if (seq % 8 === 7) await sleep(1); // 让出事件循环，避免阻塞 UI
    }
    return offer;
  }

  /* ---------------- 接收 ---------------- */

  /** 处理收到的 offer 消息 */
  handleOffer(msg: { id: string; from: string; nick: string; name: string; size: number; hash: string; ts: number }): void {
    if (msg.from === this.peer.id) return; // 自己的回显
    if (this.seen.has(msg.id)) return;
    this.seen.add(msg.id);
    const offer: FileOffer = {
      id: msg.id,
      from: msg.from,
      fromNick: msg.nick,
      name: msg.name,
      size: msg.size,
      sha256: msg.hash,
      chunks: Math.max(1, Math.ceil(msg.size / CHUNK_SIZE_LAN)),
      ts: msg.ts,
    };
    this.incoming.set(msg.id, { offer, received: new Map(), startedAt: Date.now() });
    this.onOffer?.(offer);
  }

  /** 处理收到的分片 */
  handleChunk(msg: { id: string; from: string; name: string; seq: number; total: number; data: string; ts: number }): void {
    const fileId = msg.id.split(':')[0]!;
    if (msg.from === this.peer.id) return;
    const entry = this.incoming.get(fileId);
    if (!entry) return; // 没收到 offer，忽略
    if (entry.received.has(msg.seq)) return; // 重复块

    const roomKey = roomKeyOf(this.peer);
    let body: Buffer;
    try {
      body = open(roomKey, unpackSealed(Buffer.from(msg.data, 'base64')), `file:${fileId}`);
    } catch {
      this.onError?.(`文件分片校验失败：${entry.offer.name} #${msg.seq}（已丢弃）`);
      return;
    }
    // 校验 fileId 与 seq，防止串包
    if (body.readUInt32BE(0) !== fileIdNum(fileId) || body.readUInt32BE(4) !== msg.seq) {
      this.onError?.(`文件分片序号不符：${entry.offer.name} #${msg.seq}`);
      return;
    }
    entry.received.set(msg.seq, Buffer.from(body.subarray(12)));
    this.onProgress?.({
      fileId,
      name: entry.offer.name,
      done: entry.received.size,
      total: msg.total,
      bytes: entry.received.size * CHUNK_SIZE_LAN,
      size: entry.offer.size,
    });

    if (entry.received.size >= msg.total) void this.assemble(fileId);
  }

  /** 重组并校验哈希，写入下载目录 */
  private async assemble(fileId: string): Promise<void> {
    const entry = this.incoming.get(fileId);
    if (!entry) return;
    const total = entry.offer.chunks;
    const parts: Buffer[] = [];
    for (let i = 0; i < total; i++) {
      const p = entry.received.get(i);
      if (!p) {
        this.onError?.(`文件 ${entry.offer.name} 缺少第 ${i} 块，等待重传…`);
        return;
      }
      parts.push(p);
    }
    const data = Buffer.concat(parts);
    const hash = createHash('sha256').update(data).digest('hex');
    if (hash !== entry.offer.sha256) {
      this.incoming.delete(fileId);
      this.onError?.(`❌ 文件 ${entry.offer.name} 哈希不匹配，已丢弃（传输被篡改或损坏）`);
      return;
    }
    await fs.promises.mkdir(this.downloadDir, { recursive: true });
    const outPath = path.join(this.downloadDir, safeName(entry.offer.name));
    await fs.promises.writeFile(outPath, data);
    this.incoming.delete(fileId);
    this.onComplete?.({ name: entry.offer.name, path: outPath, sha256: hash, from: entry.offer.fromNick });
  }

  /** 主动放弃某个传入文件 */
  cancel(fileId: string): void {
    this.incoming.delete(fileId);
  }

  /** 清理超过 5 分钟未完成的传输 */
  sweep(maxAgeMs = 300_000): void {
    const now = Date.now();
    for (const [id, e] of this.incoming) {
      if (now - e.startedAt > maxAgeMs) this.incoming.delete(id);
    }
  }
}

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

/** 取 peer 的房间密钥（反射访问私有字段，避免为此改动 Peer 的公共 API） */
function roomKeyOf(peer: Peer): Buffer {
  const k = (peer as unknown as { roomKey: Buffer | null }).roomKey;
  if (!k) throw new Error('尚未加入房间，无法传输文件');
  return k;
}

function u32be(n: number): Buffer {
  const b = Buffer.allocUnsafe(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
}

function fileIdNum(fileId: string): number {
  return parseInt(fileId.slice(0, 8), 16) >>> 0;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/**
 * 把远端给的文件名变成安全的本地文件名。
 *
 * 两个坑：
 *  1. 路径穿越：必须只保留最后一段，且不能用 path.basename 直接吃下原始串 ——
 *     Windows 上 `a:b` 会被当成驱动器/流分隔符，basename 会把 `a:` 吃掉，
 *     结果 `a:b*c` 变成 `b_c`。所以先手动切分隔符再清洗。
 *  2. 非法字符：\\ / : * ? " < > | 在 Windows 上都不能出现在文件名里。
 */
export function safeName(name: string): string {
  // 手动取最后一段（避免 path.basename 的 Windows 驱动器歧义）
  const last = name.split(/[/\\]+/).filter(Boolean).pop() ?? '';
  const cleaned = last.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/^\.+/, '_').trim();
  return cleaned.slice(0, 180) || 'unnamed.bin';
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export const filetransfer = { FileTransfer, formatBytes, safeName, CHUNK_SIZE_LAN, CHUNK_SIZE_BT, MAX_FILE_SIZE };
export default filetransfer;
