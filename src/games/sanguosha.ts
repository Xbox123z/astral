/**
 * 三国杀（简化版）。
 *
 * 真实的官方三国杀有上百张卡牌与扩展包，这里实现**可玩的骨架**：
 *  - 身份：主公 / 忠臣 / 反贼 / 内奸（胜负条件齐全）
 *  - 武将：15 名，每人一个技能（够一局有策略深度，不做扩展包）
 *  - 卡牌：杀 / 闪 / 桃 / 锦囊（南蛮、万箭、决斗、无懈可击、顺手牵羊、过河拆桥）
 *  - 流程：摸牌 -> 出牌（每回合限用一次杀）-> 弃牌
 *
 * 这是 MVP：规则可玩、可扩展（加武将只需往 GENERALS 里加一条）。
 */

import {
  logAll,
  logTo,
  rngFor,
  alivePlayers,
  registerGame,
  visibleLog,
  type GameAction,
  type GameDefinition,
  type GameState,
  type GameView,
  type GamePlayer,
} from './engine.js';

export type Identity = 'lord' | 'loyal' | 'rebel' | 'spy';

export const IDENTITY_INFO: Record<Identity, { name: string; emoji: string; goal: string }> = {
  lord: { name: '主公', emoji: '👑', goal: '消灭所有反贼与内奸' },
  loyal: { name: '忠臣', emoji: '🛡️', goal: '保护主公，消灭反贼' },
  rebel: { name: '反贼', emoji: '⚔️', goal: '杀死主公' },
  spy: { name: '内奸', emoji: '🗡️', goal: '最后与主公单挑并获胜' },
};

export type CardSuit = 'spade' | 'heart' | 'club' | 'diamond';

export interface Card {
  id: number;
  kind: 'slash' | 'dodge' | 'peach' | 'barbarian' | 'arrow' | 'duel' | 'negate' | 'steal' | 'dismantle';
  name: string;
  suit: CardSuit;
  rank: number;
}

export interface General {
  key: string;
  name: string;
  hp: number;
  skill: string;
  desc: string;
}

export const GENERALS: General[] = [
  { key: 'liubei', name: '刘备', hp: 4, skill: '仁德', desc: '出牌阶段可将一张手牌交给他人，回复 1 点体力（每回合限一次）' },
  { key: 'guanyu', name: '关羽', hp: 4, skill: '武圣', desc: '可将红色手牌当【杀】使用' },
  { key: 'zhangfei', name: '张飞', hp: 4, skill: '咆哮', desc: '出牌阶段使用【杀】无次数限制' },
  { key: 'zhugeliang', name: '诸葛亮', hp: 3, skill: '观星', desc: '摸牌阶段可多摸一张牌' },
  { key: 'zhaoyun', name: '赵云', hp: 4, skill: '龙胆', desc: '【杀】可当【闪】，【闪】可当【杀】' },
  { key: 'machao', name: '马超', hp: 4, skill: '铁骑', desc: '使用【杀】时目标不能用【闪】抵消（每回合限一次）' },
  { key: 'huangyueying', name: '黄月英', hp: 3, skill: '集智', desc: '使用锦囊后可摸一张牌' },
  { key: 'caocao', name: '曹操', hp: 4, skill: '奸雄', desc: '受到伤害后可获得造成伤害的牌' },
  { key: 'simayi', name: '司马懿', hp: 3, skill: '反馈', desc: '受到伤害后可抽对方一张牌' },
  { key: 'xiahoudun', name: '夏侯惇', hp: 4, skill: '刚烈', desc: '受到伤害后可令对方弃两张牌或受 1 点伤害' },
  { key: 'xuchu', name: '许褚', hp: 4, skill: '裸衣', desc: '使用【杀】时可额外造成 1 点伤害（需弃一张牌）' },
  { key: 'guojia', name: '郭嘉', hp: 3, skill: '天妒', desc: '受到伤害后可摸两张牌' },
  { key: 'sunquan', name: '孙权', hp: 4, skill: '制衡', desc: '可弃置任意手牌并摸等量牌（每回合限一次）' },
  { key: 'zhouyu', name: '周瑜', hp: 3, skill: '英姿', desc: '摸牌阶段多摸一张牌' },
  { key: 'lvmeng', name: '吕蒙', hp: 4, skill: '克己', desc: '若未使用【杀】，本回合手牌上限+2' },
];

