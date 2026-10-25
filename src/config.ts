/**
 * 本地配置与身份持久化。
 *
 * 存放位置遵循各平台惯例：
 *  - Windows: %APPDATA%\astral\
 *  - macOS  : ~/Library/Application Support/astral/
 *  - Linux  : $XDG_CONFIG_HOME/astral/ 或 ~/.config/astral/
 *
 * 私钥文件权限 0600（POSIX），Windows 上忽略（ACL 模型不同）。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { generateIdentity, buildIdentity, type IdentityKeypair } from './crypto/identity.js';

export interface AstralConfig {
  nick: string;
  theme: string;
  planet: string;
  /** 默认传输：tcp（推荐）/ ws / bt */
  transport: string;
  /** 最近加入过的房间 */
  recentRooms: { name: string; passphrase: string; hub?: string }[];
  /** 下载目录 */
  downloadDir: string;
}

export const DEFAULT_CONFIG: AstralConfig = {
  nick: '',
  theme: 'nebula',
  planet: 'jupiter',
  transport: 'tcp',
  recentRooms: [],
  downloadDir: path.join(os.homedir(), 'astral-downloads'),
};

export function configDir(): string {
  const p = process.platform;
  if (p === 'win32') {
    return path.join(process.env['APPDATA'] ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'astral');
  }
  if (p === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'astral');
  }
  const xdg = process.env['XDG_CONFIG_HOME'];
  return path.join(xdg ?? path.join(os.homedir(), '.config'), 'astral');
}

export function ensureDirs(): string {
  const dir = configDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cfgPath(): string {
  return path.join(configDir(), 'config.json');
}

function keyPath(): string {
  return path.join(configDir(), 'identity.key');
}

export function loadConfig(): AstralConfig {
  try {
    const raw = fs.readFileSync(cfgPath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<AstralConfig>;
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(cfg: AstralConfig): void {
  ensureDirs();
  fs.writeFileSync(cfgPath(), JSON.stringify(cfg, null, 2), 'utf8');
}

/**
 * 载入或创建身份。
 * 私钥以 DER 存盘；如果文件权限过宽会尝试收紧（POSIX）。
 *
 * ephemeral：返回一次性身份（不落盘）。**同一台机器同时跑多个客户端时必须用这个**，
 * 否则所有进程共用同一个 peerId，hub 的成员表按 id 去重，会把它们当成同一个人。
 */
export function loadIdentity(opts: { ephemeral?: boolean } = {}): IdentityKeypair {
  if (opts.ephemeral) return generateIdentity();
  ensureDirs();
  const kp = keyPath();
  try {
    const priv = fs.readFileSync(kp);
    const { publicKey } = requirePublicFromPrivate(priv);
    return buildIdentity(publicKey, priv);
  } catch {
    const id = generateIdentity();
    fs.writeFileSync(kp, id.privateKey, { mode: 0o600 });
    try {
      fs.chmodSync(kp, 0o600);
    } catch {
      /* Windows 上 chmod 无意义，忽略 */
    }
    return id;
  }
}

/** 从 PKCS8 DER 私钥导出公钥 DER（Node 支持直接由私钥派生公钥） */
function requirePublicFromPrivate(privDer: Buffer): { publicKey: Buffer } {
  const priv = createPrivateKey({ key: privDer, format: 'der', type: 'pkcs8' });
  const pub = createPublicKey(priv);
  return { publicKey: Buffer.from(pub.export({ type: 'spki', format: 'der' })) };
}

/** 记住一个房间，便于下次快速进入 */
export function rememberRoom(name: string, passphrase: string, hub?: string): void {
  const cfg = loadConfig();
  cfg.recentRooms = cfg.recentRooms.filter((r) => r.name !== name);
  cfg.recentRooms.unshift({ name, passphrase, hub });
  cfg.recentRooms = cfg.recentRooms.slice(0, 20);
  saveConfig(cfg);
}

export const config = {
  configDir,
  ensureDirs,
  loadConfig,
  saveConfig,
  loadIdentity,
  rememberRoom,
  DEFAULT_CONFIG,
};
export default config;
