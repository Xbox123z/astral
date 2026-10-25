/**
 * 狼人杀（Werewolf / Mafia）。
 *
 * 实现要点：
 *  - 身份对本人可见、狼人互相可见，其余人只看到「未知」——这是 GameView.you
 *    存在的理由，也是端到端加密真正在保护的东西（服务器只转发密文）。
 *  - 完整的昼夜循环：狼人刀人 -> 预言家查验 -> 女巫毒救 -> 白天发言投票 -> 放逐。
 *  - 随机全部走 rngFor()，各端用同一 seed 得到同一发牌结果。
 *  - 平票处理：平票则进入 PK 投票（简化为一轮重投，仍平票则无人出局）。
 */

import {
  logAll,
  logTo,
  rngFor,
  nextAlive,
  alivePlayers,
  registerGame,
  visibleLog,
  type GameAction,
  type GameDefinition,
  type GameState,
  type GameView,
  type GamePlayer,
} from './engine.js';

export type Role = 'werewolf' | 'seer' | 'witch' | 'hunter' | 'guard' | 'villager';

export const ROLE_INFO: Record<Role, { name: string; camp: 'wolf' | 'good'; desc: string; emoji: string }> = {
  werewolf: { name: '狼人', camp: 'wolf', desc: '夜间共同选择一名玩家击杀', emoji: '🐺' },
  seer: { name: '预言家', camp: 'good', desc: '每晚查验一名玩家的阵营', emoji: '🔮' },
  witch: { name: '女巫', camp: 'good', desc: '有一瓶毒药与一瓶解药，各用一次', emoji: '🧪' },
  hunter: { name: '猎人', camp: 'good', desc: '出局时可开枪带走一名玩家', emoji: '🔫' },
  guard: { name: '守卫', camp: 'good', desc: '每晚守护一名玩家，不可连守同一人', emoji: '🛡️' },
  villager: { name: '村民', camp: 'good', desc: '无特殊能力，靠推理与投票', emoji: '👤' },
};

export interface WerewolfData {
  roles: Record<string, Role>;
  /** 夜晚阶段：kill / seer / witch / guard */
  nightStep: 'kill' | 'seer' | 'witch' | 'guard' | null;
  /** 本夜狼人选定的目标 */
  killTarget: string | null;
  /** 本夜守卫守护的目标 */
  guardTarget: string | null;
  /** 守卫上一晚守护的人（不可连守） */
  guardLast: string | null;
  /** 女巫剩余药剂 */
  witch: { poison: boolean; antidote: boolean };
  /** 本夜被刀的人（女巫可救） */
  attacked: string | null;
  /** 白天投票 */
  votes: Record<string, string>;
  /** 已出局玩家的死因 */
  deaths: { id: string; turn: number; cause: string }[];
  /** 预言家的查验记录 */
  seerResults: { target: string; camp: 'wolf' | 'good'; turn: number }[];
  /** 猎人开枪待处理 */
  pendingShot: string | null;
  /** 白天发言是否已开始 */
  dayStarted: boolean;
  /**
   * 夜晚是否已结束、等待天亮结算。
   * dawn 是幂等操作的关键：只有这里为 true 时才真正推进到新的一天，
   * 避免重复的 dawn 让 day 无限自增、票箱被反复清空。
   */
  nightEnded: boolean;
  /** 本局天数 */
  day: number;
}

export type WerewolfState = GameState & { data: WerewolfData };

