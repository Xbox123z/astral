/**
 * 游戏引擎骨架。
 *
 * 三款游戏（狼人杀 / 三国杀 / 大富翁跳棋）共享同一套模型，这样：
 *   1. 状态同步、回放、断线重连只写一次；
 *   2. 房间里的游戏都能用同一条消息管道（AppMessage.t === 'game'）；
 *   3. 渲染层只需实现一个 render(state) 就能接入 TUI。
 *
 * 核心约定：
 *   - 所有状态转移由 **动作（Action）** 驱动，动作是纯数据（可序列化、可加密传输）。
 *   - `reduce(state, action)` 是纯函数：同状态 + 同动作 = 同结果（确定性）。
 *   - 随机性一律走 `state.rngSeed`，禁止 Math.random()，保证各端同步。
 *   - 每个游戏声明哪些阶段需要哪些玩家输入，引擎负责收集与超时。
 */

import { Rng } from '../lib/rng.js';

export type GameId = 'werewolf' | 'sanguosha' | 'monopoly';

export interface GamePlayer {
  id: string;
  nick: string;
  /** 是否已准备 */
  ready: boolean;
  /** 座位号 */
  seat: number;
  /** 是否还活着 / 未出局 */
  alive: boolean;
}

export interface GameAction {
  /** 谁发起 */
  by: string;
  /** 动作类型，各游戏自定义 */
  type: string;
  /** 动作参数 */
  payload?: Record<string, unknown>;
  /** 客户端时间戳（仅用于展示，不参与状态推导） */
  ts?: number;
}

export type GamePhase =
  | 'lobby'
  | 'dealing'
  | 'playing'
  | 'voting'
  | 'resolving'
  | 'finished';

export interface GameState {
  id: GameId;
  phase: GamePhase;
  /** 回合数 */
  turn: number;
  /** 当前该谁行动（玩家 id 列表，支持多人同时行动） */
  pending: string[];
  players: GamePlayer[];
  /** 日志（给所有人的公开部分） */
  log: LogEntry[];
  /** 随机种子：所有随机都从这里派生，保证各端一致 */
  rngSeed: number;
  /** 游戏自定义数据 */
  data: Record<string, unknown>;
  /** 胜方（phase=finished 时有效） */
  winners?: string[];
}

export interface LogEntry {
  turn: number;
  /** 可见范围：all / 单个玩家 id / 角色组 */
  visibility: 'all' | string[] | string;
  text: string;
  ts: number;
}

export interface GameView {
  /** 给特定玩家看的私有视图（狼人杀里各人看到的身份不同） */
  you?: Record<string, unknown>;
  /** 公开视图 */
  board: Record<string, unknown>;
  /** 当前需要你做什么（用于 UI 提示） */
  prompt?: {
    kind: 'choose' | 'vote' | 'confirm' | 'text';
    question: string;
    options?: { value: string; label: string; disabled?: boolean }[];
  };
  /** 渲染用的 ASCII 画面 */
  ascii?: string;
}

export interface GameDefinition<S extends GameState = GameState> {
  id: GameId;
  name: string;
  minPlayers: number;
  maxPlayers: number;
  description: string;

  /** 初始化状态（发牌、分座位） */
  setup(playerIds: { id: string; nick: string }[], seed?: number): S;

  /** 状态转移：必须是纯函数 */
  reduce(state: S, action: GameAction): S;

  /** 生成某个玩家看到的视图 */
  view(state: S, viewerId: string): GameView;

  /** 是否结束 */
  isOver(state: S): boolean;

  /** 结束时的胜方 */
  winners(state: S): string[];
}

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

/** 从状态派生一个确定性 RNG（不修改状态） */
export function rngFor(state: GameState, tag: string): Rng {
  return new Rng(`${state.rngSeed}:${tag}:${state.turn}`);
}

/** 追加一条公开日志 */
export function logAll(state: GameState, text: string): void {
  state.log.push({ turn: state.turn, visibility: 'all', text, ts: Date.now() });
  if (state.log.length > 300) state.log.splice(0, state.log.length - 300);
}

