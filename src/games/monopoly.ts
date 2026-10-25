/**
 * 大富翁跳棋（Monopoly / 强手棋）。
 *
 * 用户原话是「大富翁跳棋」，因此做成**跳棋式棋盘 + 大富翁经济**的混合：
 *  - 棋盘是环形 28 格，玩家掷骰前进（跳棋的「走子」手感）
 *  - 落格触发地产购买/收租/机会/税收（大富翁的经济系统）
 *  - 破产出局，最后剩余者获胜
 *
 * 与狼人杀不同，这局所有人看到同样的棋盘，所以 view() 无私有信息。
 * 随机走 rngFor(state, 'dice')，各端同步。
 */

import {
  logAll,
  rngFor,
  alivePlayers,
  registerGame,
  type GameAction,
  type GameDefinition,
  type GameState,
  type GameView,
  type GamePlayer,
} from './engine.js';

export type CellKind = 'start' | 'property' | 'chance' | 'tax' | 'jail' | 'free' | 'gotojail' | 'utility';

export interface BoardCell {
  index: number;
  kind: CellKind;
  name: string;
  /** 地价（property / utility） */
  price?: number;
  /** 基础租金 */
  rent?: number;
  /** 所属阵营色（用于终端着色） */
  color?: string;
  /** 拥有者 */
  owner?: string | null;
  /** 是否已建房（提升租金） */
  houses?: number;
}

export interface MonopolyData {
  board: BoardCell[];
  positions: Record<string, number>;
  cash: Record<string, number>;
  /** 本回合是否已掷骰 */
  rolled: boolean;
  /** 最后一次骰子 */
  dice: [number, number] | null;
  /** 连续双数（三次进监狱） */
  doubles: number;
  inJail: Record<string, number>;
  /** 等待购买决策的玩家 */
  awaitingBuy: string | null;
  /** 破产顺序 */
  bankrupt: string[];
}

export type MonopolyState = GameState & { data: MonopolyData };

export const BOARD_SIZE = 28;

const PROPERTY_NAMES: { name: string; price: number; rent: number; color: string; kind: CellKind }[] = [
  { name: '水星港', price: 60, rent: 6, color: '#7a6a5a', kind: 'property' },
  { name: '金星矿', price: 80, rent: 8, color: '#c9a86a', kind: 'property' },
  { name: '地球站', price: 100, rent: 10, color: '#4a8ad0', kind: 'property' },
  { name: '火星城', price: 120, rent: 12, color: '#c85a3a', kind: 'property' },
  { name: '木星带', price: 140, rent: 14, color: '#d6a06e', kind: 'property' },
  { name: '土星环', price: 160, rent: 16, color: '#e9d6a8', kind: 'property' },
  { name: '天王星', price: 180, rent: 18, color: '#94e0e2', kind: 'property' },
  { name: '海王星', price: 200, rent: 20, color: '#3f76f2', kind: 'property' },
  { name: '冥王星', price: 220, rent: 22, color: '#8a7a9a', kind: 'property' },
  { name: '空间站', price: 150, rent: 15, color: '#66ccff', kind: 'utility' },
  { name: '小行星带', price: 240, rent: 24, color: '#9a8a7a', kind: 'property' },
  { name: '彗星港', price: 260, rent: 26, color: '#aaccff', kind: 'property' },
  { name: '虫洞站', price: 150, rent: 15, color: '#66ccff', kind: 'utility' },
  { name: '猎户座', price: 300, rent: 30, color: '#ff8844', kind: 'property' },
  { name: '天狼星', price: 320, rent: 32, color: '#aad4ff', kind: 'property' },
  { name: '织女星', price: 350, rent: 35, color: '#ddd0ff', kind: 'property' },
];

export function buildBoard(): BoardCell[] {
  const cells: BoardCell[] = [];
  cells.push({ index: 0, kind: 'start', name: '起点', owner: null, houses: 0 });
  let p = 0;
  for (let i = 1; i < BOARD_SIZE; i++) {
    if (i === 7) {
      cells.push({ index: i, kind: 'chance', name: '机会', owner: null, houses: 0 });
      continue;
    }
    if (i === 14) {
      cells.push({ index: i, kind: 'gotojail', name: '入狱', owner: null, houses: 0 });
      continue;
    }
    if (i === 21) {
      cells.push({ index: i, kind: 'jail', name: '监狱/探监', owner: null, houses: 0 });
      continue;
    }
    if (i % 5 === 0 && i % 10 !== 0) {
      cells.push({ index: i, kind: 'tax', name: `星税 ${i * 4}`, owner: null, houses: 0 });
      continue;
    }
    const prop = PROPERTY_NAMES[p % PROPERTY_NAMES.length]!;
    p++;
    cells.push({
      index: i,
      kind: prop.kind,
      name: prop.name,
      price: prop.price,
      rent: prop.rent,
      color: prop.color,
      owner: null,
      houses: 0,
    });
  }
  return cells;
}

