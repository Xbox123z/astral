/**
 * 交互模式：把「发现房间 -> 加入 -> 聊天/文件/投票/游戏」串成一条流畅的体验。
 *
 * 输入处理是手写的行编辑器（不依赖 readline），因为要同时满足：
 *  - 中文/emoji 按字符（不是按字节）编辑
 *  - 方向键、Home/End、Ctrl+W、历史记录、Tab 补全
 *  - 与全屏重绘共存（readline 会抢光标）
 */

import process from 'node:process';
import { Buffer } from 'node:buffer';
import { EventEmitter } from 'node:events';

import type { ColorMode, RGB } from '../lib/ansi.js';
import { paint, cursor, screen } from '../lib/ansi.js';
import { THEMES, PLANETS, type Theme } from '../lib/palette.js';
import { displayWidth, truncate, sliceByWidth } from '../lib/utf8.js';
import { Frame } from '../lib/frame.js';
import { size as termSize, onResize, RawMode, ensureUtf8, setTitle } from '../lib/terminal.js';

import { KeyReader, type Key } from '../ui/keys.js';
import { InputLine } from '../ui/widgets.js';
import { ChatScreen, renderRoomList, type ScreenState, type RoomRow } from '../ui/screen.js';
import { HELP_TEXT } from '../ui/screen.js';

import { Discovery, type DiscoveredRoom } from '../net/discovery.js';
import { Hub, TcpHubServer } from '../net/hub.js';
import { Peer, type RoomMember } from '../net/peer.js';
import { TcpTransport, parseHostPort, DEFAULT_PORT } from '../net/transport.js';

import { loadIdentity, loadConfig, saveConfig, rememberRoom } from '../config.js';
import { FileTransfer, formatBytes } from '../features/filetransfer.js';
import { PollManager } from '../features/poll.js';
import { getGame, listGames, GameSession, type GameAction } from '../games/index.js';
import { randomart, makeInvite, parseInvite, deriveRoomKey, roomIdFrom, type IdentityKeypair } from '../crypto/identity.js';
import type { CliEnv } from './main.js';

type Mode = ColorMode;

interface ChatLine {
  /** 自动生成 */
  id: string;
  nick: string;
  authorId: string;
  text: string;
  ts: number;
  dm?: boolean;
  system?: boolean;
  attachment?: string;
}

/** push() 的参数：id 由内部补全 */
type ChatDraft = Omit<ChatLine, 'id'>;

let chatSeq = 0;
function mkLine(l: ChatDraft): ChatLine {
  return { ...l, id: `m${++chatSeq}` };
}

export async function runInteractive(env: CliEnv, mode: Mode): Promise<number> {
  const app = new InteractiveApp(env, mode);
  return app.start();
}

class InteractiveApp {
  private cfg = loadConfig();
  private identity: IdentityKeypair;
  private themeId: string;
  private planet: string;
  private theme: Theme;

  private messages: ChatLine[] = [];
  private input = new InputLine('❯ ', 4000);
  private members: RoomMember[] = [];
  private typing: string[] = [];
  private toast: string | null = null;
  private toastUntil = 0;

  private peer: Peer | null = null;
  private hub: Hub | null = null;
  private discovery: Discovery | null = null;
  private rooms: DiscoveredRoom[] = [];
  private roomIndex = 0;

  private files: FileTransfer | null = null;
  private polls: PollManager | null = null;
  private session: GameSession | null = null;
  private gameId: string | null = null;

  private screenState: ScreenState | null = null;
  private chatScreen: ChatScreen | null = null;
  private raw: RawMode | null = null;
  private keys: KeyReader | null = null;
  private animTimer: NodeJS.Timeout | null = null;
  private resizeOff: (() => void) | null = null;
  private t0 = Date.now();
  private running = true;
  private scroll = 0;
  private tabCandidates: string[] = [];
  private tabIndex = -1;
  private tabPrefix = '';
  /** 浏览器/文件选择菜单（非聊天场景） */
  private menuMode: 'none' | 'rooms' | 'help' | 'games' = 'none';

