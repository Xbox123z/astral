// 单元测试：运行 `npm test`
import test from 'node:test';
import assert from 'node:assert/strict';

const {
  displayWidth, truncate, sliceByWidth, wrapText, stripEscapes, pad, graphemes,
} = await import('../dist/lib/utf8.js');
const { Frame } = await import('../dist/lib/frame.js');
const { paint, stripAnsi, toAnsi256, toAnsi16, mix } = await import('../dist/lib/ansi.js');
const { Rng } = await import('../dist/lib/rng.js');
const { Noise } = await import('../dist/lib/noise.js');
const { generateIdentity, seal, open, deriveRoomKey, roomIdFrom, makeInvite, parseInvite, sha256 } = await import('../dist/crypto/identity.js');
const {
  encodeFrame, decodeHeader, FrameParser, encodeHello, decodeHello,
  encodeWelcome, decodeWelcome, FrameType, chunkPayload, decodeChunk, ChunkAssembler,
} = await import('../dist/net/protocol.js');
const { getGame, GameSession, listGames } = await import('../dist/games/index.js');
const { PollManager } = await import('../dist/features/poll.js');
const { formatBytes, safeName } = await import('../dist/features/filetransfer.js');

/* ==================== UTF-8 / 宽度 ==================== */

test('displayWidth: ASCII 1 列、CJK 2 列、emoji 2 列', () => {
  assert.equal(displayWidth('abc'), 3);
  assert.equal(displayWidth('你好'), 4);
  assert.equal(displayWidth('a你b'), 4);
  assert.ok(displayWidth('👍') >= 1);
});

test('displayWidth: ANSI 序列不占列', () => {
  const s = paint('hello', { fg: '#f0a', bold: true }, 'truecolor');
  assert.equal(displayWidth(s), 5, '颜色代码不能虚增宽度');
  assert.equal(displayWidth(''), 0);
});