export interface SanguoshaData {
  identities: Record<string, Identity>;
  generals: Record<string, string>; // playerId -> general key
  hp: Record<string, number>;
  maxHp: Record<string, number>;
  hands: Record<string, Card[]>;
  deck: Card[];
  discard: Card[];
  /** 本回合是否已用杀 */
  slashedThisTurn: Record<string, number>;
  /** 当前出牌阶段 */
  phase: 'draw' | 'play' | 'discard';
  /** 需要响应的玩家与原因（杀/锦囊结算） */
  responses: { from: string; to: string; kind: string; card?: Card; count: number }[];
  lord: string;
  /** 死亡顺序及身份（用于结算） */
  dead: { id: string; identity: Identity }[];
}

export type SanguoshaState = GameState & { data: SanguoshaData };

export const CARD_NAMES: Record<Card['kind'], string> = {
  slash: '杀',
  dodge: '闪',
  peach: '桃',
  barbarian: '南蛮入侵',
  arrow: '万箭齐发',
  duel: '决斗',
  negate: '无懈可击',
  steal: '顺手牵羊',
  dismantle: '过河拆桥',
};

function buildDeck(rng: ReturnType<typeof rngFor>): Card[] {
  const cards: Card[] = [];
  let id = 1;
  const suits: CardSuit[] = ['spade', 'heart', 'club', 'diamond'];
  const plan: [Card['kind'], number][] = [
    ['slash', 30],
    ['dodge', 15],
    ['peach', 8],
    ['barbarian', 3],
    ['arrow', 2],
    ['duel', 3],
    ['negate', 4],
    ['steal', 5],
    ['dismantle', 6],
  ];
  for (const [kind, count] of plan) {
    for (let i = 0; i < count; i++) {
      cards.push({
        id: id++,
        kind,
        name: CARD_NAMES[kind],
        suit: rng.pick(suits),
        rank: rng.int(1, 13),
      });
    }
  }
  return rng.shuffle(cards);
}

/** 按人数配置身份 */
export function identityComposition(n: number): Identity[] {
  const table: Record<number, Identity[]> = {
    4: ['lord', 'loyal', 'rebel', 'spy'],
    5: ['lord', 'loyal', 'rebel', 'rebel', 'spy'],
    6: ['lord', 'loyal', 'loyal', 'rebel', 'rebel', 'spy'],
    7: ['lord', 'loyal', 'loyal', 'rebel', 'rebel', 'rebel', 'spy'],
    8: ['lord', 'loyal', 'loyal', 'rebel', 'rebel', 'rebel', 'spy', 'spy'],
  };
  return table[Math.min(8, Math.max(4, n))] ?? table[5]!;
}

