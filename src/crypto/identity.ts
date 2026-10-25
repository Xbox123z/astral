/**
 * 身份与端到端加密。
 *
 * 密码学选型（全部 Node 内置 webcrypto / crypto，无第三方依赖）：
 *  - 身份：Ed25519 长期签名密钥。公钥即 peer id。
 *  - 握手：X25519 临时密钥对 + HKDF-SHA256 派生会话密钥。
 *  - 群聊：房间口令 -> Argon2id 不可用（Node 无内置），改用 PBKDF2-SHA256
 *          高轮数 (310k) 派生 32 字节房间密钥，AES-256-GCM 封包。
 *  - 私聊：X25519 双方 ECDH -> HKDF(含双方公钥作为 salt) -> AES-256-GCM。
 *  - 前向安全：每次会话使用临时 X25519 密钥，会话结束即弃。
 *  - 指纹：公钥 SHA-256 前 20 字节 -> base32 -> 可视化 randomart。
 */

import {
  createHash,
  createHmac,
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  randomBytes,
  pbkdf2Sync,
  timingSafeEqual,
  generateKeyPairSync,
  publicEncrypt,
  privateDecrypt,
  sign as cryptoSign,
  verify as cryptoVerify,
  constants,
  type KeyObject,
} from 'node:crypto';
import { Buffer } from 'node:buffer';

export const AES_KEY_LEN = 32;
export const IV_LEN = 12; // GCM 标准 nonce
export const TAG_LEN = 16;

/* ------------------------------------------------------------------ */
/* 编码                                                                */
/* ------------------------------------------------------------------ */

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function base32(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += CROCKFORD[(value << (5 - bits)) & 31];
  return out;
}

export function hex(buf: Buffer | string): string {
  return Buffer.isBuffer(buf) ? buf.toString('hex') : Buffer.from(buf, 'utf8').toString('hex');
}

export function sha256(...parts: (Buffer | string)[]): Buffer {
  const h = createHash('sha256');
  for (const p of parts) h.update(typeof p === 'string' ? Buffer.from(p, 'utf8') : p);
  return h.digest();
}

export function hkdf(ikm: Buffer, salt: Buffer, info: string, len = 32): Buffer {
  // HKDF-SHA256 (RFC 5869)：extract 用 HMAC(salt, ikm)
  const prk = createHmac('sha256', salt.length ? salt : Buffer.alloc(32, 0)).update(ikm).digest();
  const out: Buffer[] = [];
  let t = Buffer.alloc(0);
  let counter = 1;
  let produced = 0;
  while (produced < len) {
    const input = Buffer.concat([t, Buffer.from(info, 'utf8'), Buffer.from([counter])]);
    t = createHmac('sha256', prk).update(input).digest();
    out.push(t);
    produced += t.length;
    counter++;
  }
  return Buffer.concat(out).subarray(0, len);
}

/* ------------------------------------------------------------------ */
/* 身份                                                                */
/* ------------------------------------------------------------------ */

export interface Identity {
  /** 稳定的短 id（base32，前 16 字符） */
  id: string;
  /** 完整指纹（base32 分组） */
  fingerprint: string;
  /** Ed25519 公钥 raw 32 字节（X25519 由它 deterministically 派生会话密钥用） */
  publicKey: Buffer;
  privateKey: Buffer;
  /** randomart 可视化 */
  art: string;
}

export interface IdentityKeypair extends Identity {
  publicKey: Buffer;
  privateKey: Buffer;
}

/** 生成身份（Ed25519） */
export function generateIdentity(): IdentityKeypair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });
  return buildIdentity(publicKey, privateKey);
}

export function buildIdentity(pubDer: Buffer, privDer: Buffer): IdentityKeypair {
  // 从 SPKI DER 末尾取 raw 32 字节公钥
  const raw = Buffer.from(pubDer.subarray(pubDer.length - 32));
  const fp = sha256(raw);
  const id = base32(fp).slice(0, 16).toLowerCase();
  return {
    id,
    fingerprint: formatFingerprint(base32(fp)),
    publicKey: raw,
    privateKey: privDer,
    art: randomart(fp),
  };
}