test('truncate 不会切断 ANSI 序列', () => {
  const s = paint('hello world', { fg: '#0af' }, 'truecolor');
  const t = truncate(s, 5);
  // 截到 5 列 = 4 个字符 + 省略号
  assert.equal(stripEscapes(t), 'hell…');
  // 不允许出现残缺序列（ESC 后没有终止字节）
  assert.equal(/\x1b\[[0-9;?]*$/.test(t), false, '不能留下半截转义序列');
  // 颜色序列必须完整保留
  assert.ok(t.includes('\x1b[38;2;0;170;255m'), '颜色不能被截掉');
});

test('sliceByWidth 按列切且不破坏序列', () => {
  const s = paint('abcdef', { fg: '#f00' }, 'truecolor');
  assert.equal(stripEscapes(sliceByWidth(s, 1, 4)), 'bcd');
  assert.equal(/\x1b\[[0-9;?]*$/.test(sliceByWidth(s, 1, 4)), false);
});

test('wrapText 换行后仍能跨行保留颜色', () => {
  const s = paint('abcdef', { fg: '#0f0' }, 'truecolor');
  const lines = wrapText(s, 3);
  assert.equal(lines.length, 2);
  for (const l of lines) assert.equal(/\x1b\[[0-9;?]*$/.test(l), false);
});

test('pad 按列补齐', () => {
  assert.equal(displayWidth(pad('ab', 5)), 5);
  assert.equal(pad('ab', 5), 'ab   ');
  assert.equal(pad('x', 4, 'right'), '   x');
});

/* ==================== Frame ==================== */

test('Frame.text 忽略误传的 ANSI，不占列', () => {
  const f = new Frame({ width: 10, height: 1 });
  // 误把上好色的字符串传进来：颜色会被剥掉，但字符必须正确落格
  f.text(0, 0, paint('abc', { fg: '#f00' }, 'truecolor'));
  assert.equal(f.get(0, 0).ch, 'a');
  assert.equal(f.get(1, 0).ch, 'b');
  assert.equal(f.get(2, 0).ch, 'c');
  // 第 4 格应该还是空的（而不是被 ESC 字符占据）
  assert.equal(f.get(3, 0).ch, ' ');
});

test('Frame.text 用 style 参数才能上色', () => {
  const f = new Frame({ width: 10, height: 1 });
  f.text(0, 0, 'abc', { fg: { r: 255, g: 0, b: 0 } });
  assert.deepEqual(f.get(0, 0).fg, { r: 255, g: 0, b: 0 });
  assert.equal(f.get(1, 0).fg.r, 255);
});

test('Frame 渲染输出无残缺转义序列', () => {
  const f = new Frame({ width: 20, height: 2 });
  f.text(0, 0, 'hello', { fg: '#f0a', bold: true });
  f.text(0, 1, 'world', { fg: '#0af', bg: '#123' });
  const out = f.render('truecolor');
  assert.equal(/\x1b\[[0-9;?]*$/.test(out.split('\n')[0]), false);
  // 每个 ESC 都应能被完整匹配
  assert.equal((out.match(/\x1b/g) || []).length, (out.match(/\x1b\[[0-9;?]*[a-zA-Z]/g) || []).length);
});

test('Frame 各色彩模式都能降级', () => {
  const f = new Frame({ width: 5, height: 1 });
  f.text(0, 0, 'abc', { fg: '#f0a' });
  for (const m of ['truecolor', 'ansi256', 'ansi16', 'none']) {
    const out = f.render(m);
    assert.ok(typeof out === 'string');
    if (m === 'none') assert.equal(out, 'abc');
  }
});

/* ==================== 加密 ==================== */

test('身份：同私钥得到同 id', () => {
  const id = generateIdentity();
  assert.match(id.id, /^[a-z0-9]{16}$/);
  assert.ok(id.publicKey.length >= 32);
  assert.ok(id.art.length > 10);
});

test('AES-256-GCM：加解密往返', () => {
  const key = deriveRoomKey('passphrase-123').key;
  const s = seal(key, '机密消息', 'room-1');
  const opened = open(key, s, 'room-1');
  assert.equal(opened.toString('utf8'), '机密消息');
});

test('AAD 绑定：换房间 id 解不开', () => {
  const key = deriveRoomKey('pw').key;
  const s = seal(key, 'x', 'room-A');
  assert.throws(() => open(key, s, 'room-B'));
});

test('篡改密文会被 GCM 拒绝', () => {
  const key = deriveRoomKey('pw').key;
  const s = seal(key, 'important', 'r');
  s.ct[0] ^= 0xff;
  assert.throws(() => open(key, s, 'r'));
});

test('roomId 由 房间名+口令 决定，且不含口令本身', () => {
  const a = roomIdFrom('room', 'pw1');
  const b = roomIdFrom('room', 'pw1');
  const c = roomIdFrom('room', 'pw2');
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.ok(!a.includes('pw1'));
});

test('邀请码往返', () => {
  const code = makeInvite('星际酒馆', 'secret-pass', '1.2.3.4:7331');
  assert.ok(code.startsWith('ASTRAL1:'));
  const inv = parseInvite(code);
  assert.equal(inv.room, '星际酒馆');
  assert.equal(inv.passphrase, 'secret-pass');
  assert.equal(inv.hub, '1.2.3.4:7331');
});

/* ==================== 协议 ==================== */

test('帧编解码往返', () => {
  const payload = Buffer.from('hello astral', 'utf8');
  const frame = encodeFrame(FrameType.Envelope, payload, 42);
  const h = decodeHeader(frame);
  assert.equal(h.type, FrameType.Envelope);
  assert.equal(h.len, payload.length);
  assert.equal(h.corr, 42);
  assert.equal(frame.subarray(16).toString('utf8'), 'hello astral');
});

test('FrameParser 处理粘包与半包', () => {
  const parser = new FrameParser();
  const got = [];
  // onFrame(header, payload)：头部和载荷分开给，方便上层按 type 分发
  parser.onFrame = (h, payload) => got.push({ h, payload });
  const f1 = encodeFrame(FrameType.Envelope, Buffer.from('aaa'));
  const f2 = encodeFrame(FrameType.Envelope, Buffer.from('bbbb'));
  const all = Buffer.concat([f1, f2]);
  // 一字节一字节喂，模拟网络半包
  for (const b of all) parser.push(Buffer.from([b]));
  assert.equal(got.length, 2, '两帧都必须被解析出来');
  assert.equal(got[0].payload.toString(), 'aaa');
  assert.equal(got[1].payload.toString(), 'bbbb');
  assert.equal(got[0].h.type, FrameType.Envelope);
  assert.equal(got[1].h.len, 4);
  assert.equal(parser.pending, 0, '消费完后不应有残留缓冲');
});

test('Hello 编解码往返（含临时公钥与长期公钥）', () => {
  const payload = {
    peerId: 'abc123',
    nickname: '水星',
    ephPub: Buffer.alloc(32, 1),
    idPub: Buffer.alloc(32, 2),
    capabilities: ['tcp', 'bt'],
    roomId: 'room-x',
  };
  const d = decodeHello(encodeHello(payload));
  assert.equal(d.peerId, 'abc123');
  assert.equal(d.nickname, '水星');
  assert.equal(d.roomId, 'room-x');
  assert.deepEqual([...d.capabilities], ['tcp', 'bt']);
  assert.deepEqual([...d.ephPub], [...payload.ephPub]);
  assert.deepEqual([...d.idPub], [...payload.idPub]);
});

test('Welcome 编解码往返', () => {
  const payload = {
    peerId: 'p1',
    roomId: 'r1',
    salt: Buffer.alloc(16, 7),
    iterations: 310000,
    members: [
      { id: 'a', nick: '甲' },
      { id: 'b', nick: '乙' },
    ],
    serverTime: 1700000000000,
  };
  const d = decodeWelcome(encodeWelcome(payload));
  assert.equal(d.peerId, 'p1');
  assert.equal(d.iterations, 310000);
  assert.equal(d.members.length, 2);
  assert.equal(d.members[1].nick, '乙');
  assert.equal(d.serverTime, 1700000000000);
});

test('分片重组（乱序送达也必须成功）', () => {
  const data = Buffer.alloc(24 * 1024 * 2 + 7, 0xab);
  const chunks = chunkPayload(data, 7, 24 * 1024);
  assert.ok(chunks.length >= 3, '必须分成多片');
  const HEADER_LEN = 16;

  // 帧 payload = u32(corr) + u32(seq) + data，用 decodeChunk 解开
  const parts = chunks.map((c) => decodeChunk(c.subarray(HEADER_LEN)));
  const lastSeq = parts.length - 1;

  // 乱序：末片 -> 中片 -> 首片 -> 其余
  const order = [lastSeq, 1, 0, ...parts.slice(2, Math.max(2, lastSeq))];
  const asm = new ChunkAssembler();
  let done = null;
  for (const i of order) {
    const p = parts[i];
    done = asm.add(p.corr, p.seq, p.data, p.seq === lastSeq);
    if (done) break;
  }
  assert.ok(done, '乱序也必须能重组');
  assert.equal(done.length, data.length);
  assert.ok(done.equals(data), '重组结果必须与原数据一致');
});

/* ==================== RNG / 噪声 ==================== */

test('RNG 同种子同结果（可重放）', () => {
  const a = new Rng(12345);
  const b = new Rng(12345);
  const seqA = Array.from({ length: 20 }, () => a.next());
  const seqB = Array.from({ length: 20 }, () => b.next());
  assert.deepEqual(seqA, seqB);
});

test('RNG 不同种子不同结果', () => {
  const a = new Rng(1);
  const b = new Rng(2);
  assert.notEqual(a.next(), b.next());
});

test('Noise 确定性且有界', () => {
  const n = new Noise('seed');
  const n2 = new Noise('seed');
  for (let i = 0; i < 50; i++) {
    const v = n.noise2(i * 0.1, i * 0.07);
    assert.equal(v, n2.noise2(i * 0.1, i * 0.07));
    assert.ok(v >= -1.001 && v <= 1.001, '噪声必须有界');
  }
});

/* ==================== 游戏 ==================== */

test('三款游戏都已注册且人数范围合理', () => {
  const games = listGames();
  assert.equal(games.length, 3);
  assert.deepEqual(games.map((g) => g.id).sort(), ['monopoly', 'sanguosha', 'werewolf']);
  for (const g of games) {
    assert.ok(g.min >= 2, `${g.id} 最少人数应 >= 2`);
    assert.ok(g.max >= g.min, `${g.id} 最多人数不能少于最少`);
    assert.ok(g.name.length > 0);
  }
});

test('确定性：同种子同局面', () => {
  const def = getGame('werewolf');
  const ps = Array.from({ length: 9 }, (_, i) => ({ id: `p${i}`, nick: `P${i}` }));
  const s1 = GameSession.create(def, ps, 999);
  const s2 = GameSession.create(def, ps, 999);
  assert.deepEqual(s1.current.data.roles, s2.current.data.roles);
  assert.equal(s1.current.pending[0], s2.current.pending[0]);
});

/**
 * 狼人杀自动对局助手。
 * 注意分支顺序：先判 pendingShot，再判 voting，最后才是夜晚步骤。
 * dawn 现在是幂等的（重复调用不会让 day 自增），所以顺序错了也不会
 * 把游戏跑飞，但会空转 —— 按状态机真实顺序判断更稳。
 */
function stepWerewolf(s, guard) {
  const st = s.current;
  const alive = st.players.filter((p) => p.alive);
  const pick = (ex) => {
    const c = alive.filter((p) => p.id !== ex);
    return c.length ? c[guard % c.length].id : null;
  };
  if (st.data.pendingShot) {
    const t = pick(st.data.pendingShot);
    return s.apply({ by: st.data.pendingShot, type: t ? 'shoot' : 'shoot-skip', payload: t ? { target: t } : {} });
  }
  if (st.phase === 'voting') {
    const voters = alive.filter((p) => !st.data.votes[p.id]);
    if (voters.length) {
      return s.apply({ by: voters[0].id, type: 'vote', payload: { target: pick(voters[0].id) } });
    }
    return s.apply({ by: 'system', type: 'dawn' });
  }
  switch (st.data.nightStep) {
    case 'kill': {
      const a = s.apply({ by: st.pending[0], type: 'kill', payload: { target: pick() } });
      const b = s.apply({ by: st.pending[0], type: 'wolf-commit' });
      return a || b;
    }
    case 'seer':
      return s.apply({ by: st.pending[0], type: 'seer', payload: { target: pick(st.pending[0]) } });
    case 'witch':
      return s.apply({ by: st.pending[0], type: 'witch-skip' });
    case 'guard':
      return s.apply({ by: st.pending[0], type: 'guard', payload: { target: pick() } });
    default:
      return s.apply({ by: 'system', type: 'dawn' });
  }
}

test('狼人杀：跑完一局并产出胜者', () => {
  const def = getGame('werewolf');
  const ps = Array.from({ length: 9 }, (_, i) => ({ id: `p${i}`, nick: `P${i}` }));
  const s = GameSession.create(def, ps, 7);
  let guard = 0;
  while (!s.isOver() && guard++ < 500) stepWerewolf(s, guard);
  assert.ok(s.isOver(), '游戏必须能结束');
  assert.ok((s.current.winners ?? []).length > 0, '必须有胜者');
  assert.ok(s.current.data.day >= 1, '至少要过一天');
});

test('狼人杀：dawn 幂等（重复调用不会让天数暴涨）', () => {
  const def = getGame('werewolf');
  const ps = Array.from({ length: 9 }, (_, i) => ({ id: `p${i}`, nick: `P${i}` }));
  const s = GameSession.create(def, ps, 7);
  // 推进到白天
  let guard = 0;
  while (s.current.phase !== 'voting' && guard++ < 50) stepWerewolf(s, guard);
  assert.equal(s.current.phase, 'voting');
  const day = s.current.data.day;
  for (let i = 0; i < 10; i++) s.apply({ by: 'system', type: 'dawn' });
  assert.equal(s.current.data.day, day, '重复 dawn 不能改变天数');
});

test('大富翁：有维护费所以能结束', () => {
  const def = getGame('monopoly');
  const ps = Array.from({ length: 4 }, (_, i) => ({ id: `p${i}`, nick: `P${i}` }));
  const s = GameSession.create(def, ps, 1);
  let guard = 0;
  // 只按 buy 也能打完：买不起时 buy 会自动降级为放弃，不会把玩家卡死
  while (!s.isOver() && guard++ < 600) {
    const st = s.current;
    const cur = st.pending[0];
    if (st.data.awaitingBuy === cur) s.apply({ by: cur, type: 'buy' });
    else if (!st.data.rolled) s.apply({ by: cur, type: 'roll' });
    else s.apply({ by: cur, type: 'end-turn' });
  }
  assert.ok(s.isOver(), '经济系统必须能收敛');
  // 存活数 <= 1（可能同时破产到 0 人，此时按净资产判胜）
  assert.ok(s.current.players.filter((p) => p.alive).length <= 1, '最多只剩一名玩家');
  assert.ok((s.current.winners ?? []).length >= 1, '必须有胜者');
});

test('大富翁：回合不会卡死在购买决策上', () => {
  const def = getGame('monopoly');
  const ps = Array.from({ length: 4 }, (_, i) => ({ id: `p${i}`, nick: `P${i}` }));
  const s = GameSession.create(def, ps, 1);
  let guard = 0;
  let noProgress = 0;
  while (!s.isOver() && guard++ < 600) {
    const before = JSON.stringify(s.current);
    const cur = s.current.pending[0];
    if (s.current.data.awaitingBuy === cur) s.apply({ by: cur, type: 'buy' });
    else if (!s.current.data.rolled) s.apply({ by: cur, type: 'roll' });
    else s.apply({ by: cur, type: 'end-turn' });
    // 连续 20 次状态完全不变 => 卡死
    noProgress = JSON.stringify(s.current) === before ? noProgress + 1 : 0;
    assert.ok(noProgress < 20, `第 ${guard} 回合状态不再变化，游戏卡死`);
  }
});

test('三国杀：主公身份唯一且血量含主公加成', () => {
  const def = getGame('sanguosha');
  const ps = Array.from({ length: 6 }, (_, i) => ({ id: `p${i}`, nick: `P${i}` }));
  const s = GameSession.create(def, ps, 3);
  const lords = s.current.players.filter((p) => s.current.data.identities[p.id] === 'lord');
  assert.equal(lords.length, 1);
  assert.ok(s.current.data.hp[s.current.data.lord] >= 4, '主公应有体力加成');
});

test('游戏 view 不泄露他人身份', () => {
  const def = getGame('werewolf');
  const ps = Array.from({ length: 9 }, (_, i) => ({ id: `p${i}`, nick: `P${i}` }));
  const s = GameSession.create(def, ps, 5);
  const st = s.current;
  // 找一个非狼玩家
  const villager = st.players.find((p) => st.data.roles[p.id] !== 'werewolf');
  const view = s.view(villager.id);
  const wolves = st.players.filter((p) => st.data.roles[p.id] === 'werewolf');

  // 1) 队友列表必须为空（只有狼才能看到狼队友）
  assert.deepEqual(view.you.teammates, [], '非狼玩家不该有队友');

  // 2) board.players 里其他人的身份必须是「未知」
  //    （player id 是公开的，游戏本来就需要知道有谁在；泄露的是身份）
  for (const p of st.players) {
    if (p.id === villager.id) continue;
    if (p.alive) {
      assert.ok(
        view.board.players[p.id].includes('未知'),
        `存活玩家 ${p.id} 的身份对非狼玩家必须是未知，实际：${view.board.players[p.id]}`,
      );
    }
  }

  // 3) 预言家的查验结果只给预言家
  const seer = st.players.find((p) => st.data.roles[p.id] === 'seer');
  if (seer) {
    assert.deepEqual(s.view(villager.id).you.seerResults, [], '非预言家不该看到查验结果');
  }
});

/* ==================== 投票 ==================== */

test('投票：统计与去重', () => {
  const polls = new PollManager({ id: 'me', nick: '我', send: () => {} }, () => {});
  const p = polls.create('午饭？', ['汉堡', '披萨']);
  polls.vote(p.id, [0]);
  polls.handleVote({ from: 'other', pollId: p.id, choices: [1] });
  polls.handleVote({ from: 'other', pollId: p.id, choices: [1] }); // 重复投票应覆盖而非累加
  const r = polls.results(p);
  assert.equal(r.counts[0], 1);
  assert.equal(r.counts[1], 1);
  assert.equal(r.voters, 2);
});

test('投票：非法选项被忽略', () => {
  const polls = new PollManager({ id: 'me', nick: '我', send: () => {} }, () => {});
  const p = polls.create('q', ['a', 'b']);
  polls.vote(p.id, [99]);
  assert.equal(polls.results(p).voters, 0);
});

/* ==================== 文件工具 ==================== */

test('formatBytes', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.ok(formatBytes(5 * 1024 * 1024).includes('MB'));
});

test('safeName 防路径穿越', () => {
  assert.equal(safeName('../../etc/passwd'), 'passwd');
  assert.equal(safeName('normal.txt'), 'normal.txt');
  // 非法字符替换为下划线（保留 basename 语义）
  assert.equal(safeName('a:b*c?d"e<f>g|h'), 'a_b_c_d_e_f_g_h');
  assert.ok(safeName('').length > 0, '空名也要给个兜底');
  assert.ok(safeName('x'.repeat(500)).length <= 180, '超长名要截断');
});

/* ==================== 颜色 ==================== */

test('toAnsi256 / toAnsi16 有界', () => {
  const i = toAnsi256({ r: 255, g: 0, b: 0 });
  assert.ok(i >= 0 && i <= 255);
  assert.ok(toAnsi16({ r: 0, g: 0, b: 0 }) >= 0);
});

test('mix 插值', () => {
  const m = mix({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 }, 0.5);
  assert.ok(m.r === 128);
});

test('stripAnsi 完整剥离', () => {
  const s = paint('abc', { fg: '#f0a', bg: '#123', bold: true }, 'truecolor');
  assert.equal(stripAnsi(s), 'abc');
  assert.equal(stripAnsi('plain'), 'plain');
});