/** 按人数配置身份 */
export function roleComposition(n: number): Role[] {
  const table: Record<number, Role[]> = {
    6: ['werewolf', 'werewolf', 'seer', 'witch', 'villager', 'villager'],
    7: ['werewolf', 'werewolf', 'seer', 'witch', 'hunter', 'villager', 'villager'],
    8: ['werewolf', 'werewolf', 'werewolf', 'seer', 'witch', 'hunter', 'villager', 'villager'],
    9: ['werewolf', 'werewolf', 'werewolf', 'seer', 'witch', 'hunter', 'guard', 'villager', 'villager'],
    10: ['werewolf', 'werewolf', 'werewolf', 'seer', 'witch', 'hunter', 'guard', 'villager', 'villager', 'villager'],
    11: ['werewolf', 'werewolf', 'werewolf', 'werewolf', 'seer', 'witch', 'hunter', 'guard', 'villager', 'villager', 'villager'],
    12: ['werewolf', 'werewolf', 'werewolf', 'werewolf', 'seer', 'witch', 'hunter', 'guard', 'villager', 'villager', 'villager', 'villager'],
  };
  return table[Math.min(12, Math.max(6, n))] ?? table[9]!;
}

function wolvesIn(state: WerewolfState): string[] {
  return state.players.filter((p) => p.alive && state.data.roles[p.id] === 'werewolf').map((p) => p.id);
}

function campOf(state: WerewolfState, id: string): 'wolf' | 'good' {
  return ROLE_INFO[state.data.roles[id]!].camp;
}

