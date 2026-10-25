import { paint } from '../lib/ansi.js';

export type ColorMode = 'truecolor' | 'ansi256' | 'ansi16' | 'none';

export const USAGE = `
用法:
  astral                        进入交互模式（自动发现局域网房间）
  astral host --room 名称        在本机托管一个房间
  astral join <房间名> [口令]     直接加入房间
  astral rooms                  扫描并列出局域网房间
  astral id                     显示本机身份指纹
  astral invite <房间名>         生成邀请串
  astral demo                   离线演示（行星画面 + 自动对局）
  astral art [行星名]            打印行星 ASCII 图

常用选项:
  --room <名称>       房间名
  --pass <口令>       房间口令（不上传，仅本地派生密钥）
  --port <端口>       端口（默认 7331）
  --nick <昵称>       昵称
  --theme <主题>      nebula | ember | ice | mono
  --planet <行星>     jupiter | saturn | mars | earth | neptune | uranus
  --bt                启用蓝牙传输（尽力而为，失败自动降级）
  --no-color          关闭颜色
  -h, --help          帮助
  -v, --version       版本
`;

const LOGO = [
  '   ▄▄▄  ▄▄▄▄ ▄▄▄▄▄ ▄▄▄▄  ▄▄▄   ▄     ',
  '  █   █ █    █ ▄▄▄ █   █ █   █ █     ',
  '  █████ ████ █▄▄▄▄ █████ █████ █     ',
  '  █   █    █ █  ▄▄ █   █ █   █ █     ',
  '  █   █ ████ █  ▀▀ █   █ █   █ ████  ',
];

const GRAD = ['#6ad', '#8cf', '#b9f', '#f9a', '#fc6'];

export function banner(version: string, mode: ColorMode): string {
  const art = LOGO.map((l, i) => paint(l, { fg: GRAD[i]!, bold: true }, mode)).join('\n');
  const sub = paint(
    `  终端星河 v${version} · 局域网/热点/蓝牙 · 端到端加密 · 千人房间`,
    { fg: '#888' },
    mode,
  );
  return art + '\n' + sub;
}

export const help = { USAGE, banner };
export default help;
