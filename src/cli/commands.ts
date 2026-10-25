/**
 * 非交互子命令：host / join / rooms / id / invite / demo / art
 *
 * 这些命令都是「跑完即退出」，因此在普通屏幕（非 alt screen）上输出，
 * 只有 demo 会进入全屏动画。
 */

import os from 'node:os';
import process from 'node:process';
import { Buffer } from 'node:buffer';
import fs from 'node:fs';

import { paint, cursor, screen, type ColorMode, type RGB } from '../lib/ansi.js';
import { THEMES, PLANETS, type Theme } from '../lib/palette.js';
import { Frame } from '../lib/frame.js';
import { size as termSize, RawMode, ensureUtf8 } from '../lib/terminal.js';
import { truncate } from '../lib/utf8.js';

import { Hub, TcpHubServer } from '../net/hub.js';
import { Peer, type RoomMember } from '../net/peer.js';
import { TcpTransport, parseHostPort, DEFAULT_PORT } from '../net/transport.js';
import { Discovery, type DiscoveredRoom } from '../net/discovery.js';
import { bluetoothStatus } from '../net/bluetooth.js';

import { loadIdentity, loadConfig, saveConfig, rememberRoom } from '../config.js';
import { FileTransfer, formatBytes } from '../features/filetransfer.js';
import { roomIdFrom, makeInvite, parseInvite, identityCard, randomart } from '../crypto/identity.js';
import { renderPlanet } from '../render/planet.js';
import { starfield } from '../render/starfield.js';
import { bootFrame } from '../render/logo.js';
import { getGame, listGames, GameSession } from '../games/index.js';

import { flagStr, flagNum, flagBool } from './args.js';
import type { CliEnv } from './main.js';

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function themeOf(flags: Record<string, string | boolean>): Theme {
  return THEMES[flagStr(flags, 'theme', 'nebula')] ?? THEMES['nebula']!;
}

function line(env: CliEnv, mode: ColorMode, text: string, fg?: RGB, bold = false): void {
  env.stdout.write(paint(text, { fg: fg ?? '#ccc', bold }, mode) + '\n');
}

/* ================================================================== */
/* host                                                                */
/* ================================================================== */