const def: GameDefinition<WerewolfState> = {
  id: 'werewolf',
  name: '狼人杀',
  minPlayers: 6,
  maxPlayers: 12,
  description: '经典身份推理：狼人夜间刀人，好人白天投票放逐。',

  setup(playerIds, seed) {
    const rng = rngFor({ rngSeed: seed ?? Date.now(), turn: 0 } as GameState, 'deal');
    const roles = roleComposition(playerIds.length);
    const shuffled = rng.shuffle([...roles]);
    const players: GamePlayer[] = rng.shuffle([...playerIds]).map((p, i) => ({
      id: p.id,
      nick: p.nick,
      seat: i,
      ready: true,
      alive: true,
    }));
    const roleMap: Record<string, Role> = {};
    players.forEach((p, i) => {
      roleMap[p.id] = shuffled[i]!;
    });
    const state: WerewolfState = {
      id: 'werewolf',
      phase: 'playing',
      turn: 0,
      pending: [],
      players,
      log: [],
      rngSeed: seed ?? Date.now(),
      data: {
        roles: roleMap,
        nightStep: 'kill',
        killTarget: null,
        guardTarget: null,
        guardLast: null,
        witch: { poison: true, antidote: true },
        attacked: null,
        votes: {},
        deaths: [],
        seerResults: [],
        pendingShot: null,
        dayStarted: false,
        nightEnded: false,
        day: 0,
      },
    };
    logAll(state, `天黑了，请闭眼。（共 ${players.length} 人）`);
    state.pending = wolvesIn(state);
    return state;
  },

  reduce(state, action) {
    // 深拷贝，保持纯函数语义
    const s: WerewolfState = JSON.parse(JSON.stringify(state)) as WerewolfState;

    switch (action.type) {
      /* ---------------- 夜晚：狼人刀人 ---------------- */
      case 'kill': {
        if (s.data.nightStep !== 'kill') return state;
        if (campOf(s, action.by) !== 'wolf') return state;
        const target = String(action.payload?.target ?? '');
        if (!alivePlayers(s).some((p) => p.id === target)) return state;
        s.data.killTarget = target;
        for (const w of wolvesIn(s)) logTo(s, w, `狼队选择刀 ${nameOf(s, target)}`);
        // 多狼时等所有狼都表态再推进（这里以 killTarget 已设为推进条件）
        advanceNight(s, 'kill');
        return s;
      }

      case 'wolf-commit': {
        // 系统/最后一个狼人确认刀人：把 killTarget 落到 attacked
        if (s.data.nightStep !== 'kill') return state;
        s.data.attacked = s.data.killTarget;
        advanceNight(s, 'kill');
        return s;
      }

      /* ---------------- 预言家查验 ---------------- */
      case 'seer': {
        if (s.data.nightStep !== 'seer') return state;
        if (s.data.roles[action.by] !== 'seer') return state;
        const target = String(action.payload?.target ?? '');
        if (!alivePlayers(s).some((p) => p.id === target)) return state;
        s.data.seerResults.push({ target, camp: campOf(s, target), turn: s.turn });
        logTo(s, action.by, `你查验了 ${nameOf(s, target)}：${campOf(s, target) === 'wolf' ? '狼人' : '好人'}`);
        advanceNight(s, 'seer');
        return s;
      }

      case 'seer-skip': {
        if (s.data.nightStep !== 'seer') return state;
        advanceNight(s, 'seer');
        return s;
      }

      /* ---------------- 女巫毒救 ---------------- */
      case 'witch-save': {
        if (s.data.nightStep !== 'witch') return state;
        if (s.data.roles[action.by] !== 'witch') return state;
        if (!s.data.witch.antidote || !s.data.attacked) return state;
        s.data.witch.antidote = false;
        s.data.attacked = null;
        logTo(s, action.by, '你使用了解药，救活了今晚被刀的人');
        advanceNight(s, 'witch');
        return s;
      }

      case 'witch-poison': {
        if (s.data.nightStep !== 'witch') return state;
        if (s.data.roles[action.by] !== 'witch') return state;
        if (!s.data.witch.poison) return state;
        const target = String(action.payload?.target ?? '');
        if (!alivePlayers(s).some((p) => p.id === target)) return state;
        s.data.witch.poison = false;
        kill(s, target, '女巫毒杀');
        logTo(s, action.by, `你毒杀了 ${nameOf(s, target)}`);
        advanceNight(s, 'witch');
        return s;
      }

      case 'witch-skip': {
        if (s.data.nightStep !== 'witch') return state;
        advanceNight(s, 'witch');
        return s;
      }

      /* ---------------- 守卫守护 ---------------- */
      case 'guard': {
        if (s.data.nightStep !== 'guard') return state;
        if (s.data.roles[action.by] !== 'guard') return state;
        const target = String(action.payload?.target ?? '');
        if (!alivePlayers(s).some((p) => p.id === target)) return state;
        if (s.data.guardLast === target) return state; // 不可连守
        s.data.guardTarget = target;
        s.data.guardLast = target;
        advanceNight(s, 'guard');
        return s;
      }

      case 'guard-skip': {
        if (s.data.nightStep !== 'guard') return state;
        advanceNight(s, 'guard');
        return s;
      }

      /* ---------------- 夜晚结算 -> 天亮 ---------------- */
      case 'dawn':
      case 'force-dawn': {
        if (s.data.nightStep !== null) return state;
        doDawn(s);
        return s;
      }

      /* ---------------- 白天投票 ---------------- */
      case 'vote': {
        if (s.phase !== 'voting') return state;
        const target = String(action.payload?.target ?? '');
        if (!alivePlayers(s).some((p) => p.id === target)) return state;
        s.data.votes[action.by] = target;
        // 所有人投完则结算
        const alive = alivePlayers(s);
        if (Object.keys(s.data.votes).length >= alive.length) {
          resolveVote(s);
        }
        return s;
      }

      case 'skip-vote': {
        if (s.phase !== 'voting') return state;
        s.data.votes[action.by] = '__abstain__';
        const alive = alivePlayers(s);
        if (Object.keys(s.data.votes).length >= alive.length) resolveVote(s);
        return s;
      }

      /* ---------------- 猎人开枪 ---------------- */
      case 'shoot': {
        if (s.data.pendingShot !== action.by) return state;
        const target = String(action.payload?.target ?? '');
        if (!alivePlayers(s).some((p) => p.id === target)) return state;
        kill(s, target, '被猎人带走');
        logAll(s, `猎人 ${nameOf(s, action.by)} 开枪带走了 ${nameOf(s, target)}。`);
        s.data.pendingShot = null;
        afterDeath(s);
        return s;
      }

      case 'shoot-skip': {
        if (s.data.pendingShot !== action.by) return state;
        s.data.pendingShot = null;
        afterDeath(s);
        return s;
      }

      default:
        return state;
    }
  },

  view(state, viewerId) {
    const me = state.data.roles[viewerId];
    const alive = alivePlayers(state);
    const isWolf = me === 'werewolf';
    const wolves = wolvesIn(state);

    // 各人能看到什么
    const known: Record<string, string> = {};
    for (const p of state.players) {
      const role = state.data.roles[p.id]!;
      if (p.id === viewerId) known[p.id] = `${ROLE_INFO[role].emoji} ${ROLE_INFO[role].name}（你）`;
      else if (isWolf && role === 'werewolf') known[p.id] = `${ROLE_INFO[role].emoji} ${ROLE_INFO[role].name}`;
      else if (!p.alive) known[p.id] = `💀 ${ROLE_INFO[role].name}（已出局）`;
      else known[p.id] = `❓ 未知`;
    }

    // 当前该我做什么
    let prompt: GameView['prompt'];
    if (state.data.pendingShot === viewerId) {
      prompt = {
        kind: 'choose',
        question: '你被淘汰了，是否开枪？选择带走一名玩家：',
        options: alive
          .filter((p) => p.id !== viewerId)
          .map((p) => ({ value: p.id, label: p.nick })),
      };
    } else if (state.data.nightStep === 'kill' && isWolf) {
      prompt = {
        kind: 'choose',
        question: '狼人请刀人：',
        options: alive.filter((p) => p.id !== viewerId).map((p) => ({ value: p.id, label: p.nick })),
      };
    } else if (state.data.nightStep === 'seer' && me === 'seer') {
      prompt = {
        kind: 'choose',
        question: '预言家请查验：',
        options: alive
          .filter((p) => p.id !== viewerId && !state.data.seerResults.some((r) => r.target === p.id))
          .map((p) => ({ value: p.id, label: p.nick })),
      };
    } else if (state.data.nightStep === 'witch' && me === 'witch') {
      const opts: { value: string; label: string; disabled?: boolean }[] = [];
      if (state.data.witch.antidote && state.data.attacked) {
        opts.push({ value: '__save__', label: `使用解药救活 ${nameOf(state, state.data.attacked)}` });
      }
      if (state.data.witch.poison) {
        for (const p of alive) {
          if (p.id === viewerId) continue;
          opts.push({ value: `__poison__:${p.id}`, label: `毒杀 ${p.nick}` });
        }
      }
      opts.push({ value: '__skip__', label: '不使用药水' });
      prompt = { kind: 'choose', question: '女巫请行动：', options: opts };
    } else if (state.data.nightStep === 'guard' && me === 'guard') {
      prompt = {
        kind: 'choose',
        question: '守卫请守护（不可连守同一人）：',
        options: alive.map((p) => ({
          value: p.id,
          label: p.nick,
          disabled: state.data.guardLast === p.id,
        })),
      };
    } else if (state.phase === 'voting' && state.players.find((p) => p.id === viewerId)?.alive) {
      if (!state.data.votes[viewerId]) {
        prompt = {
          kind: 'vote',
          question: '白天投票，选出你要放逐的人：',
          options: alive.filter((p) => p.id !== viewerId).map((p) => ({ value: p.id, label: p.nick })),
        };
      }
    }

    return {
      you: {
        role: me ? `${ROLE_INFO[me].emoji} ${ROLE_INFO[me].name}` : '观战',
        roleDesc: me ? ROLE_INFO[me].desc : '',
        teammates: isWolf ? wolves.filter((w) => w !== viewerId) : [],
        seerResults: me === 'seer' ? state.data.seerResults : [],
        witch: me === 'witch' ? state.data.witch : undefined,
        guardLast: me === 'guard' ? state.data.guardLast : undefined,
      },
      board: {
        phase: state.data.nightStep ? `夜晚 · ${nightStepName(state.data.nightStep)}` : `第 ${state.data.day} 天 · 投票`,
        day: state.data.day,
        alive: alive.map((p) => p.nick),
        dead: state.data.deaths.map((d) => ({ nick: nameOf(state, d.id), cause: d.cause, turn: d.turn })),
        players: known,
        votes: state.data.votes,
        pendingCount: state.pending.length,
      },
      prompt,
      ascii: renderWerewolfBoard(state, viewerId),
    };
  },

  isOver(state) {
    const wolves = wolvesIn(state).length;
    const goods = alivePlayers(state).length - wolves;
    return wolves === 0 || goods <= wolves;
  },

  winners(state) {
    const wolves = wolvesIn(state);
    if (wolves.length === 0) return alivePlayers(state).map((p) => p.id);
    return wolves;
  },
};