export const START_CASH = 1500;

const def: GameDefinition<MonopolyState> = {
  id: 'monopoly',
  name: '大富翁跳棋',
  minPlayers: 2,
  maxPlayers: 8,
  description: '掷骰走子、购地收租、机会与税收，最后不破产者获胜。',

  setup(playerIds, seed) {
    const rng = rngFor({ rngSeed: seed ?? Date.now(), turn: 0 } as GameState, 'seats');
    const players: GamePlayer[] = rng.shuffle([...playerIds]).map((p, i) => ({
      id: p.id,
      nick: p.nick,
      seat: i,
      ready: true,
      alive: true,
    }));
    const positions: Record<string, number> = {};
    const cash: Record<string, number> = {};
    const inJail: Record<string, number> = {};
    for (const p of players) {
      positions[p.id] = 0;
      cash[p.id] = START_CASH;
      inJail[p.id] = 0;
    }
    const state: MonopolyState = {
      id: 'monopoly',
      phase: 'playing',
      turn: 0,
      pending: [players[0]!.id],
      players,
      log: [],
      rngSeed: seed ?? Date.now(),
      data: {
        board: buildBoard(),
        positions,
        cash,
        rolled: false,
        dice: null,
        doubles: 0,
        inJail,
        awaitingBuy: null,
        bankrupt: [],
      },
    };
    logAll(state, `开局！每人 ${START_CASH} 星币。${players[0]!.nick} 先走。`);
    return state;
  },

  reduce(state, action) {
    const s: MonopolyState = JSON.parse(JSON.stringify(state)) as MonopolyState;
    const me = action.by;
    if (!alivePlayers(s).some((p) => p.id === me)) return state;

    switch (action.type) {
      /* ---------------- 掷骰 ---------------- */
      case 'roll': {
        if (s.pending[0] !== me) return state;
        if (s.data.rolled) return state;
        const rng = rngFor(s, `dice:${me}:${s.turn}`);
        const d1 = rng.int(1, 6);
        const d2 = rng.int(1, 6);
        s.data.dice = [d1, d2];
        s.data.rolled = true;
        const sum = d1 + d2;
        const isDouble = d1 === d2;

        // 在监狱：需要双数才能出来
        if (s.data.inJail[me]! > 0) {
          if (isDouble) {
            s.data.inJail[me] = 0;
            logAll(s, `${nickOf(s, me)} 掷出双数 ${d1}/${d2}，出狱！`);
          } else {
            s.data.inJail[me] = s.data.inJail[me]! - 1;
            logAll(s, `${nickOf(s, me)} 未能掷出双数，仍在狱中（剩 ${s.data.inJail[me]} 回合）`);
            endTurn(s);
            return s;
          }
        }

        move(s, me, sum);
        logAll(s, `${nickOf(s, me)} 掷出 ${d1}+${d2}=${sum}，走到 ${s.data.board[s.data.positions[me]!]!.name}`);

        if (isDouble) {
          s.data.doubles += 1;
          if (s.data.doubles >= 3) {
            s.data.inJail[me] = 2;
            s.data.positions[me] = 21;
            s.data.doubles = 0;
            logAll(s, `${nickOf(s, me)} 连续三次双数，入狱！`);
            endTurn(s);
            return s;
          }
          s.data.rolled = false; // 双数可再掷一次
          logAll(s, `${nickOf(s, me)} 掷出双数，可以再掷一次`);
          return s;
        }
        s.data.doubles = 0;
        return s;
      }

      /* ---------------- 购买 ---------------- */
      case 'buy': {
        if (s.data.awaitingBuy !== me) return state;
        const cell = s.data.board[s.data.positions[me]!]!;
        // 买不起（或格子已有人/不可购买）时自动放弃，而不是把玩家卡死在这里。
        // 否则 awaitingBuy 永远停在该玩家身上，游戏无法推进。
        if (!cell.owner && cell.price !== undefined && s.data.cash[me]! >= cell.price) {
          s.data.cash[me] = s.data.cash[me]! - cell.price;
          cell.owner = me;
          logAll(s, `${nickOf(s, me)} 以 ${cell.price} 买下 ${cell.name}`);
        } else if (!cell.owner && cell.price !== undefined) {
          logAll(s, `${nickOf(s, me)} 现金不足，放弃购买 ${cell.name}`);
        }
        s.data.awaitingBuy = null;
        endTurn(s);
        return s;
      }

      case 'decline': {
        if (s.data.awaitingBuy !== me) return state;
        const cell = s.data.board[s.data.positions[me]!]!;
        logAll(s, `${nickOf(s, me)} 放弃购买 ${cell.name}`);
        s.data.awaitingBuy = null;
        endTurn(s);
        return s;
      }

      /* ---------------- 建房 ---------------- */
      case 'build': {
        const cellIdx = Number(action.payload?.cell ?? -1);
        const cell = s.data.board[cellIdx];
        if (!cell || cell.owner !== me || cell.houses === undefined) return state;
        if (cell.houses >= 4) return state;
        const cost = Math.round((cell.price ?? 100) * 0.5);
        if (s.data.cash[me]! < cost) return state;
        s.data.cash[me] = s.data.cash[me]! - cost;
        cell.houses += 1;
        logAll(s, `${nickOf(s, me)} 在 ${cell.name} 建房（${cell.houses} 级）`);
        return s;
      }

      case 'end-turn': {
        if (s.pending[0] !== me) return state;
        endTurn(s);
        return s;
      }

      default:
        return state;
    }
  },

  view(state, viewerId) {
    const alive = alivePlayers(state);
    const myTurn = state.pending[0] === viewerId;
    const cell = state.data.board[state.data.positions[viewerId] ?? 0];
    let prompt: GameView['prompt'];
    if (state.data.awaitingBuy === viewerId && cell) {
      prompt = {
        kind: 'confirm',
        question: `是否以 ${cell.price} 购买 ${cell.name}？（基础租金 ${cell.rent}）`,
        options: [
          { value: 'buy', label: '购买' },
          { value: 'decline', label: '放弃' },
        ],
      };
    } else if (myTurn && !state.data.rolled) {
      prompt = {
        kind: 'confirm',
        question: '轮到你了，掷骰？',
        options: [{ value: 'roll', label: '掷骰' }],
      };
    } else if (myTurn && state.data.rolled) {
      prompt = {
        kind: 'confirm',
        question: '结束回合？',
        options: [{ value: 'end-turn', label: '结束回合' }],
      };
    }

    return {
      you: {
        cash: state.data.cash[viewerId],
        position: state.data.positions[viewerId],
        inJail: state.data.inJail[viewerId] ?? 0,
        properties: state.data.board
          .filter((c) => c.owner === viewerId)
          .map((c) => ({ name: c.name, houses: c.houses ?? 0, rent: currentRent(c) })),
      },
      board: {
        cells: state.data.board.map((c) => ({
          i: c.index,
          name: c.name,
          kind: c.kind,
          owner: c.owner ? nickOf(state, c.owner) : null,
          houses: c.houses ?? 0,
        })),
        players: alive.map((p) => ({
          nick: p.nick,
          pos: state.data.positions[p.id],
          cash: state.data.cash[p.id],
          jail: state.data.inJail[p.id] ?? 0,
        })),
        dice: state.data.dice,
        turn: state.turn,
      },
      prompt,
      ascii: renderBoard(state, viewerId),
    };
  },

  isOver(state) {
    return alivePlayers(state).length <= 1;
  },

  winners(state) {
    const alive = alivePlayers(state);
    if (alive.length === 0) {
      // 全部破产（极端情况：最后一回合同时扣费）。按净资产排序取第一。
      const all = [...state.players].sort((a, b) => netWorth(state, b.id) - netWorth(state, a.id));
      return all.length ? [all[0]!.id] : [];
    }
    if (alive.length === 1) return [alive[0]!.id];
    // 多人仍在（提前结束）：资产最高者胜
    let best = alive[0]!;
    let bestVal = -Infinity;
    for (const p of alive) {
      const v = netWorth(state, p.id);
      if (v > bestVal) {
        bestVal = v;
        best = p;
      }
    }
    return [best.id];
  },
};