  constructor(
    private env: CliEnv,
    private mode: Mode,
  ) {
    this.identity = loadIdentity();
    this.themeId = this.cfg.theme || 'nebula';
    this.planet = this.cfg.planet || 'jupiter';
    this.theme = THEMES[this.themeId] ?? THEMES['nebula']!;
    if (!this.cfg.nick) this.cfg.nick = defaultNick();
  }

  /* ================= 生命周期 ================= */

  private get selfId(): string {
    return this.identity.id;
  }

  private terminalSize(): { width: number; height: number } {
    const s = termSize();
    return { width: s.width, height: s.height };
  }

  async start(): Promise<number> {
    const mode = this.mode;

    if (mode === 'none' || !process.stdout.isTTY) {
      return this.startPlain();
    }

    ensureUtf8();
    this.raw = new RawMode(process.stdin);
    this.raw.enable();
    process.stdout.write(screen.altEnter + screen.nowrapOn + screen.bracketedPasteOn + cursor.hide);
    process.stdout.write(setTitle('ASTRAL · 终端星河'));

    this.keys = new KeyReader(process.stdin);
    this.keys.on('key', (k) => this.onKey(k));
    this.keys.on('paste', (text) => {
      this.input.insert(text.replace(/\r?\n/g, ' '));
      this.redraw();
    });
    process.stdin.on('end', () => this.stop());

    // 房间发现（后台）
    this.startDiscovery();

    // 终端尺寸变化时重绘（改窗口大小不会错位）
    this.resizeOff = onResize(() => this.redraw());

    // 动画：行星缓慢自转 + 星空漂移
    this.animTimer = setInterval(() => {
      if (!this.running) return;
      this.redraw();
    }, 120);

    this.pushSystem('欢迎来到 ASTRAL。输入 /help 查看命令，/rooms 浏览房间，/host 创建房间。');
    this.menuMode = 'rooms';
    this.redraw();

    await new Promise<void>((resolve) => {
      const wait = () => {
        if (!this.running) return resolve();
        setTimeout(wait, 60);
      };
      wait();
    });
    return 0;
  }

  private stop(): void {
    this.running = false;
    if (this.animTimer) clearInterval(this.animTimer);
    this.resizeOff?.();
    try {
      (this.discovery as unknown as { stop?: () => void })?.stop?.();
    } catch {
      /* 忽略关闭异常 */
    }
    try {
      this.peer?.close();
    } catch {
      /* 忽略 */
    }
    process.stdout.write(cursor.show + screen.bracketedPasteOff + screen.nowrapOff + screen.altExit);
    this.raw?.disable();
  }

  /** 非 TTY（管道/CI）时的退化模式：纯文本输入输出 */
  private async startPlain(): Promise<number> {
    this.env.stdout.write('astral 需要交互式终端。当前不是 TTY，已切换到纯文本模式。\n');
    this.env.stdout.write('可用：astral rooms | astral host --room 名称 | astral demo\n');
    return 0;
  }

  /* ================= 发现 ================= */

  private startDiscovery(): void {
    try {
      this.discovery = new Discovery();
      this.discovery.on('room', (r: DiscoveredRoom) => {
        const i = this.rooms.findIndex((x) => x.roomHash === r.roomHash && x.host === r.host);
        if (i >= 0) this.rooms[i] = r;
        else this.rooms.push(r);
        this.redraw();
      });
      void this.discovery.start().catch(() => {
        // 某些环境不允许广播（无网络/受限容器/权限），静默降级为手动连接
      });
    } catch {
      // 同上，静默降级
    }
  }

  /** DiscoveredRoom 没有名字（只有房间哈希，避免泄露房间名），显示时用短哈希 */
  private roomLabel(r: DiscoveredRoom): string {
    return r.roomHash.slice(0, 8);
  }

  /* ================= 输入 ================= */