export function formatFingerprint(b32: string): string {
  const s = b32.slice(0, 40);
  return (s.match(/.{1,5}/g) ?? []).join('-');
}

/* ------------------------------------------------------------------ */
/* randomart（OpenSSH 风格的可视化指纹）                                 */
/* ------------------------------------------------------------------ */

const ART_CHARS = ' .o+=*BOX@%&#/^';

/**
 * 在 17x9 网格上「醉汉漫步」：每字节 2 bits 决定方向，
 * 走过的格子计数映射到字符密度。同一指纹永远得到同一张图。
 */
export function randomart(digest: Buffer, w = 17, h = 9): string {
  const grid = new Array(w * h).fill(0);
  let x = Math.floor(w / 2);
  let y = Math.floor(h / 2);
  for (const byte of digest) {
    for (let b = 0; b < 4; b++) {
      const dx = byte & 1 ? 1 : -1;
      const dy = (byte >> 1) & 1 ? 1 : -1;
      if ((byte >> 2) & 1) x += dx;
      else y += dy;
      x = Math.max(0, Math.min(w - 1, x));
      y = Math.max(0, Math.min(h - 1, y));
      grid[y * w + x] = (grid[y * w + x] ?? 0) + 1;
    }
  }
  // 起点/终点标记
  const sx = Math.floor(w / 2);
  const sy = Math.floor(h / 2);
  grid[sy * w + sx] = 15;
  grid[y * w + x] = 16;

  const lines: string[] = ['+' + '-'.repeat(w) + '+'];
  for (let r = 0; r < h; r++) {
    let line = '|';
    for (let c = 0; c < w; c++) {
      const v = grid[r * w + c] ?? 0;
      line += ART_CHARS[Math.min(ART_CHARS.length - 1, v)] ?? ' ';
    }
    lines.push(line + '|');
  }
  lines.push('+' + '-'.repeat(w) + '+');
  return lines.join('\n');
}

/** 带边框与指纹标注的完整身份卡 */
export function identityCard(id: Identity, label = 'ASTRA-ID'): string {
  const artLines = id.art.split('\n');
  const pad = ' '.repeat(Math.max(0, 6));
  return [
    '',
    `${label}  ${id.fingerprint}`,
    '',
    ...artLines.map((l) => pad + l),
    '',
    `${pad}peer: ${id.id}`,
    '',
  ].join('\n');
}

/* ------------------------------------------------------------------ */
/* 对称加密：AES-256-GCM                                               */
/* ------------------------------------------------------------------ */

export interface Sealed {
  iv: Buffer;
  ct: Buffer;
  tag: Buffer;
}