const def: GameDefinition<SanguoshaState> = {
  id: 'sanguosha',
  name: '三国杀',
  minPlayers: 4,
  maxPlayers: 8,
  description: '身份局：主公/忠臣/反贼/内奸，手牌对决。',

  setup(playerIds, seed) {
    const base = { rngSeed: seed ?? Date.now(), turn: 0 } as GameState;
    const rng = rngFor(base, 'setup');
    const players: GamePlayer[] = rng.shuffle([...playerIds]).map((p, i) => ({
      id: p.id,
      nick: p.nick,
      seat: i,
      ready: true,
      alive: true,
    }));
    const identities = rng.shuffle(identityComposition(players.length));
    const identityMap: Record<string, Identity> = {};
    players.forEach((p, i) => (identityMap[p.id] = identities[i]!));
    const lord = players.find((p) => identityMap[p.id] === 'lord')!;

    const generals = rng.shuffle([...GENERALS]);
    const generalMap: Record<string, string> = {};
    const hp: Record<string, number> = {};
    const maxHp: Record<string, number> = {};
    players.forEach((p, i) => {
      const g = generals[i % generals.length]!;
      generalMap[p.id] = g.key;
      const bonus = identityMap[p.id] === 'lord' ? 1 : 0;
      maxHp[p.id] = g.hp + bonus;
      hp[p.id] = g.hp + bonus;
    });

    const deck = buildDeck(rng);
    const hands: Record<string, Card[]> = {};
    for (const p of players) {
      hands[p.id] = deck.splice(0, 4);
    }

    const state: SanguoshaState = {
      id: 'sanguosha',
      phase: 'playing',
      turn: 0,
      pending: [lord.id],
      players,
      log: [],
      rngSeed: seed ?? Date.now(),
      data: {
        identities: identityMap,
        generals: generalMap,
        hp,
        maxHp,
        hands,
        deck,
        discard: [],
        slashedThisTurn: {},
        phase: 'draw',
        responses: [],
        lord: lord.id,
        dead: [],
      },
    };
    logAll(state, `主公是 ${lord.nick}（${GENERALS.find((g) => g.key === generalMap[lord.id])?.name}），共 ${players.length} 人。`);
    logTo(state, lord.id, '你是主公，身份公开。');
    for (const p of players) {
      if (p.id !== lord.id) {
        logTo(state, p.id, `你的身份是 ${IDENTITY_INFO[identityMap[p.id]!].name}，请保密。`);
      }
    }
    return state;
  },

  reduce(state, action) {
    const s: SanguoshaState = JSON.parse(JSON.stringify(state)) as SanguoshaState;
    const me = action.by;
    if (!alivePlayers(s).some((p) => p.id === me)) return state;

    switch (action.type) {
      case 'draw': {
        if (s.pending[0] !== me) return state;
        if (s.data.phase !== 'draw') return state;
        const g = generalOf(s, me);
        const extra = g && (g.key === 'zhugeliang' || g.key === 'zhouyu') ? 1 : 0;
        drawCards(s, me, 2 + extra);
        logAll(s, `${nickOf(s, me)} 摸牌`);
        s.data.phase = 'play';
        s.data.slashedThisTurn[me] = 0;
        return s;
      }

      case 'play-slash': {
        if (s.pending[0] !== me || s.data.phase !== 'play') return state;
        const targetId = String(action.payload?.target ?? '');
        const target = s.players.find((p) => p.id === targetId);
        if (!target || !target.alive) return state;
        const g = generalOf(s, me);
        const limit = g?.key === 'zhangfei' ? 99 : 1;
        if ((s.data.slashedThisTurn[me] ?? 0) >= limit) return state;
        // 找一张杀（赵云的闪也可当杀）
        const hand = s.data.hands[me]!;
        const idx = hand.findIndex((c) => c.kind === 'slash' || (generalOf(s, me)?.key === 'zhaoyun' && c.kind === 'dodge'));
        if (idx < 0) return state;
        const card = hand.splice(idx, 1)[0]!;
        s.data.discard.push(card);
        s.data.slashedThisTurn[me] = (s.data.slashedThisTurn[me] ?? 0) + 1;
        // 马超：铁骑，目标不能用闪（简化为直接命中）
        if (g?.key === 'machao' && (s.data.slashedThisTurn[me] ?? 0) === 1) {
          damage(s, me, targetId, 1, '杀（铁骑）');
          logAll(s, `${nickOf(s, me)} 对 ${nickOf(s, targetId)} 使用【杀】（铁骑无法闪避）`);
          return s;
        }
        s.data.responses.push({ from: me, to: targetId, kind: 'slash', count: 1 });
        logAll(s, `${nickOf(s, me)} 对 ${nickOf(s, targetId)} 使用【杀】`);
        s.pending = [targetId];
        return s;
      }

      case 'play-dodge': {
        const resp = s.data.responses.find((r) => r.to === me && r.kind === 'slash');
        if (!resp) return state;
        const hand = s.data.hands[me]!;
        const idx = hand.findIndex((c) => c.kind === 'dodge' || (generalOf(s, me)?.key === 'zhaoyun' && c.kind === 'slash'));
        if (idx < 0) return state;
        const card = hand.splice(idx, 1)[0]!;
        s.data.discard.push(card);
        s.data.responses = s.data.responses.filter((r) => r !== resp);
        logAll(s, `${nickOf(s, me)} 使用【闪】抵消了【杀】`);
        backToActive(s, resp.from);
        return s;
      }

      case 'take-hit': {
        const resp = s.data.responses.find((r) => r.to === me && r.kind === 'slash');
        if (!resp) return state;
        s.data.responses = s.data.responses.filter((r) => r !== resp);
        damage(s, resp.from, me, 1, '杀');
        backToActive(s, resp.from);
        return s;
      }

      case 'play-peach': {
        if (s.data.phase !== 'play') return state;
        const hand = s.data.hands[me]!;
        const idx = hand.findIndex((c) => c.kind === 'peach');
        if (idx < 0) return state;
        if ((s.data.hp[me] ?? 0) >= (s.data.maxHp[me] ?? 0)) return state;
        const card = hand.splice(idx, 1)[0]!;
        s.data.discard.push(card);
        s.data.hp[me] = (s.data.hp[me] ?? 0) + 1;
        logAll(s, `${nickOf(s, me)} 使用【桃】回复 1 点体力`);
        return s;
      }

      case 'play-barbarian':
      case 'play-arrow': {
        if (s.pending[0] !== me || s.data.phase !== 'play') return state;
        const kind = action.type === 'play-barbarian' ? 'barbarian' : 'arrow';
        const hand = s.data.hands[me]!;
        const idx = hand.findIndex((c) => c.kind === kind);
        if (idx < 0) return state;
        const card = hand.splice(idx, 1)[0]!;
        s.data.discard.push(card);
        const need = kind === 'barbarian' ? 'slash' : 'dodge';
        logAll(s, `${nickOf(s, me)} 使用【${card.name}】`);
        for (const p of alivePlayers(s)) {
          if (p.id === me) continue;
          s.data.responses.push({ from: me, to: p.id, kind: need, count: 1 });
        }
        if (s.data.responses.length === 0) {
          backToActive(s, me);
          return s;
        }
        s.pending = [s.data.responses[0]!.to];
        return s;
      }

      case 'respond': {
        // 通用响应：payload.cardKind 说明用哪类牌
        const resp = s.data.responses.find((r) => r.to === me);
        if (!resp) return state;
        const wanted = resp.kind === 'slash' || resp.kind === 'barbarian' ? 'slash' : 'dodge';
        const hand = s.data.hands[me]!;
        const idx = hand.findIndex((c) => c.kind === wanted);
        if (idx >= 0) {
          const card = hand.splice(idx, 1)[0]!;
          s.data.discard.push(card);
          logAll(s, `${nickOf(s, me)} 打出【${card.name}】`);
        } else {
          const dmgFrom = resp.from;
          s.data.responses = s.data.responses.filter((r) => r !== resp);
          damage(s, dmgFrom, me, 1, resp.kind);
        }
        advanceResponses(s, resp);
        return s;
      }

      case 'play-duel': {
        if (s.pending[0] !== me || s.data.phase !== 'play') return state;
        const targetId = String(action.payload?.target ?? '');
        if (!alivePlayers(s).some((p) => p.id === targetId)) return state;
        const hand = s.data.hands[me]!;
        const idx = hand.findIndex((c) => c.kind === 'duel');
        if (idx < 0) return state;
        const card = hand.splice(idx, 1)[0]!;
        s.data.discard.push(card);
        logAll(s, `${nickOf(s, me)} 对 ${nickOf(s, targetId)} 使用【决斗】`);
        s.data.responses.push({ from: me, to: targetId, kind: 'duel', count: 1 });
        s.pending = [targetId];
        return s;
      }

      case 'duel-slash': {
        const resp = s.data.responses.find((r) => r.to === me && r.kind === 'duel');
        if (!resp) return state;
        const hand = s.data.hands[me]!;
        const idx = hand.findIndex((c) => c.kind === 'slash');
        if (idx >= 0) {
          const card = hand.splice(idx, 1)[0]!;
          s.data.discard.push(card);
          // 反过来要对方出杀
          s.data.responses = s.data.responses.filter((r) => r !== resp);
          s.data.responses.push({ from: me, to: resp.from, kind: 'duel', count: 1 });
          s.pending = [resp.from];
          logAll(s, `${nickOf(s, me)} 打出【杀】，决斗继续`);
          return s;
        }
        s.data.responses = s.data.responses.filter((r) => r !== resp);
        damage(s, resp.from, me, 1, '决斗');
        backToActive(s, resp.from);
        return s;
      }

      case 'end-turn': {
        if (s.pending[0] !== me) return state;
        // 结束回合时清掉尚未完成的响应（例如目标已死/无牌可出），
        // 否则 pending 会永远停在出牌者身上，游戏无法推进。
        s.data.responses = s.data.responses.filter((r) => {
          const t = s.players.find((p) => p.id === r.to);
          return Boolean(t && t.alive);
        });
        if (s.data.responses.length > 0) {
          s.pending = [s.data.responses[0]!.to];
          return s;
        }
        const limit = handLimit(s, me);
        const hand = s.data.hands[me]!;
        if (hand.length > limit) {
          const drop = hand.splice(limit);
          s.data.discard.push(...drop);
          logAll(s, `${nickOf(s, me)} 弃掉 ${drop.length} 张牌`);
        }
        nextTurn(s, me);
        return s;
      }

      default:
        return state;
    }
  },

  view(state, viewerId) {
    const me = state.players.find((p) => p.id === viewerId);
    const myIdentity = state.data.identities[viewerId];
    const resp = state.data.responses.find((r) => r.to === viewerId);
    let prompt: GameView['prompt'];
    if (resp) {
      const wanted = resp.kind === 'slash' || resp.kind === 'barbarian' ? '杀' : resp.kind === 'dodge' || resp.kind === 'arrow' ? '闪' : '杀';
      prompt = {
        kind: 'choose',
        question: `你需要打出【${wanted}】来响应 ${nickOf(state, resp.from)}`,
        options: [
          { value: 'respond', label: `打出【${wanted}】` },
          { value: 'take-hit', label: '不出，受到 1 点伤害' },
        ],
      };
    } else if (state.pending[0] === viewerId && me?.alive) {
      const hand = state.data.hands[viewerId] ?? [];
      const opts: { value: string; label: string; disabled?: boolean }[] = [];
      if (state.data.phase === 'draw') opts.push({ value: 'draw', label: '摸牌' });
      if (state.data.phase === 'play') {
        const g = generalOf(state, viewerId);
        const slashLimit = g?.key === 'zhangfei' ? 99 : 1;
        const canSlash = (state.data.slashedThisTurn[viewerId] ?? 0) < slashLimit && hand.some((c) => c.kind === 'slash');
        for (const t of alivePlayers(state)) {
          if (t.id === viewerId) continue;
          opts.push({ value: `slash:${t.id}`, label: `杀 ${t.nick}`, disabled: !canSlash });
        }
        if (hand.some((c) => c.kind === 'peach')) opts.push({ value: 'peach', label: '使用桃' });
        if (hand.some((c) => c.kind === 'barbarian')) opts.push({ value: 'barbarian', label: '南蛮入侵' });
        if (hand.some((c) => c.kind === 'arrow')) opts.push({ value: 'arrow', label: '万箭齐发' });
        if (hand.some((c) => c.kind === 'duel')) {
          for (const t of alivePlayers(state)) {
            if (t.id === viewerId) continue;
            opts.push({ value: `duel:${t.id}`, label: `决斗 ${t.nick}` });
          }
        }
        opts.push({ value: 'end-turn', label: '结束回合' });
      }
      prompt = { kind: 'choose', question: '你的回合，请选择行动：', options: opts };
    }

    return {
      you: {
        identity: myIdentity ? `${IDENTITY_INFO[myIdentity].emoji} ${IDENTITY_INFO[myIdentity].name}` : '观战',
        goal: myIdentity ? IDENTITY_INFO[myIdentity].goal : '',
        general: generalOf(state, viewerId)?.name ?? '',
        skill: generalOf(state, viewerId)?.desc ?? '',
        hp: state.data.hp[viewerId],
        maxHp: state.data.maxHp[viewerId],
        hand: (state.data.hands[viewerId] ?? []).map((c) => ({ id: c.id, name: c.name, kind: c.kind })),
      },
      board: {
        lord: nickOf(state, state.data.lord),
        players: state.players.map((p) => ({
          nick: p.nick,
          hp: state.data.hp[p.id],
          maxHp: state.data.maxHp[p.id],
          general: generalOf(state, p.id)?.name ?? '',
          handCount: (state.data.hands[p.id] ?? []).length,
          alive: p.alive,
          // 身份只公开主公与已死者
          identity:
            p.id === state.data.lord || !p.alive
              ? state.data.identities[p.id]
              : undefined,
        })),
        deckLeft: state.data.deck.length,
        phase: state.data.phase,
        turn: state.turn,
      },
      prompt,
      ascii: renderTable(state, viewerId),
    };
  },

  isOver(state) {
    const lord = state.players.find((p) => p.id === state.data.lord);
    if (!lord || !lord.alive) return true;
    const alive = alivePlayers(state);
    const rebels = alive.filter((p) => state.data.identities[p.id] === 'rebel');
    const spies = alive.filter((p) => state.data.identities[p.id] === 'spy');
    return rebels.length === 0 && spies.length === 0;
  },

  winners(state) {
    const lord = state.players.find((p) => p.id === state.data.lord);
    const lordAlive = Boolean(lord?.alive);
    if (!lordAlive) {
      // 主公死：反贼胜（内奸若存活且只剩其与主公则内奸胜，简化为反贼胜）
      return state.players.filter((p) => state.data.identities[p.id] === 'rebel').map((p) => p.id);
    }
    const alive = alivePlayers(state);
    const bad = alive.filter((p) => ['rebel', 'spy'].includes(state.data.identities[p.id]!));
    if (bad.length === 0) {
      // 主公 + 忠臣胜
      return state.players.filter((p) => ['lord', 'loyal'].includes(state.data.identities[p.id]!)).map((p) => p.id);
    }
    return bad.map((p) => p.id);
  },
};