  private onKey(k: Key): void {
    // Ctrl+C 退出
    if (k.ctrl && (k.ch === 'c' || k.name === 'char')) {
      this.pushSystem('再见。');
      this.redraw();
      setTimeout(() => this.stop(), 120);
      return;
    }

    // 菜单模式下的导航
    if (this.menuMode === 'rooms') {
      if (k.name === 'up') {
        this.roomIndex = Math.max(0, this.roomIndex - 1);
        return this.redraw();
      }
      if (k.name === 'down') {
        this.roomIndex = Math.min(Math.max(0, this.rooms.length - 1), this.roomIndex + 1);
        return this.redraw();
      }
      if (k.name === 'enter') {
        const r = this.rooms[this.roomIndex];
        if (r) {
          this.menuMode = 'none';
          void this.joinRoom(r.roomHash, '', `${r.host}:${r.port}`);
        }
        return this.redraw();
      }
      if (k.name === 'escape') {
        this.menuMode = 'none';
        return this.redraw();
      }
    }

    switch (k.name) {
      case 'enter':
        return this.submit();
      case 'backspace':
        this.input.backspace();
        return this.redraw();
      case 'delete':
        this.input.deleteForward();
        return this.redraw();
      case 'left':
        this.input.left();
        return this.redraw();
      case 'right':
        this.input.right();
        return this.redraw();
      case 'home':
        this.input.home();
        return this.redraw();
      case 'end':
        this.input.end();
        return this.redraw();
      case 'up':
        if (this.peer) this.scroll = Math.min(this.scroll + 4, 2000);
        else this.input.historyPrev();
        return this.redraw();
      case 'down':
        if (this.peer) this.scroll = Math.max(0, this.scroll - 4);
        else this.input.historyNext();
        return this.redraw();
      case 'pageup':
        this.scroll = Math.min(this.scroll + 20, 4000);
        return this.redraw();
      case 'pagedown':
        this.scroll = Math.max(0, this.scroll - 20);
        return this.redraw();
      case 'tab':
        return this.complete();
      case 'escape':
        this.scroll = 0;
        return this.redraw();
      default:
        break;
    }

    if (k.ctrl && k.ch === 'w') {
      this.input.wordLeft();
      const before = this.input.text.length;
      const head = this.input.text.slice(0, this.input.cursor);
      const trimmed = head.replace(/\S+\s*$/, '');
      this.input.text = trimmed + this.input.text.slice(this.input.cursor);
      this.input.cursor = trimmed.length;
      void before;
      return this.redraw();
    }
    if (k.ctrl && k.ch === 'u') {
      this.input.text = this.input.text.slice(this.input.cursor);
      this.input.cursor = 0;
      return this.redraw();
    }
    if (k.ctrl && k.ch === 'l') {
      this.messages = [];
      return this.redraw();
    }

    if (k.ch && !k.ctrl && !k.alt) {
      this.input.insert(k.ch);
      this.tabIndex = -1;
      // 打字时通知他人（节流）
      this.maybeTyping();
      return this.redraw();
    }
    return this.redraw();
  }

  private lastTyping = 0;
  private maybeTyping(): void {
    const now = Date.now();
    if (now - this.lastTyping < 3000 || !this.peer) return;
    this.lastTyping = now;
    this.peer.send({ t: 'typing', id: `ty${now}`, from: this.selfId, nick: this.cfg.nick, ts: now });
  }

  private complete(): void {
    const text = this.input.text;
    const upto = text.slice(0, this.input.cursor);
    const m = /\/(\w*)$/.exec(upto);
    if (m) {
      // 命令补全
      const cmds = ['/help', '/nick', '/dm', '/members', '/send', '/get', '/poll', '/vote', '/game', '/act', '/theme', '/planet', '/host', '/rooms', '/join', '/id', '/invite', '/quit'];
      const hits = cmds.filter((c) => c.startsWith(m[0]));
      if (hits.length === 1) {
        const add = hits[0]!.slice(m[0].length) + ' ';
        this.input.insert(add);
        return this.redraw();
      }
      if (hits.length > 1) {
        this.pushSystem(hits.join('  '));
        return this.redraw();
      }
      return;
    }
    // 昵称补全
    const nm = /@?(\S*)$/.exec(upto);
    if (!nm || !this.members.length) return;
    const prefix = nm[1] ?? '';
    if (this.tabIndex < 0) {
      this.tabPrefix = prefix;
      this.tabCandidates = this.members.map((x) => x.nick).filter((n) => n.startsWith(prefix));
    }
    if (!this.tabCandidates.length) return;
    this.tabIndex = (this.tabIndex + 1) % this.tabCandidates.length;
    // 替换当前单词
    const head = upto.slice(0, upto.length - this.tabPrefix.length);
    this.input.text = head + this.tabCandidates[this.tabIndex]! + ' ' + text.slice(this.input.cursor);
    this.input.cursor = head.length + this.tabCandidates[this.tabIndex]!.length + 1;
    this.tabPrefix = this.tabCandidates[this.tabIndex]!;
    this.redraw();
  }

