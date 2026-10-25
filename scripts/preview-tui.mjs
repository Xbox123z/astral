// 渲染 TUI 主界面到文件，供人工检查（避免 ANSI 被 pwsh 管道吞掉）
import fs from 'node:fs';
import { ChatScreen } from '../dist/ui/screen.js';
import { InputLine } from '../dist/ui/widgets.js';
import { THEMES } from '../dist/lib/palette.js';

const W = 110;
const H = 32;
const theme = THEMES['nebula'];

const input = new InputLine('❯ ', 4000);
input.text = '/dm 木星 晚上开黑吗';

const messages = [
  { id: 'm1', nick: '系统', authorId: 'system', text: '欢迎来到 ASTRAL。输入 /help 查看命令。', ts: Date.now() - 90000, system: true },
  { id: 'm2', nick: '水星', authorId: 'aaa111', text: '各位，晚上狼人杀缺两个人，有来的吗？', ts: Date.now() - 80000 },
  { id: 'm3', nick: '金星', authorId: 'bbb222', text: '我来！我玩预言家贼强', ts: Date.now() - 70000 },
  { id: 'm4', nick: '我', authorId: 'me', text: '算我一个，这次不当狼了', ts: Date.now() - 60000 },
  { id: 'm5', nick: '🔒 木星', authorId: 'ccc333', text: '私聊：文件已经发你了，查收', ts: Date.now() - 50000, dm: true },
  { id: 'm6', nick: '土星', authorId: 'ddd444', text: '刚发现个 bug：土星环在窄终端下会被裁掉一截，我修了渲染循环', ts: Date.now() - 40000 },
  { id: 'm7', nick: '天王', authorId: 'eee555', text: '👍', ts: Date.now() - 30000 },
];

const members = [
  { id: 'me', nick: '我' },
  { id: 'aaa111', nick: '水星' },
  { id: 'bbb222', nick: '金星' },
  { id: 'ccc333', nick: '木星' },
  { id: 'ddd444', nick: '土星' },
  { id: 'eee555', nick: '天王' },
  { id: 'fff666', nick: '海王' },
  { id: 'ggg777', nick: '冥王' },
];

const state = {
  ctx: { width: W, height: H, theme, mode: 'truecolor' },
  header: {
    roomName: '星际酒馆',
    roomId: '7f3a9c',
    peerCount: 8,
    transport: 'tcp/7331',
    nick: '我',
    selfId: 'me',
    encrypted: true,
    status: '🎮 werewolf',
  },
  messages,
  members,
  input,
  scroll: 0,
  toast: null,
  planet: 'jupiter',
  t: 12.5,
  typing: ['ccc333'],
  pollPanel: '📊 今晚玩什么？\n  1. 狼人杀\n     ████████████░░░░░░░░ 6票 60%\n  2. 三国杀\n     ████░░░░░░░░░░░░░░░░ 3票 30%\n  3. 大富翁\n     ██░░░░░░░░░░░░░░░░░░ 1票 10%\n  共 10 人参与',
};

const screen = new ChatScreen(state);
const out = screen.render();

// 同时输出一份去掉 ANSI 的纯文本，方便看版式。
// 必须用库里的 stripEscapes —— 手写正则容易漏掉 CSI 的中间字节，
// 看起来就像「输出里有裸露的 m」，其实数据是好的。
const { stripEscapes } = await import('../dist/lib/utf8.js');
const plain = stripEscapes(out);
fs.writeFileSync('preview-tui.txt', out, 'utf8');
fs.writeFileSync('preview-tui-plain.txt', plain, 'utf8');
console.log('rendered', out.length, 'chars,', plain.split('\n').length, 'lines');
console.log('ESC 残留:', (plain.match(/\x1b/g) || []).length);
console.log('--- plain layout ---');
for (const l of plain.split('\n')) console.log(String(l.length).padStart(3), l);
