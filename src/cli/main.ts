/**
 * CLI 入口。
 *
 * 子命令：
 *   astral                     交互模式（默认）：发现房间 -> 加入 -> 聊天
 *   astral host                托管一个房间（本机当 hub）
 *   astral join <房间> [口令]   直接进入
 *   astral rooms               列出局域网内发现的房间
 *   astral id                  显示/生成本机身份指纹
 *   astral invite <房间>       生成邀请链接
 *   astral demo                离线演示（不需要网络，看画面和游戏）
 *   astral art [行星]          只打印行星 ASCII 图
 */

import process from 'node:process';
import { Buffer } from 'node:buffer';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

import { parseArgs } from './args.js';
import { runInteractive } from './interactive.js';
import { runHost, runRooms, runJoin, runId, runInvite, runDemo, runArt } from './commands.js';
import { banner } from './help.js';

const VERSION = '0.1.0';

export interface CliEnv {
  argv: string[];
  version: string;
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
}

function detectColorMode(): 'truecolor' | 'ansi256' | 'ansi16' | 'none' {
  if (process.env['NO_COLOR']) return 'none';
  if (!process.stdout.isTTY) return 'none';
  const ct = (process.env['COLORTERM'] ?? '').toLowerCase();
  if (ct.includes('truecolor') || ct.includes('24bit')) return 'truecolor';
  const term = (process.env['TERM'] ?? '').toLowerCase();
  if (term.includes('256color')) return 'ansi256';
  if (process.platform === 'win32') {
    // Win10+ 支持 VT；Windows Terminal 支持真彩
    if (process.env['WT_SESSION']) return 'truecolor';
    return 'ansi16';
  }
  if (term === 'dumb') return 'none';
  return 'ansi256';
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const env: CliEnv = {
    argv,
    version: VERSION,
    stdout: process.stdout,
    stderr: process.stderr,
  };

  const parsed = parseArgs(argv);
  if (parsed.flags['version'] || parsed.flags['v']) {
    env.stdout.write(`astral ${VERSION}  node ${process.version}  ${process.platform}/${os.arch()}\n`);
    return 0;
  }

  const mode = detectColorMode();

  if (parsed.flags['help'] || parsed.flags['h']) {
    env.stdout.write(banner(VERSION, mode) + '\n');
    env.stdout.write(await import('./help.js').then((m) => m.USAGE) + '\n');
    return 0;
  }

  const [cmd, ...rest] = parsed.positional;

  try {
    switch (cmd) {
      case undefined:
      case '':
        return await runInteractive(env, mode);
      case 'host':
        return await runHost(env, mode, rest, parsed.flags);
      case 'join':
        return await runJoin(env, mode, rest, parsed.flags);
      case 'rooms':
        return await runRooms(env, mode, parsed.flags);
      case 'id':
        return await runId(env, mode, parsed.flags);
      case 'invite':
        return await runInvite(env, mode, rest, parsed.flags);
      case 'demo':
        return await runDemo(env, mode, parsed.flags);
      case 'art':
        return await runArt(env, mode, rest, parsed.flags);
      default:
        env.stderr.write(`未知命令：${cmd}\n`);
        env.stdout.write(await import('./help.js').then((m) => m.USAGE) + '\n');
        return 2;
    }
  } catch (err) {
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    env.stderr.write(`\n发生错误：${msg}\n`);
    return 1;
  }
}

/** 供 bin 直接调用；捕获未处理异常避免刷屏 */
export async function run(): Promise<number> {
  let code = 0;
  try {
    code = await main();
  } catch (err) {
    process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    code = 1;
  }
  return code;
}

/**
 * 判断本模块是否作为入口被直接执行。
 * 不能用 import.meta.url 直接和 argv[1] 比较——Windows 上 argv[1] 是
 * 反斜杠路径且没有 file:// 前缀，必须转成 file URL 再比。
 */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  if (entry.endsWith('astral') || entry.endsWith('astral.cmd') || entry.endsWith('astral.js')) return true;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}

// 直接执行时启动
if (isEntryPoint()) {
  void run().then((c) => process.exit(c));
}

export const cli = { main, run, detectColorMode, VERSION };
export default cli;