  private submit(): void {
    const raw = this.input.submit();
    this.scroll = 0;
    if (!raw.trim()) return this.redraw();
    if (raw.startsWith('/')) {
      void this.runCommand(raw.trim());
      return;
    }
    if (!this.peer) {
      this.pushSystem('还没加入房间。用 /host 创建，或 /rooms 浏览、/join 加入。');
      return this.redraw();
    }
    this.peer.send({
      t: 'chat',
      id: `c${Date.now()}`,
      from: this.selfId,
      nick: this.cfg.nick,
      text: raw,
      ts: Date.now(),
    });
    this.push({ nick: this.cfg.nick, authorId: this.selfId, text: raw, ts: Date.now() });
    this.redraw();
  }

  /* ================= 命令 ================= */

  private async runCommand(raw: string): Promise<void> {
    const [cmd, ...rest] = raw.slice(1).split(/\s+/);
    const argStr = rest.join(' ');
    const { width } = this.terminalSize();

    switch (cmd) {
      case 'help':
        for (const l of HELP_TEXT) this.pushSystem(l);
        return this.redraw();

      case 'quit':
      case 'exit':
        this.pushSystem('再见。');
        this.redraw();
        setTimeout(() => this.stop(), 100);
        return;

      case 'nick': {
        const n = argStr.trim();
        if (!n) return this.toastMsg('用法：/nick 新昵称');
        this.cfg.nick = n;
        saveConfig(this.cfg);
        if (this.peer) {
          this.peer.send({ t: 'system', id: `s${Date.now()}`, text: `${n} 改了昵称`, ts: Date.now() });
        }
        return this.toastMsg(`昵称已改为 ${n}`);
      }

      case 'theme': {
        const t = argStr.trim();
        if (!THEMES[t]) return this.toastMsg(`主题可选：${Object.keys(THEMES).join(' / ')}`);
        this.themeId = t;
        this.theme = THEMES[t]!;
        this.cfg.theme = t;
        saveConfig(this.cfg);
        return this.toastMsg(`主题：${t}`);
      }

      case 'planet': {
        const p = argStr.trim();
        if (!p) return this.toastMsg(`行星可选：${Object.keys(PLANETS).join(' / ')}`);
        if (!PLANETS[p]) return this.toastMsg(`未知行星：${p}`);
        this.planet = p;
        this.cfg.planet = p;
        saveConfig(this.cfg);
        return this.toastMsg(`装饰行星：${p}`);
      }

      case 'rooms':
        this.menuMode = 'rooms';
        this.roomIndex = 0;
        return this.redraw();

      case 'host': {
        const name = argStr.trim() || `房间-${Math.random().toString(36).slice(2, 6)}`;
        const pass = await this.askPassphrase(name);
        return this.hostRoom(name, pass);
      }

      case 'join': {
        const [name, ...passParts] = rest;
        const pass = passParts.join(' ');
        if (!name) return this.toastMsg('用法：/join 房间名 [口令]');
        return this.joinRoom(name, pass);
      }

      case 'members':
        if (!this.members.length) return this.toastMsg('（暂无成员）');
        this.pushSystem(`在线 ${this.members.length} 人：${this.members.map((m) => m.nick).join('、')}`);
        return this.redraw();

      case 'dm': {
        const [target, ...textParts] = rest;
        const text = textParts.join(' ');
        if (!target || !text) return this.toastMsg('用法：/dm 昵称 内容');
        const who = this.members.find((m) => m.nick === target || m.id.startsWith(target));
        if (!who) return this.toastMsg(`找不到成员：${target}`);
        if (!this.peer) return this.toastMsg('还没加入房间');
        this.peer.sendDm(who.id, text);
        this.push({ nick: `→ ${who.nick}`, authorId: this.selfId, text, ts: Date.now(), dm: true });
        return this.redraw();
      }

      case 'send': {
        const p = argStr.trim();
        if (!p) return this.toastMsg('用法：/send 文件路径');
        if (!this.files) return this.toastMsg('还没加入房间');
        this.files
          .sendFile(p)
          .then((o) => this.toastMsg(`已发送 ${o.name}（${formatBytes(o.size)}，SHA-256 ${o.sha256.slice(0, 12)}…）`))
          .catch((e: Error) => this.toastMsg(`发送失败：${e.message}`));
        return this.redraw();
      }

      case 'poll': {
        const m = /^"([^"]+)"\s+(.+)$/.exec(argStr) ?? /^(\S+)\s+(.+)$/.exec(argStr);
        if (!m) return this.toastMsg('用法：/poll "问题" 选项A|选项B|选项C');
        const question = m[1]!;
        const opts = m[2]!.split('|').map((s) => s.trim()).filter(Boolean);
        if (opts.length < 2) return this.toastMsg('至少需要两个选项（用 | 分隔）');
        if (!this.polls) return this.toastMsg('还没加入房间');
        this.polls.create(question, opts);
        return this.toastMsg(`已发起投票：${question}`);
      }