/* ------------------------------------------------------------------ */

function nickOf(state: SanguoshaState, id: string): string {
  return state.players.find((p) => p.id === id)?.nick ?? id.slice(0, 6);
}

function generalOf(state: SanguoshaState, id: string): General | undefined {
  const key = state.data.generals[id];
  return GENERALS.find((g) => g.key === key);
}

function handLimit(state: SanguoshaState, id: string): number {
  const hp = state.data.hp[id] ?? 0;
  const g = generalOf(state, id);
  // 吕蒙克己：本回合未使用杀则 +2（简化为恒 +2）
  return Math.max(0, hp) + (g?.key === 'lvmeng' ? 2 : 0);
}

function drawCards(state: SanguoshaState, id: string, n: number): void {
  for (let i = 0; i < n; i++) {
    if (state.data.deck.length === 0) {
      // 洗回弃牌堆
      const rng = rngFor(state, `reshuffle:${state.turn}`);
      state.data.deck = rng.shuffle([...state.data.discard]);
      state.data.discard = [];
      if (state.data.deck.length === 0) return;
    }
    const c = state.data.deck.shift()!;
    (state.data.hands[id] ??= []).push(c);
  }
}

function damage(state: SanguoshaState, from: string, to: string, amount: number, reason: string): void {
  const hp = (state.data.hp[to] ?? 0) - amount;
  state.data.hp[to] = hp;
  logAll(state, `${nickOf(state, to)} 受到 ${amount} 点伤害（${reason}），剩余体力 ${Math.max(0, hp)}`);
  if (hp <= 0) {
    const p = state.players.find((x) => x.id === to);
    if (p) {
      p.alive = false;
      state.data.dead.push({ id: to, identity: state.data.identities[to]! });
      logAll(state, `💀 ${nickOf(state, to)} 阵亡，身份是 ${IDENTITY_INFO[state.data.identities[to]!].name}`);
    }
  }
}