/* ------------------------------------------------------------------ */
/* 规则实现                                                            */
/* ------------------------------------------------------------------ */

function nickOf(state: MonopolyState, id: string): string {
  return state.players.find((p) => p.id === id)?.nick ?? id.slice(0, 6);
}

export function currentRent(cell: BoardCell): number {
  const base = cell.rent ?? 0;
  return Math.round(base * (1 + (cell.houses ?? 0) * 0.8));
}

export function netWorth(state: MonopolyState, id: string): number {
  let v = state.data.cash[id] ?? 0;
  for (const c of state.data.board) {
    if (c.owner === id) v += (c.price ?? 0) + (c.houses ?? 0) * Math.round((c.price ?? 0) * 0.5);
  }
  return v;
}

/** 走子 + 落格结算 */
function move(state: MonopolyState, me: string, steps: number): void {
  const size = state.data.board.length;
  let pos = (state.data.positions[me]! + steps) % size;
  state.data.positions[me] = pos;
  const cell = state.data.board[pos]!;

  // 经过起点奖励
  if (pos < steps) {
    state.data.cash[me] = state.data.cash[me]! + 200;
    logAll(state, `${nickOf(state, me)} 经过起点，获得 200 星币`);
  }

  switch (cell.kind) {
    case 'property':
    case 'utility': {
      if (!cell.owner) {
        state.data.awaitingBuy = me;
        state.pending = [me];
        return;
      }
      if (cell.owner === me) {
        logAll(state, `${nickOf(state, me)} 回到自己的 ${cell.name}`);
        return;
      }
      const rent = currentRent(cell);
      pay(state, me, cell.owner, rent, `${cell.name} 的租金`);
      return;
    }

    case 'tax': {
      const amount = Number(cell.name.replace(/\D/g, '')) || 50;
      state.data.cash[me] = state.data.cash[me]! - amount;
      logAll(state, `${nickOf(state, me)} 缴纳星税 ${amount}`);
      checkBankrupt(state, me);
      return;
    }

    case 'chance': {
      applyChance(state, me);
      return;
    }

    case 'gotojail': {
      state.data.positions[me] = 21;
      state.data.inJail[me] = 2;
      logAll(state, `${nickOf(state, me)} 被送进监狱`);
      return;
    }

    case 'start': {
      state.data.cash[me] = state.data.cash[me]! + 100;
      logAll(state, `${nickOf(state, me)} 停在起点，获得 100 星币`);
      return;
    }

    default:
      return;
  }
}