export async function runHost(
  env: CliEnv,
  mode: ColorMode,
  rest: string[],
  flags: Record<string, string | boolean>,
): Promise<number> {
  const cfg = loadConfig();
  const name = flagStr(flags, 'room') || rest[0] || `房间-${Math.random().toString(36).slice(2, 6)}`;
  const pass = flagStr(flags, 'pass') || process.env['ASTRAL_PASS'] || '';
  const port = flagNum(flags, 'port', DEFAULT_PORT);
  const nick = flagStr(flags, 'nick', cfg.nick || 'host');
  const theme = themeOf(flags);

  const roomId = roomIdFrom(name, pass);
  const hub = new Hub({ roomId, roomName: name, passphrase: pass, maxPeers: 1000 });
  const server = new TcpHubServer(hub);

  let actualPort = port;
  try {
    actualPort = await server.listen(port, '0.0.0.0');
  } catch (e) {
    env.stderr.write(`端口 ${port} 监听失败：${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }

  // 宣告自己，让别人能发现
  let discovery: Discovery | null = null;
  try {
    discovery = new Discovery({
      announce: { roomId, port: actualPort, transports: ['tcp'], peerCount: 1, secured: Boolean(pass) },
    });
    await discovery.start();
  } catch {
    /* 广播不可用不影响托管 */
  }

  const identity = loadIdentity({ ephemeral: !flagBool(flags, "stable-id") });
  const peer = new Peer({ peerId: identity.id, nickname: nick, roomId, passphrase: pass });
  peer.on('presence', (m: RoomMember[]) => {
    line(env, mode, `  · 房间内 ${m.length} 人：${m.map((x) => x.nick).join('、')}`, theme.dim);
  });

  const addr = `${localIp()}:${actualPort}`;
  line(env, mode, '');
  line(env, mode, `  已托管房间「${name}」`, theme.accent, true);
  line(env, mode, `  地址 ${addr}`, theme.fg);
  line(env, mode, `  房间 ID ${roomId}`, theme.dim);
  line(env, mode, `  端到端加密 ${pass ? '已启用（口令派生）' : '未设置口令 —— 局域网内任何人可读'}`, pass ? (theme.ok) : (theme.warn));
  line(env, mode, `  邀请码 ${makeInvite(name, pass, addr)}`, theme.accent2);
  line(env, mode, '');
  line(env, mode, '  等待他人加入…（Ctrl+C 结束）', theme.dim);

  // 房主自己也在房间里
  try {
    const t = await TcpTransport.connect('127.0.0.1', actualPort, 4000);
    peer.attach(t);
  } catch {
    /* 本地回环都连不上就纯当 hub */
  }

  await new Promise<void>((resolve) => {
    const onSig = () => {
      line(env, mode, '\n  房间已关闭。', theme.dim);
      resolve();
    };
    process.once('SIGINT', onSig);
    process.once('SIGTERM', onSig);
  });

  try {
    discovery?.setAnnounce(undefined);
  } catch {
    /* ignore */
  }
  peer.close();
  return 0;
}

/* ================================================================== */
/* join                                                                */
/* ================================================================== */

export async function runJoin(
  env: CliEnv,
  mode: ColorMode,
  rest: string[],
  flags: Record<string, string | boolean>,
): Promise<number> {
  const cfg = loadConfig();
  const name = rest[0] ?? flagStr(flags, 'room');
  if (!name) {
    env.stderr.write('用法：astral join <房间名> [口令] [--hub 1.2.3.4:7331]\n');
    return 2;
  }
  const pass = flagStr(flags, 'pass') || rest.slice(1).join(' ') || process.env['ASTRAL_PASS'] || '';
  const nick = flagStr(flags, 'nick', cfg.nick || 'guest');
  const theme = themeOf(flags);
  let hubAddr = flagStr(flags, 'hub');

  // 邀请码形式：ASTRAL1:...
  let resolvedName = name;
  let resolvedPass = pass;
  if (name.startsWith('ASTRAL1:')) {
    const inv = parseInvite(name);
    resolvedName = inv.room;
    resolvedPass = inv.passphrase || pass;
    hubAddr = hubAddr || inv.hub || '';
  }

  if (!hubAddr) {
    // 先用 discovery 找
    hubAddr = (await discoverHub(resolvedName)) ?? '';
  }
  if (!hubAddr) {
    env.stderr.write(`找不到房间「${resolvedName}」。用 --hub 主机:端口 直接指定。\n`);
    return 1;
  }

  const { host, port } = parseHostPort(hubAddr, DEFAULT_PORT);
  const roomId = roomIdFrom(resolvedName, resolvedPass);
  const identity = loadIdentity({ ephemeral: !flagBool(flags, "stable-id") });

  const peer = new Peer({ peerId: identity.id, nickname: nick, roomId, passphrase: resolvedPass });
  let done: () => void = () => {};
  const finished = new Promise<void>((r) => (done = r));

  // 文件传输（自动接收 + SHA-256 校验）
  const files = new FileTransfer(peer, cfg.downloadDir);
  let memberCount = 0;
  files.setHandlers({
    onOffer: (o) => line(env, mode, `  📥 ${o.fromNick} 发来文件 ${o.name}（${formatBytes(o.size)}），接收校验中…`, theme.accent),
    onComplete: (i) => line(env, mode, `  ✅ 文件已保存：${i.path}`, theme.ok),
    onError: (m) => line(env, mode, `  ⚠ ${m}`, theme.warn),
  });

  peer.on('ready', ({ members }: { members: RoomMember[] }) => {
    memberCount = members.length;
    line(env, mode, `  已加入「${resolvedName}」· ${members.length} 人在线`, theme.ok, true);
    line(env, mode, `  成员：${members.map((m) => m.nick).join('、')}`, theme.fg);
  });
  peer.on('presence', (members: RoomMember[]) => {
    memberCount = members.length;
  });
  peer.on('message', (m: Record<string, unknown>) => {
    const t = m['t'];
    if (t === 'chat') {
      line(env, mode, `  ${String(m['nick'])}: ${String(m['text'])}`, theme.fg);
    } else if (t === 'dm') {
      line(env, mode, `  🔒 [私] ${String(m['nick'])}: ${String(m['text'])}`, theme.accent2);
    } else if (t === 'system') {
      line(env, mode, `  * ${String(m['text'])}`, theme.dim);
    } else if (t === 'file-offer') {
      files.handleOffer(m as never);
    } else if (t === 'file-chunk') {
      files.handleChunk(m as never);
    } else if (t === 'poll-create' || t === 'poll-vote') {
      // 命令行模式只提示，不渲染面板
      if (t === 'poll-create') {
        line(env, mode, `  📊 ${String(m['nick'])} 发起投票：${String(m['question'])}`, theme.accent);
      }
    } else if (t === 'game') {
      line(env, mode, `  🎮 ${String(m['nick'] ?? m['from'])} 发起了 ${String(m['game'])}`, theme.accent);
    }
  });
  peer.on('error', (e: Error) => line(env, mode, `  错误：${e.message}`, theme.err));
  peer.on('disconnected', () => {
    line(env, mode, '  连接断开。', theme.warn);
    done();
  });

  try {
    const t = await TcpTransport.connect(host, port, 6000);
    peer.attach(t);
  } catch (e) {
    env.stderr.write(`连不上 ${host}:${port}：${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }

  rememberRoom(resolvedName, resolvedPass, hubAddr);

  // 把 stdin 当作聊天输入（每行一条）
  line(env, mode, '  输入消息回车发送（/quit 离开）：', theme.dim);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    const text = String(chunk).replace(/\r?\n$/, '');
    if (text === '/quit' || text === '/exit') {
      peer.close();
      done();
      return;
    }
    if (text.startsWith('/send ')) {
      const p = text.slice(6).trim();
      if (!p) return line(env, mode, '  用法：/send 文件路径', theme.warn);
      void files
        .sendFile(p)
        .then((o) => line(env, mode, `  ✅ 已发送 ${o.name}（${formatBytes(o.size)}，sha256 ${o.sha256.slice(0, 12)}…）`, theme.ok))
        .catch((e: Error) => line(env, mode, `  ⚠ 发送失败：${e.message}`, theme.warn));
      return;
    }
    if (text.startsWith('/game ')) {
      const g = text.slice(6).trim();
      const def = getGame(g as Parameters<typeof getGame>[0]);
      if (!def) {
        return line(env, mode, `  没有这个游戏。可用：${listGames().map((x) => x.id).join(' / ')}`, theme.warn);
      }
      if (memberCount < def.minPlayers) {
        return line(env, mode, `  ${def.name} 至少需要 ${def.minPlayers} 人（当前 ${memberCount}）`, theme.warn);
      }
      const seed = Date.now() >>> 0;
      peer.send({ t: 'game', id: `g${seed}`, from: identity.id, game: def.id, action: 'start', payload: { seed }, ts: Date.now() });
      line(env, mode, `  🎮 ${def.name} 开局（种子 ${seed}），共 ${memberCount} 人`, theme.ok, true);
      return;
    }
    if (text.trim()) {
      peer.send({ t: 'chat', id: `c${Date.now()}`, from: identity.id, nick, text, ts: Date.now() });
    }
  });

  await finished;
  return 0;
}