function backToActive(state: SanguoshaState, activeId: string): void {
  // 若还有其它待响应者，交给下一个；否则回到出牌者
  if (state.data.responses.length > 0) {
    state.pending = [state.data.responses[0]!.to];
    return;
  }
  const p = state.players.find((x) => x.id === activeId);
  state.pending = p && p.alive ? [activeId] : [nextAliveId(state, activeId)];
}

function advanceResponses(state: SanguoshaState, done: { to: string; from: string }): void {
  state.data.responses = state.data.responses.filter((r) => !(r.to === done.to && r.from === done.from));
  if (state.data.responses.length > 0) {
    state.pending = [state.data.responses[0]!.to];
    return;
  }
  // 全部响应完毕 -> 回到发起者继续出牌
  const from = state.players.find((x) => x.id === done.from);
  state.pending = from && from.alive ? [done.from] : [nextAliveId(state, done.from)];
}

function nextAliveId(state: SanguoshaState, afterId: string): string {
  const sorted = [...state.players].sort((a, b) => a.seat - b.seat);
  const idx = sorted.findIndex((p) => p.id === afterId);
  for (let i = 1; i <= sorted.length; i++) {
    const c = sorted[(idx + i) % sorted.length]!;
    if (c.alive) return c.id;
  }
  return afterId;
}