function applyChance(state: MonopolyState, me: string): void {
  const rng = rngFor(state, `chance:${me}:${state.turn}`);
  const roll = rng.int(0, 99);
  if (roll < 25) {
    const gain = rng.int(50, 200);
    state.data.cash[me] = state.data.cash[me]! + gain;
    logAll(state, `机会：${nickOf(state, me)} 获得星际补贴 ${gain}`);
  } else if (roll < 50) {
    const loss = rng.int(50, 150);
    state.data.cash[me] = state.data.cash[me]! - loss;
    logAll(state, `机会：${nickOf(state, me)} 支付维修费 ${loss}`);
    checkBankrupt(state, me);
  } else if (roll < 70) {
    const target = rng.pick(alivePlayers(state).filter((p) => p.id !== me));
    if (target) {
      const amt = 100;
      pay(state, me, target.id, amt, '机会：星际转账');
    }
  } else if (roll < 85) {
    state.data.positions[me] = 0;
    state.data.cash[me] = state.data.cash[me]! + 200;
    logAll(state, `机会：${nickOf(state, me)} 直接回到起点并领取 200`);
  } else {
    state.data.positions[me] = 21;
    state.data.inJail[me] = 1;
    logAll(state, `机会：${nickOf(state, me)} 被巡逻队带走`);
  }
}

function pay(state: MonopolyState, from: string, to: string | null | undefined, amount: number, reason: string): void {
  if (!to) return;
  const have = state.data.cash[from] ?? 0;
  // 注意：不做 Math.min 截断。截断会让「付不起租金」变成「付 0 元」，
  // 于是一辈子不会破产，游戏永远打不完。规则是付不起就出局。
  state.data.cash[from] = have - amount;
  state.data.cash[to] = (state.data.cash[to] ?? 0) + amount;
  logAll(state, `${nickOf(state, from)} 向 ${nickOf(state, to)} 支付 ${amount}（${reason}）`);
  checkBankrupt(state, from);
}

function checkBankrupt(state: MonopolyState, id: string): void {
  if ((state.data.cash[id] ?? 0) >= 0) return;
  const p = state.players.find((x) => x.id === id);
  if (!p || !p.alive) return;
  p.alive = false;
  state.data.bankrupt.push(id);
  // 地产归还银行
  for (const c of state.data.board) {
    if (c.owner === id) {
      c.owner = null;
      c.houses = 0;
    }
  }
  logAll(state, `💥 ${nickOf(state, id)} 破产出局！`);
}