async function discoverHub(roomName: string): Promise<string | null> {
  const target = roomIdFrom(roomName, '');
  return new Promise((resolve) => {
    let d: Discovery;
    try {
      d = new Discovery();
    } catch {
      return resolve(null);
    }
    const timer = setTimeout(() => {
      try {
        d.setAnnounce(undefined);
      } catch {
        /* ignore */
      }
      resolve(null);
    }, 3000);
    d.on('room', (r: DiscoveredRoom) => {
      if (r.roomHash === target) {
        clearTimeout(timer);
        resolve(`${r.host}:${r.port}`);
      }
    });
    void d.start().catch(() => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

/* ================================================================== */
/* rooms                                                               */
/* ================================================================== */

export async function runRooms(
  env: CliEnv,
  mode: ColorMode,
  flags: Record<string, string | boolean>,
): Promise<number> {
  const theme = themeOf(flags);
  const ms = flagNum(flags, 'wait', 3000);
  line(env, mode, `  扫描局域网房间（${ms}ms）…`, theme.dim);

  const found = new Map<string, DiscoveredRoom>();
  let d: Discovery;
  try {
    d = new Discovery();
    await d.start();
  } catch {
    line(env, mode, '  无法开启广播发现（可能是无网络或权限受限）。', theme.warn);
    return 1;
  }
  d.on('room', (r: DiscoveredRoom) => found.set(`${r.roomHash}@${r.host}:${r.port}`, r));
  await wait(ms);

  const list = Array.from(found.values());
  if (!list.length) {
    line(env, mode, '  未发现房间。让房主执行：astral host --room 名称', theme.fg);
  } else {
    for (const r of list) {
      const lock = r.secured ? '🔒' : '🔓';
      line(env, mode, `  ${lock} ${r.roomHash.slice(0, 12)}  ${r.host}:${r.port}  ${r.peerCount} 人  ${r.transports.join('/')}`, theme.accent);
    }
    line(env, mode, `\n  共 ${list.length} 个房间。加入：astral join <房间ID>`, theme.dim);
  }
  return 0;
}

/* ================================================================== */
/* id                                                                  */
/* ================================================================== */

export async function runId(
  env: CliEnv,
  mode: ColorMode,
  flags: Record<string, string | boolean>,
): Promise<number> {
  const id = loadIdentity({ ephemeral: true });
  const theme = themeOf(flags);
  if (flagBool(flags, 'json')) {
    env.stdout.write(JSON.stringify({ id: id.id, fingerprint: id.fingerprint }, null, 2) + '\n');
    return 0;
  }
  line(env, mode, '');
  for (const l of identityCard(id, 'ASTRA-ID').split('\n')) {
    env.stdout.write(paint(l, { fg: theme.accent }, mode) + '\n');
  }
  line(env, mode, '');
  line(env, mode, `  指纹 ${id.fingerprint}`, theme.fg);
  line(env, mode, '  与朋友核对上面的随机艺术图，一致即未被中间人替换。', theme.dim);
  if (flagBool(flags, 'bt')) {
    line(env, mode, `  蓝牙：${bluetoothStatus()}`, theme.dim);
  }
  return 0;
}

/* ================================================================== */
/* invite                                                              */
/* ================================================================== */

export async function runInvite(
  env: CliEnv,
  mode: ColorMode,
  rest: string[],
  flags: Record<string, string | boolean>,
): Promise<number> {
  const name = rest[0] ?? flagStr(flags, 'room', '我的房间');
  const pass = flagStr(flags, 'pass') || randomPass();
  const hub = flagStr(flags, 'hub') || `${localIp()}:${flagNum(flags, 'port', DEFAULT_PORT)}`;
  const theme = themeOf(flags);
  const code = makeInvite(name, pass, hub);

  line(env, mode, '');
  line(env, mode, `  房间「${name}」`, theme.accent, true);
  line(env, mode, `  口令 ${pass}`, theme.fg);
  line(env, mode, `  邀请码（发给朋友即可加入）：`, theme.dim);
  line(env, mode, `  ${code}`, theme.ok, true);
  line(env, mode, '');
  line(env, mode, '  提示：邀请码里含房间口令，请只发给信任的人。', theme.warn);
  return 0;
}

/* ================================================================== */
/* demo —— 离线演示：开机动画 + 行星 + 自动对局                          */
/* ================================================================== */

export async function runDemo(
  env: CliEnv,
  mode: ColorMode,
  flags: Record<string, string | boolean>,
): Promise<number> {
  const theme = themeOf(flags);
  const planet = flagStr(flags, 'planet', 'jupiter');

  if (mode === 'none' || !process.stdout.isTTY) {
    // 无 TTY：输出纯文本版
    env.stdout.write(renderPlanet(planet, { diameter: 40 }).toPlain() + '\n');
    return 0;
  }

  ensureUtf8();
  const raw = new RawMode(process.stdin);
  const { width, height } = termSize();
  process.stdout.write(screen.altEnter + screen.nowrapOn + cursor.hide);

  const frames: string[] = [];

  // 1) 开机动画
  for (let i = 0; i <= 24; i++) {
    const f = bootFrame({ width, height, progress: i / 24, planet: planet as 'jupiter', linked: i > 18 });
    frames.push(f.render(mode));
  }

  // 2) 行星自转
  for (let i = 0; i < 30; i++) {
    const bg = starfield({ width, height, t: i * 0.1, density: 1.6, nebula: 0.2, seed: 'demo' });
    const p = renderPlanet(planet as never, { diameter: Math.min(46, height * 1.6), spin: i * 0.05, glow: true });
    bg.blit(Math.floor((width - p.width) / 2), Math.max(0, Math.floor((height - p.height) / 2)), p);
    bg.text(2, height - 2, `  ASTRAL · ${planet} · 离线演示`, { fg: theme.accent, bold: true });
    frames.push(bg.render(mode));
  }

  // 3) 自动对局：狼人杀
  const gameId = flagStr(flags, 'game', 'werewolf');
  const def = getGame(gameId as Parameters<typeof getGame>[0]);
  if (def) {
    const players = Array.from({ length: Math.min(def.maxPlayers, 9) }, (_, i) => ({
      id: `p${i}`,
      nick: ['水星', '金星', '地球', '火星', '木星', '土星', '天王', '海王', '冥王'][i] ?? `P${i}`,
    }));
    const s = GameSession.create(def, players, (Date.now() >>> 0) || 1);
    for (let step = 0; step < 40 && !s.isOver(); step++) {
      const st = s.current;
      const alive = st.players.filter((p) => p.alive);
      // 极简 AI：投票阶段随便投，其它阶段推进
      const acted = tryAct(s, alive, step);
      if (!acted) break;
      const f = new Frame({ width, height, bg: theme.bg });
      const bg = starfield({ width, height, t: step * 0.2, density: 1.2, nebula: 0.1, seed: 'g' });
      f.blit(0, 0, bg);
      const board = s.view(players[0]!.id);
      const lines = (board.ascii ?? '').split('\n');
      lines.slice(0, height - 4).forEach((l, i) => f.text(2, i + 1, truncate(l, width - 4), { fg: theme.fg }));
      const tail = st.log.slice(-3).map((l) => l.text);
      tail.forEach((l, i) => f.text(2, height - 4 + i, truncate(l, width - 4), { fg: theme.dim }));
      frames.push(f.render(mode));
    }
    if (s.isOver()) {
      const f = new Frame({ width, height, bg: theme.bg });
      const winners = s.current.winners ?? [];
      f.text(2, Math.floor(height / 2), `游戏结束，胜者：${winners.map((w) => players.find((p) => p.id === w)?.nick ?? w).join('、')}`, { fg: theme.ok, bold: true });
      f.text(2, Math.floor(height / 2) + 2, '按任意键退出', { fg: theme.dim });
      frames.push(f.render(mode));
    }
  }

  // 播放
  process.stdin.once('data', () => {
    /* 提前退出 */
  });
  for (const f of frames) {
    process.stdout.write(cursor.home + f);
    await wait(70);
    if (!process.stdin.isPaused && process.stdin.readableLength > 0) break;
  }

  process.stdout.write(cursor.show + screen.nowrapOff + screen.altExit);
  raw.disable();
  return 0;
}

/** demo 用的极简 AI，只负责让局面往前走 */
function tryAct(s: GameSession, alive: { id: string }[], step: number): boolean {
  const st = s.current;
  const pick = (exclude?: string): string | null => {
    const c = alive.filter((p) => p.id !== exclude);
    return c.length ? c[step % c.length]!.id : null;
  };
  const pending = st.pending[0];
  const data = st.data as Record<string, unknown>;

  if (data['pendingShot']) {
    const t = pick(String(data['pendingShot']));
    return s.apply({ by: String(data['pendingShot']), type: t ? 'shoot' : 'shoot-skip', payload: t ? { target: t } : {} });
  }
  const ns = data['nightStep'] as string | null;
  if (ns === 'kill') {
    const t = pick();
    return s.apply({ by: pending ?? alive[0]!.id, type: 'kill', payload: { target: t } }) ||
      s.apply({ by: pending ?? alive[0]!.id, type: 'wolf-commit' });
  }
  if (ns === 'seer') return s.apply({ by: pending!, type: 'seer', payload: { target: pick(pending) } });
  if (ns === 'witch') return s.apply({ by: pending!, type: 'witch-skip' });
  if (ns === 'guard') return s.apply({ by: pending!, type: 'guard', payload: { target: pick() } });
  if (ns === null) return s.apply({ by: 'system', type: 'dawn' });
  if (st.phase === 'voting') {
    const votes = (data['votes'] ?? {}) as Record<string, string>;
    const rest = alive.filter((p) => !votes[p.id]);
    if (rest.length) return s.apply({ by: rest[0]!.id, type: 'vote', payload: { target: pick(rest[0]!.id) } });
    return false;
  }
  // 大富翁 / 三国杀等
  if (s.apply({ by: pending!, type: 'roll' })) return true;
  if (s.apply({ by: pending!, type: 'draw' })) return true;
  if (s.apply({ by: pending!, type: 'buy' })) return true;
  if (s.apply({ by: pending!, type: 'decline' })) return true;
  return s.apply({ by: pending!, type: 'end-turn' });
}

/* ================================================================== */
/* art                                                                 */
/* ================================================================== */

export async function runArt(
  env: CliEnv,
  mode: ColorMode,
  rest: string[],
  flags: Record<string, string | boolean>,
): Promise<number> {
  const name = rest[0] ?? flagStr(flags, 'planet', 'jupiter');
  const names = Object.keys(PLANETS);
  const preset = PLANETS[name];
  if (!preset) {
    env.stderr.write(`未知行星：${name}\n可选：${names.join(' / ')}\n`);
    return 2;
  }
  const d = flagNum(flags, 'size', 44);
  const f = renderPlanet(name as never, { diameter: d, spin: flagNum(flags, 'spin', 0), glow: !flagBool(flags, 'no-glow') });
  if (mode === 'none' || flagBool(flags, 'plain')) {
    env.stdout.write(f.toPlain() + '\n');
  } else {
    env.stdout.write(f.render(mode) + '\n');
  }
  return 0;
}

/* ================================================================== */

function localIp(): string {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) return ni.address;
    }
  }
  return '127.0.0.1';
}

function randomPass(): string {
  const words = ['星尘', '木星', '土环', '猎户', '天狼', '织女', '虫洞', '彗星', '银河', '星云'];
  return `${words[Math.floor(Math.random() * words.length)]}-${Math.floor(Math.random() * 9000 + 1000)}`;
}

export const commands = { runHost, runJoin, runRooms, runId, runInvite, runDemo, runArt };
export default commands;
