/**
 * 平台协议字节序：所有 ASTRAL 线上协议统一使用 **小端 (LE)**。
 *
 * 之所以不直接用默认的 BE：ASTRAL 的报头大多是 u32 长度 + u16 字段，
 * 在 Node 上用 LE 写入可以避免一次 `>>> 0` 的无符号修正，
 * 且三端（Windows / Linux / macOS）都由同一份实现序列化，不存在歧义。
 */
import { Buffer } from 'node:buffer';

export type Order = 'le' | 'be';

export interface Cursor {
  buf: Buffer;
  off: number;
}

export class Writer {
  private chunks: Buffer[] = [];
  private len = 0;

  get length(): number {
    return this.len;
  }

  raw(b: Buffer): this {
    this.chunks.push(b);
    this.len += b.length;
    return this;
  }

  u8(v: number): this {
    const b = Buffer.allocUnsafe(1);
    b.writeUInt8(v & 0xff, 0);
    return this.raw(b);
  }

  u16(v: number, o: Order = 'le'): this {
    const b = Buffer.allocUnsafe(2);
    if (o === 'le') b.writeUInt16LE(v & 0xffff, 0);
    else b.writeUInt16BE(v & 0xffff, 0);
    return this.raw(b);
  }

  u32(v: number, o: Order = 'le'): this {
    const b = Buffer.allocUnsafe(4);
    if (o === 'le') b.writeUInt32LE(v >>> 0, 0);
    else b.writeUInt32BE(v >>> 0, 0);
    return this.raw(b);
  }

  u64(v: bigint | number, o: Order = 'le'): this {
    const b = Buffer.allocUnsafe(8);
    const big = typeof v === 'bigint' ? v : BigInt(Math.floor(v));
    if (o === 'le') b.writeBigUInt64LE(big, 0);
    else b.writeBigUInt64BE(big, 0);
    return this.raw(b);
  }

  /** 长度前缀字节串：u16 长度 + payload */
  bytes(b: Buffer | Uint8Array): this {
    const v = Buffer.isBuffer(b) ? b : Buffer.from(b);
    this.u16(v.length, 'le');
    return this.raw(v);
  }

  /** 长度前缀 UTF-8 字符串 */
  str(s: string): this {
    return this.bytes(Buffer.from(s, 'utf8'));
  }

  /** 定长字节串（不写长度），用于签名、密钥、摘要 */
  fixed(b: Buffer | Uint8Array): this {
    return this.raw(Buffer.isBuffer(b) ? b : Buffer.from(b));
  }

  done(): Buffer {
    return Buffer.concat(this.chunks, this.len);
  }
}

export class Reader {
  public off = 0;

  constructor(public readonly buf: Buffer) {}

  get remaining(): number {
    return this.buf.length - this.off;
  }

  private need(n: number): void {
    if (this.remaining < n) {
      throw new RangeError(
        `reader underflow: need ${n} bytes, have ${this.remaining} at offset ${this.off}`,
      );
    }
  }

  raw(n: number): Buffer {
    this.need(n);
    const b = this.buf.subarray(this.off, this.off + n);
    this.off += n;
    return Buffer.from(b);
  }

  u8(): number {
    this.need(1);
    return this.buf.readUInt8((this.off += 1) - 1);
  }

  u16(o: Order = 'le'): number {
    this.need(2);
    const i = this.off;
    this.off += 2;
    return o === 'le' ? this.buf.readUInt16LE(i) : this.buf.readUInt16BE(i);
  }

  u32(o: Order = 'le'): number {
    this.need(4);
    const i = this.off;
    this.off += 4;
    return o === 'le' ? this.buf.readUInt32LE(i) : this.buf.readUInt32BE(i);
  }

  u64(o: Order = 'le'): bigint {
    this.need(8);
    const i = this.off;
    this.off += 8;
    return o === 'le' ? this.buf.readBigUInt64LE(i) : this.buf.readBigUInt64BE(i);
  }

  bytes(): Buffer {
    return this.raw(this.u16());
  }

  str(): string {
    return this.bytes().toString('utf8');
  }

  fixed(n: number): Buffer {
    return this.raw(n);
  }

  /** 读完后仍有多余字节通常是版本不兼容的信号 */
  end(): void {
    if (this.remaining !== 0) {
      throw new RangeError(`trailing ${this.remaining} bytes at offset ${this.off}`);
    }
  }
}

export const bo = { Writer, Reader };
export default bo;