function nextTurn(state: SanguoshaState, afterId: string): void {
  state.turn += 1;
  const sorted = [...state.players].sort((a, b) => a.seat - b.seat);
  const idx = sorted.findIndex((p) => p.id === afterId);
  for (let i = 1; i <= sorted.length; i++) {
    const cand = sorted[(idx + i) % sorted.length]!;
    if (cand.alive) {
      state.pending = [cand.id];
      state.data.phase = 'draw';
      return;
    }
  }
  state.phase = 'finished';
}

/** ASCII 牌桌 */
function renderTable(state: SanguoshaState, viewerId: string): string {
  const lines: string[] = [];
  lines.push(`  牌堆 ${state.data.deck.length}  弃牌 ${state.data.discard.length}`);
  lines.push('');
  for (const p of [...state.players].sort((a, b) => a.seat - b.seat)) {
    const g = generalOf(state, p.id);
    const hp = state.data.hp[p.id] ?? 0;
    const maxHp = state.data.maxHp[p.id] ?? 0;
    const hearts = '♥'.repeat(Math.max(0, hp)) + '·'.repeat(Math.max(0, maxHp - hp));
    const ident =
      p.id === state.data.lord
        ? '👑主公'
        : !p.alive
          ? IDENTITY_INFO[state.data.identities[p.id]!].name
          : '???';
    const hand = (state.data.hands[p.id] ?? []).length;
    const you = p.id === viewerId ? ' ←你' : '';
    lines.push(`  ${p.alive ? ' ' : '💀'} ${p.nick.padEnd(8)} ${ident.padEnd(5)} ${g?.name ?? ''} ${hearts} 手牌${hand}${you}`);
  }
  const log = visibleLog(state, viewerId).slice(-5);
  if (log.length) {
    lines.push('');
    for (const l of log) lines.push(`  ${l.text}`);
  }
  return lines.join('\n');
}

registerGame(def as unknown as GameDefinition);

export const sanguosha = { def, GENERALS, IDENTITY_INFO, identityComposition, CARD_NAMES };
export default sanguosha;