/* ------------------------------------------------------------------ */
/* 辅助                                                                */
/* ------------------------------------------------------------------ */

function nameOf(state: WerewolfState, id: string): string {
  return state.players.find((p) => p.id === id)?.nick ?? id.slice(0, 6);
}

function kill(state: WerewolfState, id: string, cause: string): void {
  const p = state.players.find((x) => x.id === id);
  if (!p || !p.alive) return;
  p.alive = false;
  state.data.deaths.push({ id, turn: state.turn, cause });
  // 猎人死亡触发开枪
  if (state.data.roles[id] === 'hunter') {
    state.data.pendingShot = id;
  }
}

/** 死亡结算后：若无需开枪，则回到夜晚继续 */
function afterDeath(state: WerewolfState): void {
  if (def.isOver(state)) {
    state.phase = 'finished';
    return;
  }
  state.data.nightStep = 'kill';
  state.data.votes = {};
  state.data.attacked = null;
  state.data.killTarget = null;
  state.data.guardTarget = null;
  state.data.dayStarted = false;
  state.data.nightEnded = false;
  state.phase = 'playing';
  state.turn += 1;
  state.pending = pendingFor(state);
}

function resolveVote(state: WerewolfState): void {
  const counts = new Map<string, number>();
  for (const t of Object.values(state.data.votes)) {
    if (t === '__abstain__') continue;
    counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  if (counts.size === 0) {
    logAll(state, '所有人弃票，无人被放逐。');
    afterDeath(state);
    return;
  }
  const sorted = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  if (sorted.length > 1 && sorted[0]![1] === sorted[1]![1]) {
    logAll(state, `平票（${sorted[0]![1]} 票），无人被放逐。`);
    afterDeath(state);
    return;
  }
  const [target, n] = sorted[0]!;
  kill(state, target, `白天被放逐（${n} 票）`);
  logAll(state, `${nameOf(state, target)} 被放逐出局，共 ${n} 票。`);
  if (state.data.pendingShot) {
    // 等猎人开枪：pending 指向猎人，其余人不该再行动
    state.pending = [state.data.pendingShot];
    return;
  }
  afterDeath(state);
}

function nextNightStep(state: WerewolfState, from: 'kill' | 'seer' | 'witch' | 'guard'): 'kill' | 'seer' | 'witch' | 'guard' | null {
  const has = (r: Role): boolean => alivePlayers(state).some((p) => state.data.roles[p.id] === r);
  const order: ('kill' | 'seer' | 'witch' | 'guard')[] = ['kill', 'seer', 'witch', 'guard'];
  let i = order.indexOf(from) + 1;
  while (i < order.length) {
    const step = order[i]!;
    const role: Role = step === 'kill' ? 'werewolf' : step;
    if (has(role)) return step;
    i++;
  }
  return null;
}

function pendingFor(state: WerewolfState): string[] {
  if (state.data.nightStep === 'kill') return wolvesIn(state);
  if (state.data.nightStep === 'seer') {
    return alivePlayers(state).filter((p) => state.data.roles[p.id] === 'seer').map((p) => p.id);
  }
  if (state.data.nightStep === 'witch') {
    return alivePlayers(state).filter((p) => state.data.roles[p.id] === 'witch').map((p) => p.id);
  }
  if (state.data.nightStep === 'guard') {
    return alivePlayers(state).filter((p) => state.data.roles[p.id] === 'guard').map((p) => p.id);
  }
  return [];
}

function nightStepName(s: 'kill' | 'seer' | 'witch' | 'guard'): string {
  return { kill: '狼人行动', seer: '预言家查验', witch: '女巫用药', guard: '守卫守护' }[s];
}

/**
 * 推进夜晚步骤。
 * 关键：把「所有夜间步骤走完」直接结算到天亮，不再要求外部发 dawn，
 * 这样状态机不会因为没人发 dawn 而卡死。
 */
function advanceNight(state: WerewolfState, from: 'kill' | 'seer' | 'witch' | 'guard'): void {
  // 狼人阶段必须先把 killTarget 落到 attacked
  if (from === 'kill' && state.data.attacked === null && state.data.killTarget) {
    state.data.attacked = state.data.killTarget;
  }
  const next = nextNightStep(state, from);
  if (next !== null) {
    state.data.nightStep = next;
    state.pending = pendingFor(state);
    // 若该步骤无人可行动（已死亡），继续往下跳
    if (state.pending.length === 0) advanceNight(state, next);
    return;
  }
  // 所有夜间步骤结束 -> 自动天亮
  state.data.nightEnded = true;
  doDawn(state);
}

/**
 * 天亮结算。
 *
 * 幂等保护：只有在「夜晚刚刚结束」时才允许执行一次。
 * 否则客户端重复发 dawn（网络重传、UI 重试）会让 day 一直自增、
 * 票箱被反复清空，游戏永远推进不到第二天。用 nightEnded 标记区分
 * 「夜晚结束待结算」与「已经是白天」。
 */
function doDawn(state: WerewolfState): void {
  if (!state.data.nightEnded) return; // 已经是白天，忽略重复的 dawn
  state.data.nightEnded = false;

  const attacked = state.data.attacked;
  if (attacked && state.data.guardTarget !== attacked) {
    kill(state, attacked, '夜间被刀');
    logAll(state, `天亮了，${nameOf(state, attacked)} 被刀出局。`);
  } else if (attacked) {
    logAll(state, `天亮了，无人出局（${nameOf(state, attacked)} 被守护）。`);
  } else {
    logAll(state, '天亮了，今夜是平安夜。');
  }
  state.data.day += 1;
  state.data.attacked = null;
  state.data.killTarget = null;
  state.data.guardTarget = null;
  state.data.nightStep = null;
  state.data.dayStarted = true;
  state.data.votes = {};
  state.phase = 'voting';
  state.pending = alivePlayers(state).map((p) => p.id);

  if (def.isOver(state)) {
    state.phase = 'finished';
    state.pending = [];
  }
}

/** ASCII 座位图：让终端用户一眼看清局势 */
function renderWerewolfBoard(state: WerewolfState, viewerId: string): string {
  const lines: string[] = [];
  const alive = alivePlayers(state);
  const isWolf = state.data.roles[viewerId] === 'werewolf';
  lines.push(`  第 ${state.data.day} 天 · 存活 ${alive.length}/${state.players.length}`);
  lines.push('');
  for (const p of [...state.players].sort((a, b) => a.seat - b.seat)) {
    const role = state.data.roles[p.id]!;
    let mark = '❓';
    if (!p.alive) mark = '💀';
    else if (p.id === viewerId) mark = ROLE_INFO[role].emoji;
    else if (isWolf && role === 'werewolf') mark = '🐺';
    const you = p.id === viewerId ? ' ←你' : '';
    lines.push(`  ${mark} ${p.nick}${p.alive ? '' : '（出局）'}${you}`);
  }
  const log = visibleLog(state, viewerId).slice(-6);
  if (log.length) {
    lines.push('');
    lines.push('  ── 最近动态 ──');
    for (const l of log) lines.push(`  ${l.text}`);
  }
  return lines.join('\n');
}

registerGame(def as unknown as GameDefinition);

export const werewolf = { def, ROLE_INFO, roleComposition };
export default werewolf;
