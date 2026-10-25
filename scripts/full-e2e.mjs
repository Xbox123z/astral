// 全流程验收：host 一个房间 -> 两个 peer 加入 -> 群聊 / DM / 文件 / 投票 / 游戏
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = 7399;
const PASS = 'test-pass-1234';
const ROOM = 'e2e-room';

const log = (...a) => console.log(...a);
const results = [];
function check(name, cond, detail = '') {
  results.push([name, cond]);
  log(`${cond ? '  OK  ' : ' FAIL '} ${name}${detail ? '  ' + detail : ''}`);
}

/* ---------- 1. 启动 hub ---------- */
const hub = spawn(process.execPath, ['dist/cli/main.js', 'host', '--room', ROOM, '--pass', PASS, '--port', String(PORT)], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
let hubOut = '';
hub.stdout.on('data', (d) => (hubOut += d.toString()));
hub.stderr.on('data', (d) => (hubOut += d.toString()));

await sleep(2500);
check('hub 启动并输出邀请码', hubOut.includes('ASTRAL1:'), hubOut.slice(0, 60).replace(/\n/g, ' '));

/* ---------- 2. 两个 peer 加入 ---------- */
function spawnJoiner(nick, extra = []) {
  const p = spawn(process.execPath, ['dist/cli/main.js', 'join', ROOM, PASS, '--hub', `127.0.0.1:${PORT}`, '--nick', nick, ...extra], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  p.stdout.setEncoding('utf8');
  p.stderr.setEncoding('utf8');
  return p;
}

const a = spawnJoiner('alice');
const b = spawnJoiner('bob');
let aOut = '';
let bOut = '';
a.stdout.on('data', (d) => (aOut += d.toString()));
b.stdout.on('data', (d) => (bOut += d.toString()));
await sleep(2000);

check('alice 加入成功', aOut.includes('已加入'), aOut.slice(0, 80).replace(/\n/g, ' '));
check('bob 收到 alice 的 presence', /alice/.test(bOut) || /2 人在线/.test(bOut), bOut.slice(0, 80).replace(/\n/g, ' '));

/* ---------- 3. 群聊 ---------- */
a.stdin.write('hello from alice\n');
await sleep(1500);
check('bob 收到 alice 的群聊消息', bOut.includes('hello from alice'), bOut.split('\n').filter((l) => l.includes('alice')).slice(-1)[0] ?? '');

/* ---------- 4. 私聊 ---------- */
// alice 通过 stdin 直接发 chat；DM 需要 /dm 命令，输入后由 peer.sendDm 发出
a.stdin.write('/dm bob secret-whisper\n');
await sleep(1500);
check('bob 收到 alice 的私聊', bOut.includes('secret-whisper'), bOut.split('\n').filter((l) => l.includes('私')).slice(-1)[0] ?? '');

/* ---------- 5. 文件传输 ---------- */
const tmpFile = path.join(os.tmpdir(), 'astral-e2e.txt');
fs.writeFileSync(tmpFile, 'ASTRAL 文件传输测试 '.repeat(500));
a.stdin.write(`/send ${tmpFile}\n`);
await sleep(4000);
const dl = path.join(os.homedir(), 'astral-downloads', 'astral-e2e.txt');
const dlOk = fs.existsSync(dl) && fs.readFileSync(dl, 'utf8') === fs.readFileSync(tmpFile, 'utf8');
check('文件传输 + SHA-256 校验通过', dlOk, dlOk ? dl : '(未收到或哈希不符)');

/* ---------- 6. 投票 ---------- */
a.stdin.write('/poll "午饭吃什么" 汉堡|披萨|沙拉\n');
await sleep(800);
a.stdin.write('/vote 2\n');
await sleep(2000);
check('投票创建并被统计', bOut.includes('投票') || bOut.includes('披萨'), bOut.split('\n').filter((l) => /投票|披萨/.test(l)).slice(-1)[0] ?? '');

/* ---------- 7. 游戏 ---------- */
a.stdin.write('/game monopoly\n');
await sleep(1500);
check('游戏开局', aOut.includes('开局') || aOut.includes('大富翁'), aOut.split('\n').filter((l) => /开局|大富翁/.test(l)).slice(-1)[0] ?? '');

/* ---------- 清理 ---------- */
a.stdin.write('/quit\n');
b.stdin.write('/quit\n');
await sleep(800);
a.kill();
b.kill();
hub.kill();

log('\n' + '='.repeat(50));
const pass = results.filter((r) => r[1]).length;
log(`结果：${pass}/${results.length} 通过`);
const failed = results.filter((r) => !r[1]);
if (failed.length) {
  log('\n失败项：');
  for (const [n] of failed) log('  ✗ ' + n);
}
process.exit(failed.length ? 1 : 0);