/** AAD 用于绑定上下文（房间 id / 消息类型），防止跨房间重放 */
export function seal(key: Buffer, plaintext: Buffer | string, aad?: Buffer | string): Sealed {
  if (key.length !== AES_KEY_LEN) throw new Error(`key must be ${AES_KEY_LEN} bytes`);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  if (aad !== undefined) cipher.setAAD(Buffer.isBuffer(aad) ? aad : Buffer.from(aad, 'utf8'));
  const pt = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext;
  const ct = Buffer.concat([cipher.update(pt), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { iv, ct, tag };
}

/** 拆封；认证失败抛异常（绝不返回未验证的数据） */
export function open(key: Buffer, s: Sealed, aad?: Buffer | string): Buffer {
  if (key.length !== AES_KEY_LEN) throw new Error(`key must be ${AES_KEY_LEN} bytes`);
  const decipher = createDecipheriv('aes-256-gcm', key, s.iv);
  if (aad !== undefined) decipher.setAAD(Buffer.isBuffer(aad) ? aad : Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(s.tag);
  return Buffer.concat([decipher.update(s.ct), decipher.final()]);
}

/** 序列化成一段二进制（iv|tag|ct）便于线上传输 */
export function packSealed(s: Sealed): Buffer {
  return Buffer.concat([s.iv, s.tag, s.ct]);
}

export function unpackSealed(b: Buffer): Sealed {
  if (b.length < IV_LEN + TAG_LEN) throw new Error('sealed blob too short');
  return {
    iv: b.subarray(0, IV_LEN),
    tag: b.subarray(IV_LEN, IV_LEN + TAG_LEN),
    ct: b.subarray(IV_LEN + TAG_LEN),
  };
}

/* ------------------------------------------------------------------ */
/* 口令派生（房间密钥）                                                  */
/* ------------------------------------------------------------------ */

export const PBKDF2_ITERATIONS = 310_000;

export interface DerivedKey {
  key: Buffer;
  salt: Buffer;
  iterations: number;
}

/** 房间口令 -> 房间密钥。salt 公开随房间公告广播，可离线暴力但成本高。 */
export function deriveRoomKey(passphrase: string, salt?: Buffer, iterations = PBKDF2_ITERATIONS): DerivedKey {
  const s = salt ?? randomBytes(16);
  const key = pbkdf2Sync(passphrase, s, iterations, AES_KEY_LEN, 'sha256');
  return { key, salt: s, iterations };
}

/** 房间 id：由房间名+口令派生，不知道口令的人即使看到 id 也进不来 */
export function roomIdFrom(name: string, passphrase: string): string {
  return base32(sha256('astral-room', name, passphrase)).slice(0, 12).toLowerCase();
}

/** 邀请码：房间名 + 口令 + 可选 hub 地址，base32 紧凑编码 */
export function makeInvite(room: string, passphrase: string, hub?: string): string {
  const payload = JSON.stringify({ r: room, p: passphrase, h: hub ?? null });
  return 'ASTRAL1:' + Buffer.from(payload, 'utf8').toString('base64url');
}

export function parseInvite(code: string): { room: string; passphrase: string; hub?: string } {
  const m = /^ASTRAL1:(.+)$/.exec(code.trim());
  if (!m) throw new Error('invalid invite code');
  const obj = JSON.parse(Buffer.from(m[1]!, 'base64url').toString('utf8')) as {
    r: string;
    p: string;
    h?: string | null;
  };
  return { room: obj.r, passphrase: obj.p, hub: obj.h ?? undefined };
}

/* ------------------------------------------------------------------ */
/* 会话密钥协商（X25519 临时密钥）                                       */
/* ------------------------------------------------------------------ */

export interface EphemeralKeypair {
  publicKey: Buffer;
  privateKey: Buffer;
}

/** 生成临时 X25519 密钥对（DER 形式，取 raw 32 字节） */
export function ephemeralKeyPair(): EphemeralKeypair {
  const { publicKey, privateKey } = generateKeyPairSync('x25519', {
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });
  return { publicKey: publicKey.subarray(publicKey.length - 32), privateKey };
}

/**
 * raw 32 字节公钥 -> SPKI DER。
 *
 * 手写 DER 前缀极易算错（Ed25519 与 X25519 的 OID 与 BIT STRING 长度都不同），
 * 因此这里在运行时各生成一对临时密钥，从真实 SPKI DER 里切出前缀。
 * 这样前缀永远与当前 Node/OpenSSL 的实际编码一致。
 */
const spkiPrefixCache = new Map<'ed25519' | 'x25519', Buffer>();

function spkiPrefix(alg: 'ed25519' | 'x25519'): Buffer {
  const hit = spkiPrefixCache.get(alg);
  if (hit) return hit;
  const { publicKey } = generateKeyPairSync(alg as 'ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });
  const der = Buffer.from(publicKey);
  const prefix = Buffer.from(der.subarray(0, der.length - 32));
  spkiPrefixCache.set(alg, prefix);
  return prefix;
}

export function rawPublicToSpki(raw: Buffer, alg: 'ed25519' | 'x25519' = 'ed25519'): Buffer {
  return Buffer.concat([spkiPrefix(alg), raw]);
}

/** SPKI DER -> raw 32 字节公钥 */
export function spkiToRaw(der: Buffer): Buffer {
  return Buffer.from(der.subarray(der.length - 32));
}

function privKeyObject(der: Buffer): KeyObject {
  return createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
}

function pubKeyObject(rawOrDer: Buffer, alg: 'ed25519' | 'x25519' = 'ed25519'): KeyObject {
  const der = rawOrDer.length === 32 ? rawPublicToSpki(rawOrDer, alg) : rawOrDer;
  return createPublicKey({ key: der, format: 'der', type: 'spki' });
}

/** 用 Node 的 diffieHellman 做 X25519 ECDH */
export function x25519SharedSecret(privDer: Buffer, peerPubRaw: Buffer): Buffer {
  return diffieHellman({
    privateKey: privKeyObject(privDer),
    publicKey: pubKeyObject(peerPubRaw, 'x25519'),
  });
}

/**
 * 私聊会话密钥：ECDH 共享密钥 + 双方公钥排序后作 salt，
 * 保证 A->B 与 B->A 得到同一把钥匙，且绑定到具体两个身份。
 */
export function derivePairwiseKey(
  myEphemeralPrivDer: Buffer,
  peerEphemeralPubRaw: Buffer,
  idA: string,
  idB: string,
): Buffer {
  const shared = x25519SharedSecret(myEphemeralPrivDer, peerEphemeralPubRaw);
  const [a, b] = idA < idB ? [idA, idB] : [idB, idA];
  return hkdf(shared, sha256(a, b), 'astral-pairwise-v1', AES_KEY_LEN);
}

/** 群聊消息密钥：房间密钥 + 消息计数 epoch，用于滚动密钥（可选前向安全） */
export function deriveEpochKey(roomKey: Buffer, epoch: number): Buffer {
  return hkdf(roomKey, Buffer.alloc(0), `astral-epoch-${epoch}`, AES_KEY_LEN);
}

/* ------------------------------------------------------------------ */
/* 签名（Ed25519）                                                      */
/* ------------------------------------------------------------------ */

export function sign(privDer: Buffer, data: Buffer): Buffer {
  return cryptoSign(null, data, privKeyObject(privDer));
}

export function verify(pubRaw: Buffer, data: Buffer, sig: Buffer): boolean {
  try {
    return cryptoVerify(null, data, pubKeyObject(pubRaw), sig);
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* 杂项                                                                */
/* ------------------------------------------------------------------ */

export function safeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function randomToken(n = 16): string {
  return randomBytes(n).toString('base64url');
}

/** 简单的人类可读校验短语（用于配对确认，防 MITM） */
export function pairingPhrase(a: string, b: string): string {
  const WORDS = [
    'nebula', 'orbit', 'quasar', 'pulsar', 'eclipse', 'comet', 'meteor', 'aurora',
    'cosmos', 'stellar', 'lunar', 'solar', 'void', 'gravity', 'photon', 'horizon',
  ];
  const d = sha256(a, b);
  return [0, 1, 2].map((i) => WORDS[d[i]! % WORDS.length]!).join('-');
}

/** RSA 封装：向已知公钥发送房间密钥（用于邀请新成员，可选） */
export function wrapKeyFor(recipientPublicKeyDer: Buffer, key: Buffer): Buffer {
  return publicEncrypt(
    { key: recipientPublicKeyDer, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    key,
  );
}

export function unwrapKey(privateKeyDer: Buffer, blob: Buffer): Buffer {
  return privateDecrypt(
    { key: privateKeyDer, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    blob,
  );
}

export const crypto_ = {
  base32,
  hex,
  sha256,
  hkdf,
  generateIdentity,
  randomart,
  identityCard,
  seal,
  open,
  packSealed,
  unpackSealed,
  deriveRoomKey,
  roomIdFrom,
  makeInvite,
  parseInvite,
  ephemeralKeyPair,
  derivePairwiseKey,
  deriveEpochKey,
  sign,
  verify,
  safeEqual,
  randomToken,
  pairingPhrase,
};

export default crypto_;