/** 追加一条仅某人可见的日志 */
export function logTo(state: GameState, who: string, text: string): void {
  state.log.push({ turn: state.turn, visibility: who, text, ts: Date.now() });
}

/** 过滤出某人能看到的日志 */
export function visibleLog(state: GameState, viewerId: string): LogEntry[] {
  return state.log.filter((l) => {
    if (l.visibility === 'all') return true;
    if (Array.isArray(l.visibility)) return l.visibility.includes(viewerId);
    return l.visibility === viewerId;
  });
}

/** 座位顺序上的下一个存活玩家 */
export function nextAlive(state: GameState, afterId: string): string | null {
  const sorted = [...state.players].sort((a, b) => a.seat - b.seat);
  const idx = sorted.findIndex((p) => p.id === afterId);
  for (let i = 1; i <= sorted.length; i++) {
    const p = sorted[(idx + i) % sorted.length]!;
    if (p.alive) return p.id;
  }
  return null;
}

export function alivePlayers(state: GameState): GamePlayer[] {
  return state.players.filter((p) => p.alive);
}

export function playerById(state: GameState, id: string): GamePlayer | undefined {
  return state.players.find((p) => p.id === id);
}

/** 简单多数投票统计 */
export function tallyVotes(votes: Record<string, string>): { target: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const target of Object.values(votes)) {
    counts.set(target, (counts.get(target) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([target, count]) => ({ target, count }))
    .sort((a, b) => b.count - a.count);
}

/** 找出得票最多者；平票返回 null 由上层处理（如狼人杀平票重投） */
export function topVoted(votes: Record<string, string>): { target: string; count: number; tie: boolean } | null {
  const t = tallyVotes(votes);
  if (t.length === 0) return null;
  const tie = t.length > 1 && t[0]!.count === t[1]!.count;
  return { target: t[0]!.target, count: t[0]!.count, tie };
}

/**
 * 游戏会话：把「定义 + 状态 + 动作历史」包起来。
 * 支持从动作历史重放（断线重连 / 观战 / 争议仲裁）。
 */
export class GameSession<S extends GameState = GameState> {
  private state: S;
  private history: GameAction[] = [];

  constructor(private def: GameDefinition<S>, initial: S) {
    this.state = initial;
  }

  static create<S extends GameState>(
    def: GameDefinition<S>,
    players: { id: string; nick: string }[],
    seed?: number,
  ): GameSession<S> {
    return new GameSession(def, def.setup(players, seed));
  }

  get current(): S {
    return this.state;
  }

  get actions(): readonly GameAction[] {
    return this.history;
  }

  get definition(): GameDefinition<S> {
    return this.def;
  }

  /** 应用一个动作；返回是否改变了状态 */
  apply(action: GameAction): boolean {
    const before = this.state;
    const after = this.def.reduce(before, action);
    if (after === before) return false;
    this.state = after;
    this.history.push(action);
    if (this.def.isOver(after)) {
      after.phase = 'finished';
      after.winners = this.def.winners(after);
    }
    return true;
  }

  view(viewerId: string): GameView {
    return this.def.view(this.state, viewerId);
  }

  isOver(): boolean {
    return this.def.isOver(this.state);
  }

  /** 从历史重放（用于重连同步） */
  replay(actions: GameAction[]): void {
    for (const a of actions) this.apply(a);
  }
}

/** 注册表：房间通过它按名字开局 */
const REGISTRY = new Map<GameId, GameDefinition>();

export function registerGame(def: GameDefinition): void {
  REGISTRY.set(def.id, def);
}

export function getGame(id: GameId): GameDefinition | undefined {
  return REGISTRY.get(id);
}

export function listGames(): { id: GameId; name: string; min: number; max: number; description: string }[] {
  return Array.from(REGISTRY.values()).map((d) => ({
    id: d.id,
    name: d.name,
    min: d.minPlayers,
    max: d.maxPlayers,
    description: d.description,
  }));
}

export const engine = {
  GameSession,
  registerGame,
  getGame,
  listGames,
  rngFor,
  logAll,
  logTo,
  visibleLog,
  nextAlive,
  alivePlayers,
  playerById,
  tallyVotes,
  topVoted,
};
export default engine;