      case 'vote': {
        const n = Number(rest[0]);
        if (!this.polls) return this.toastMsg('还没加入房间');
        const p = this.polls.active;
        if (!p) return this.toastMsg('当前没有进行中的投票');
        if (!Number.isFinite(n) || n < 1 || n > p.options.length) {
          return this.toastMsg(`请输入 1-${p.options.length} 之间的选项序号`);
        }
        this.polls.vote(p.id, [n - 1]);
        return this.toastMsg(`已投给「${p.options[n - 1]!.label}」`);
      }

      case 'game': {
        const g = (rest[0] ?? '').trim();
        if (!g) {
          this.pushSystem(`可用游戏：${listGames().map((x) => `${x.id}(${x.name} ${x.min}-${x.max}人)`).join('  ')}`);
          return this.redraw();
        }
        return this.startGame(g);
      }

      case 'act': {
        if (!this.session) return this.toastMsg('当前没有进行中的游戏');
        const parts = rest;
        const actionType = parts[0] ?? '';
        const payload: Record<string, unknown> = {};
        if (parts[1]) {
          const t = this.members.find((m) => m.nick === parts[1] || m.id.startsWith(parts[1]!));
          if (t) payload['target'] = t.id;
          else payload['value'] = parts[1];
        }
        this.applyGameAction({ by: this.selfId, type: actionType, payload });
        return this.redraw();
      }

      case 'id':
        this.pushSystem(`你的 ID：${this.selfId}`);
        for (const l of randomart(this.identity.publicKey).split('\n')) this.pushSystem(l);
        return this.redraw();

      case 'invite': {
        const name = argStr.trim() || '我的房间';
        const pass = await this.askPassphrase(name, true);
        this.pushSystem(makeInvite(name, pass));
        return this.redraw();
      }