function endTurn(state: MonopolyState): void {
  state.data.rolled = false;
  state.data.dice = null;
  state.data.doubles = 0;
  state.data.awaitingBuy = null;
  state.turn += 1;

  const alive = alivePlayers(state);
  if (alive.length <= 1) {
    state.phase = 'finished';
    return;
  }

  // 每回合征收「轨道维护费」：随回合数递增的通胀压力。
  // 没有它，过路费收入 > 支出，游戏永远打不完（实测 300+ 回合无人破产）。
  const upkeep = 20 + Math.floor(state.turn / 4) * 10;
  for (const p of alive) {
    state.data.cash[p.id] = (state.data.cash[p.id] ?? 0) - upkeep;
  }
  if (state.turn % 4 === 0) {
    logAll(state, `轨道维护费上涨至 ${upkeep} 星币/回合`);
  }
  // 结算破产（可能在扣费后出现）
  for (const p of [...alive]) checkBankrupt(state, p.id);

  const stillAlive = alivePlayers(state);
  if (stillAlive.length <= 1) {
    state.phase = 'finished';
    return;
  }

  // 下一个存活玩家（按座位顺序）。
  // 注意：pending[0] 可能已经破产（例如本回合扣完维护费后出局），
  // 此时 findIndex 返回 -1，会错误地从 sorted[0] 开始找。所以要从
  // 「当前座位」出发向后找，找不到就整体扫描一遍。
  const sorted = [...state.players].sort((a, b) => a.seat - b.seat);
  const cur = state.pending[0];
  const curIdx = cur ? sorted.findIndex((p) => p.id === cur) : -1;
  const startFrom = curIdx >= 0 ? curIdx + 1 : 0;
  for (let i = 0; i < sorted.length; i++) {
    const cand = sorted[(startFrom + i) % sorted.length]!;
    if (cand.alive) {
      state.pending = [cand.id];
      return;
    }
  }
  state.phase = 'finished';
}

/* ------------------------------------------------------------------ */
/* ASCII 棋盘                                                          */
/* ------------------------------------------------------------------ */

/** 渲染环形棋盘为终端可读的方框 */
function renderBoard(state: MonopolyState, viewerId: string): string {
  const cells = state.data.board;
  const n = cells.length;
  // 四边布局：每边 n/4 格（取整后微调）
  const perSide = Math.max(2, Math.round(n / 4));
  const marks: Record<number, string[]> = {};
  for (const p of state.players) {
    if (!p.alive) continue;
    const pos = state.data.positions[p.id] ?? 0;
    (marks[pos] ??= []).push(p.id === viewerId ? '★' : '●');
  }

  const cellLabel = (c: BoardCell): string => {
    const m = marks[c.index] ? marks[c.index]!.join('') : ' ';
    let sym = '·';
    if (c.kind === 'start') sym = 'S';
    else if (c.kind === 'chance') sym = '?';
    else if (c.kind === 'tax') sym = 'T';
    else if (c.kind === 'jail') sym = 'J';
    else if (c.kind === 'gotojail') sym = '>';
    else if (c.owner) sym = '■';
    else sym = '□';
    return `${sym}${m}`;
  };

  const top: string[] = [];
  const bottom: string[] = [];
  const mid: string[] = [];
  for (let i = 0; i < perSide; i++) {
    top.push(cellLabel(cells[i]!));
  }
  for (let i = perSide; i < perSide * 2; i++) mid.push(cellLabel(cells[i]!));
  for (let i = perSide * 2; i < Math.min(n, perSide * 3); i++) bottom.push(cellLabel(cells[i]!));
  // 剩余格子放右边
  const right: string[] = [];
  for (let i = perSide * 3; i < n; i++) right.push(cellLabel(cells[i]!));

  const lines: string[] = [];
  lines.push('  ' + top.join(' '));
  lines.push('');
  // 中间两行：左边是 mid 的倒序，右边是 right
  const leftCol = [...mid].reverse();
  const rightCol = [...right];
  for (let i = 0; i < Math.max(leftCol.length, rightCol.length); i++) {
    const l = leftCol[i] ?? '  ';
    const r = rightCol[i] ?? '  ';
    lines.push(`  ${l}${' '.repeat(Math.max(4, top.join(' ').length - 8))}${r}`);
  }
  lines.push('');
  lines.push('  ' + [...bottom].reverse().join(' '));
  lines.push('');
  const me = state.players.find((p) => p.id === viewerId);
  lines.push(`  ★=你  现金 ${state.data.cash[viewerId] ?? 0}  位置 ${state.data.positions[viewerId] ?? 0}`);
  if (me && state.data.inJail[viewerId]! > 0) lines.push(`  你在狱中，还需 ${state.data.inJail[viewerId]} 回合`);
  return lines.join('\n');
}

registerGame(def as unknown as GameDefinition);

export const monopoly = { def, BOARD_SIZE, START_CASH, buildBoard, currentRent, netWorth };
export default monopoly;
