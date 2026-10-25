// 游戏自动对局模拟：用简单 AI 把三局游戏跑到底，验证状态机不会卡死
import { getGame, GameSession, listGames } from '../dist/games/index.js';

const names = ['Alice', 'Bob', 'Carol', 'Dave', 'Eve', 'Frank', 'Grace', 'Henry'];

function players(n) {
  return Array.from({ length: n }, (_, i) => ({ id: `p${i}`, nick: names[i] }));
}

console.log('registered games:', listGames().map((g) => `${g.id}(${g.min}-${g.max})`).join(', '));

/* ---------------- 狼人杀 ---------------- */
function simWerewolf(seed) {
  const g = getGame('werewolf');
  const ps = players(9);
  const s = GameSession.create(g, ps, seed);
  let guard = 0;
  let noProgress = 0;
  let lastSignature = '';
  while (!s.isOver() && guard++ < 400) {
    const st = s.current;
    // 状态签名：若连续 30 次迭代签名完全不变，才判定为卡死
    const signature = `${st.phase}|${st.data.nightStep}|${st.data.day}|${st.players.filter(p=>p.alive).length}|${Object.keys(st.data.votes).length}`;
    if (signature === lastSignature) {
      noProgress++;
      if (noProgress > 30) {
        return { ok: false, why: `stuck: ${signature}`, turn: st.turn, day: st.data.day, guard };
      }
    } else {
      noProgress = 0;
    }
    lastSignature = signature;
    const alive = st.players.filter((p) => p.alive);
    const pick = (exclude) => {
      const c = alive.filter((p) => !exclude || p.id !== exclude);
      return c.length ? c[guard % c.length].id : null;
    };
    if (st.data.pendingShot) {
      const t = pick(st.data.pendingShot);
      s.apply({ by: st.data.pendingShot, type: t ? 'shoot' : 'shoot-skip', payload: t ? { target: t } : {} });
      continue;
    }
    if (st.data.nightStep === 'kill') {
      s.apply({ by: st.pending[0], type: 'kill', payload: { target: pick() } });
      s.apply({ by: st.pending[0], type: 'wolf-commit' });
      continue;
    }
    if (st.data.nightStep === 'seer') {
      s.apply({ by: st.pending[0], type: 'seer', payload: { target: pick(st.pending[0]) } });
      continue;
    }
    if (st.data.nightStep === 'witch') {
      s.apply({ by: st.pending[0], type: 'witch-skip' });
      continue;
    }
    if (st.data.nightStep === 'guard') {
      s.apply({ by: st.pending[0], type: 'guard', payload: { target: pick() } });
      continue;
    }
    if (st.phase === 'voting') {
      const voters = alive.filter((p) => !st.data.votes[p.id]);
      if (voters.length) {
        s.apply({ by: voters[0].id, type: 'vote', payload: { target: pick(voters[0].id) } });
        continue;
      }
      // 平票时 votes 未清空，强制推进到下一天
      s.apply({ by: 'system', type: 'force-dawn' });
      continue;
    }
    if (st.data.nightStep === null) {
      s.apply({ by: 'system', type: 'dawn' });
      continue;
    }
    break;
  }
  const st = s.current;
  return {
    ok: s.isOver() || st.phase === 'finished',
    day: st.data.day,
    turn: st.turn,
    alive: st.players.filter((p) => p.alive).length,
    winners: st.winners?.length ?? 0,
    deaths: st.data.deaths.length,
    guard,
  };
}

/* ---------------- 大富翁 ---------------- */
function simMonopoly(seed) {
  const g = getGame('monopoly');
  const ps = players(4);
  const s = GameSession.create(g, ps, seed);
  let guard = 0;
  while (!s.isOver() && guard++ < 600) {
    const st = s.current;
    const cur = st.pending[0];
    if (!cur) break;
    if (st.data.awaitingBuy === cur) {
      s.apply({ by: cur, type: guard % 2 === 0 ? 'buy' : 'decline' });
      continue;
    }
    if (!st.data.rolled) {
      s.apply({ by: cur, type: 'roll' });
      continue;
    }
    s.apply({ by: cur, type: 'end-turn' });
  }
  const st = s.current;
  return {
    ok: s.isOver() || guard < 600,
    turn: st.turn,
    bankrupt: st.data.bankrupt.length,
    alive: st.players.filter((p) => p.alive).length,
    winners: st.winners?.length ?? 0,
    cash: st.players.map((p) => st.data.cash[p.id]),
  };
}

/* ---------------- 三国杀 ---------------- */
function simSanguosha(seed) {
  const g = getGame('sanguosha');
  const ps = players(6);
  const s = GameSession.create(g, ps, seed);
  let guard = 0;
  let noProgress = 0;
  let lastSig = '';
  while (!s.isOver() && guard++ < 900) {
    const st = s.current;
    const sig = `${st.turn}|${st.data.phase}|${st.pending[0]}|${st.data.responses.length}|${st.data.dead.length}`;
    if (sig === lastSig) {
      if (++noProgress > 20) break;
    } else noProgress = 0;
    lastSig = sig;

    const cur = st.pending[0];
    if (!cur) break;
    const resp = st.data.responses.find((r) => r.to === cur);
    if (resp) {
      if (resp.kind === 'duel') s.apply({ by: cur, type: 'duel-slash' });
      else s.apply({ by: cur, type: guard % 3 === 0 ? 'take-hit' : 'respond' });
      continue;
    }
    if (st.data.phase === 'draw') {
      s.apply({ by: cur, type: 'draw' });
      continue;
    }
    // 出牌阶段：依次尝试各种动作，任何一个生效就继续；
    // 全都无效（例如杀已达次数上限）则结束回合。
    const alive = st.players.filter((p) => p.alive && p.id !== cur);
    const hand = st.data.hands[cur] ?? [];
    const has = (k) => hand.some((c) => c.kind === k);
    const before = JSON.stringify(st);
    const attempts = [];
    if (has('slash') && alive.length) attempts.push({ type: 'play-slash', payload: { target: alive[guard % alive.length].id } });
    if (has('peach') && (st.data.hp[cur] ?? 0) < (st.data.maxHp[cur] ?? 0)) attempts.push({ type: 'play-peach' });
    if (has('barbarian')) attempts.push({ type: 'play-barbarian' });
    if (has('arrow')) attempts.push({ type: 'play-arrow' });
    if (has('duel') && alive.length) attempts.push({ type: 'play-duel', payload: { target: alive[guard % alive.length].id } });

    let progressed = false;
    for (const a of attempts) {
      if (s.apply({ by: cur, ...a })) {
        progressed = true;
        break;
      }
    }
    if (!progressed) {
      s.apply({ by: cur, type: 'end-turn' });
      if (JSON.stringify(s.current) === before) break; // 完全无法推进
    }
  }
  const st = s.current;
  return {
    ok: guard < 800,
    turn: st.turn,
    dead: st.data.dead.length,
    alive: st.players.filter((p) => p.alive).length,
    lordAlive: st.players.find((p) => p.id === st.data.lord)?.alive,
    winners: st.winners?.length ?? 0,
  };
}

for (const seed of [1, 7, 42]) {
  console.log(`\n--- seed ${seed} ---`);
  console.log('werewolf :', JSON.stringify(simWerewolf(seed)));
  console.log('monopoly :', JSON.stringify(simMonopoly(seed)));
  console.log('sanguosha:', JSON.stringify(simSanguosha(seed)));
}