      default:
        return this.toastMsg(`未知命令：/${cmd}（/help 查看全部）`);
    }
  }

  private toastMsg(msg: string): void {
    this.toast = msg;
    this.toastUntil = Date.now() + 4000;
    this.redraw();
  }

  /* ================= 房间 ================= */

  private hostRoom(name: string, pass: string): void {
    const roomId = roomIdFrom(name, pass);
    const hub = new Hub({ roomId, roomName: name, passphrase: pass, maxPeers: 1000, requirePassphrase: false });
    const server = new TcpHubServer(hub);
    void server
      .listen(DEFAULT_PORT, '0.0.0.0')
      .then((port: number) => {
        this.hub = hub;
        this.pushSystem(`已在本机托管房间「${name}」（端口 ${port}，星型拓扑，上限 1000 人）`);
        this.discovery?.setAnnounce({
          roomId,
          port,
          transports: ['tcp'],
          peerCount: 1,
          secured: Boolean(pass),
        });
        return this.joinRoom(name, pass, `127.0.0.1:${port}`);
      })
      .catch((e: Error) => this.toastMsg(`托管失败：${e.message}`));
  }

  private async joinRoom(name: string, pass: string, hubAddr?: string): Promise<void> {
    const target = hubAddr ?? (await this.resolveHub(name));
    if (!target) {
      return this.toastMsg(`找不到房间「${name}」。确认对方已 /host，且你们在同一网络。`);
    }
    const { host, port } = parseHostPort(target, DEFAULT_PORT);
    const roomId = roomIdFrom(name, pass);

    const peer = new Peer({
      peerId: this.selfId,
      nickname: this.cfg.nick,
      roomId,
      passphrase: pass,
    });

    peer.on('ready', ({ members }: { members: RoomMember[] }) => {
      this.members = members;
      this.pushSystem(`已加入「${name}」· ${members.length} 人在线 · 端到端加密已启用`);
      this.attachPeer(peer, name, pass);
      this.redraw();
    });
    peer.on('presence', (m: RoomMember[]) => {
      this.members = m;
      this.redraw();
    });
    peer.on('error', (e: Error) => this.toastMsg(`连接错误：${e.message}`));
    peer.on('disconnected', () => this.toastMsg('连接已断开'));
    peer.on('decrypt-failed', () => {
      this.pushSystem('⚠ 收到一条无法解密的消息（口令不一致？）');
      this.redraw();
    });

    try {
      const t = await TcpTransport.connect(host, port, 6000);
      peer.attach(t);
    } catch (e) {
      this.toastMsg(`连不上 ${host}:${port} —— ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private attachPeer(peer: Peer, roomName: string, pass: string): void {
    this.peer = peer;
    rememberRoom(roomName, pass);

    this.files = new FileTransfer(peer, this.cfg.downloadDir);
    this.files.setHandlers({
      onOffer: (o) => {
        this.pushSystem(`📥 ${o.fromNick} 发来文件 ${o.name}（${formatBytes(o.size)}）—— 自动接收校验中`);
        this.redraw();
      },
      onComplete: (i) => {
        this.push({ nick: '系统', authorId: 'system', text: `✅ 文件已保存：${i.path}`, ts: Date.now(), system: true });
        this.redraw();
      },
      onError: (m) => this.toastMsg(m),
      onProgress: () => this.redraw(),
    });

    this.polls = new PollManager(peer, (t) => this.pushSystem(t));

    peer.on('message', (msg: Record<string, unknown>) => this.handleMessage(msg));
  }

  private handleMessage(msg: Record<string, unknown>): void {
    const t = msg['t'] as string;
    switch (t) {
      case 'chat':
        this.push({
          nick: String(msg['nick'] ?? '?'),
          authorId: String(msg['from'] ?? ''),
          text: String(msg['text'] ?? ''),
          ts: Number(msg['ts'] ?? Date.now()),
        });
        break;
      case 'dm':
        this.push({
          nick: `🔒 ${String(msg['nick'] ?? '?')}`,
          authorId: String(msg['from'] ?? ''),
          text: String(msg['text'] ?? ''),
          ts: Number(msg['ts'] ?? Date.now()),
          dm: true,
        });
        break;
      case 'system':
        this.pushSystem(String(msg['text'] ?? ''));
        break;
      case 'typing': {
        const id = String(msg['from'] ?? '');
        if (!this.typing.includes(id)) this.typing.push(id);
        setTimeout(() => {
          this.typing = this.typing.filter((x) => x !== id);
          this.redraw();
        }, 3000);
        break;
      }
      case 'file-offer':
        this.files?.handleOffer(msg as never);
        break;
      case 'file-chunk':
        this.files?.handleChunk(msg as never);
        break;
      case 'poll-create':
        this.polls?.handleCreate(msg as never);
        break;
      case 'poll-vote':
        this.polls?.handleVote(msg as never);
        break;
      case 'game': {
        const a = {
          by: String(msg['from'] ?? ''),
          type: String(msg['action'] ?? ''),
          payload: msg['payload'] as Record<string, unknown> | undefined,
        };
        if (a.by !== this.selfId) this.applyGameAction(a, false);
        break;
      }
      default:
        break;
    }
    this.redraw();
  }

  private async resolveHub(roomHash: string): Promise<string | null> {
    const r = this.rooms.find((x) => x.roomHash === roomHash);
    return r ? `${r.host}:${r.port}` : null;
  }

  /* ================= 游戏 ================= */

  private startGame(id: string): void {
    const def = getGame(id as Parameters<typeof getGame>[0]);
    if (!def) {
      return this.toastMsg(`没有这个游戏。可用：${listGames().map((g) => g.id).join(' / ')}`);
    }
    const players = this.members.length ? this.members : [{ id: this.selfId, nick: this.cfg.nick }];
    if (players.length < def.minPlayers) {
      return this.toastMsg(`${def.name} 至少需要 ${def.minPlayers} 人（当前 ${players.length}）`);
    }
    const seed = Date.now() >>> 0;
    this.session = GameSession.create(def, players.slice(0, def.maxPlayers), seed);
    this.gameId = id;
    this.peer?.send({
      t: 'game',
      id: `g${seed}`,
      from: this.selfId,
      game: id,
      action: 'start',
      payload: { seed },
      ts: Date.now(),
    });
    this.pushSystem(`🎮 ${def.name} 开局！${players.length} 人参与。用 /act <动作> [目标] 行动。`);
    this.pushSystem(this.session.current.log.slice(-3).map((l) => l.text).join('\n'));
    this.redraw();
  }

  private applyGameAction(a: GameAction, broadcast = true): void {
    if (!this.session) return;
    const ok = this.session.apply(a);
    if (!ok) {
      this.toastMsg(`无效动作：${a.type}`);
      return;
    }
    if (broadcast && this.peer) {
      this.peer.send({
        t: 'game',
        id: `g${Date.now()}`,
        from: this.selfId,
        game: this.gameId ?? '',
        action: a.type,
        payload: a.payload,
        ts: Date.now(),
      });
    }
    const tail = this.session.current.log.slice(-3);
    for (const l of tail) if (!this.seenLog.has(l.text)) this.pushSystem(l.text);
    if (this.session.isOver()) {
      const w = this.session.current.winners ?? [];
      const names = w.map((id) => this.members.find((m) => m.id === id)?.nick ?? id.slice(0, 6));
      this.pushSystem(`🏁 游戏结束，胜者：${names.join('、') || '无'}`);
    }
    this.redraw();
  }

  private seenLog = new Set<string>();

  /* ================= 消息缓冲 ================= */

  private push(l: ChatDraft): void {
    this.messages.push(mkLine(l));
    if (this.messages.length > 800) this.messages.shift();
    if (l.system) this.seenLog.add(l.text);
  }

  private pushSystem(text: string): void {
    for (const line of text.split('\n')) {
      this.push({ nick: '', authorId: 'system', text: line, ts: Date.now(), system: true });
    }
  }

  /* ================= 渲染 ================= */

  private redraw(): void {
    if (!this.running) return;
    const { width, height } = this.terminalSize();
    if (Date.now() > this.toastUntil) this.toast = null;

    const state: ScreenState = {
      ctx: { width, height, theme: this.theme, mode: this.mode },
      header: {
        roomName: this.peer ? '已连接房间' : '未连接',
        roomId: this.selfId,
        peerCount: this.members.length,
        transport: this.peer ? 'tcp' : '-',
        nick: this.cfg.nick,
        selfId: this.selfId,
        encrypted: Boolean(this.peer),
        status: this.gameId ? `🎮 ${this.gameId}` : undefined,
      },
      messages: this.messages.map((m) => mkLine(m)),
      members: this.members,
      input: this.input,
      scroll: this.scroll,
      toast: this.toast,
      planet: this.planet as ScreenState['planet'],
      t: (Date.now() - this.t0) / 1000,
      typing: this.typing,
      gamePanel: this.session ? this.renderGamePanel() : undefined,
      pollPanel: this.polls?.active ? this.polls.render(this.polls.active, Math.min(46, width - 40)) : undefined,
    };

    this.screenState = state;
    this.chatScreen = new ChatScreen(state);

    const out = this.chatScreen.render();
    // 覆盖层：房间浏览 / 帮助
    const overlay = this.menuMode === 'rooms' ? this.renderRoomsOverlay(width, height) : '';

    const buf = overlay ? this.composite(out, overlay, width, height) : out;
    process.stdout.write(cursor.home + buf);
  }

  private renderRoomsOverlay(width: number, height: number): string {
    const rows: RoomRow[] = this.rooms.map((r) => ({
      name: this.roomLabel(r),
      host: r.host,
      port: r.port,
      peers: r.peerCount ?? 0,
      secured: r.secured,
      freshness: r.freshness,
      transports: r.transports,
    }));
    const body = rows.length ? renderRoomList({ width, height, theme: this.theme, mode: this.mode }, rows, this.roomIndex) : '  扫描中…（未发现房间则试试 /host）';
    const lines = ['', '  局域网房间（↑↓ 选择，Enter 加入，Esc 关闭）', '', body, '', '  提示：确保所有人在同一个 WiFi / 手机热点下'];
    const f = new Frame({ width: Math.min(width, 72), height: Math.min(height - 4, lines.length + 2), bg: this.theme.bg });
    f.box(0, 0, f.width, f.height, { fg: this.theme.accent }, 'double');
    lines.forEach((l, i) => f.text(2, i + 1, truncate(l, f.width - 4), { fg: i === 2 ? this.theme.fg : this.theme.dim }));
    return f.render(this.mode);
  }

  private composite(base: string, overlay: string, width: number, height: number): string {
    // 把 overlay 居中叠到 base 上（按行替换）。
    // base 行内含 ANSI，所以拼接必须按「列」切，不能用 String.slice。
    const baseLines = base.split('\n');
    const ovLines = overlay.split('\n');
    const ovW = ovLines.length ? Math.max(...ovLines.map((l) => displayWidth(l))) : 0;
    const top = Math.max(0, Math.floor((height - ovLines.length) / 2));
    const left = Math.max(0, Math.floor((width - ovW) / 2));
    for (let i = 0; i < ovLines.length && top + i < height; i++) {
      const row = baseLines[top + i];
      if (row === undefined) continue;
      const ovl = ovLines[i]!;
      const head = sliceByWidth(row, 0, left);
      const tail = sliceByWidth(row, left + displayWidth(ovl), width);
      baseLines[top + i] = head + ovl + tail;
    }
    return baseLines.join('\n');
  }

  private renderGamePanel(): string {
    if (!this.session) return '';
    const st = this.session.current;
    const view = this.session.view(this.selfId);
    const lines: string[] = [];
    lines.push(`🎮 ${String(view.board?.['turn'] ?? st.turn)}`);
    if (view.ascii) lines.push(...view.ascii.split('\n').slice(0, 10));
    return lines.join('\n');
  }

  /* ================= 口令输入 ================= */

  private async askPassphrase(_room: string, forInvite = false): Promise<string> {
    // 简单实现：交互模式下引导用 /invite 生成；非交互用环境变量
    const envPass = process.env['ASTRAL_PASS'];
    if (envPass) return envPass;
    if (forInvite) return randomPass();
    return ''; // 空口令也能建房间（仅本地可信网络推荐）
  }
}

function randomPass(): string {
  const words = ['星尘', '木星', '土环', '猎户', '天狼', '织女', '虫洞', '彗星', '银河', '星云'];
  const a = words[Math.floor(Math.random() * words.length)]!;
  const b = Math.floor(Math.random() * 9000 + 1000);
  return `${a}-${b}`;
}

function defaultNick(): string {
  const u = process.env['USER'] ?? process.env['USERNAME'] ?? 'traveler';
  const hosts = ['水星', '金星', '火星', '木星', '土星', '天王', '海王'];
  return `${u}@${hosts[Math.floor(Math.random() * hosts.length)]}`;
}

export const interactive = { runInteractive };
export default interactive;
