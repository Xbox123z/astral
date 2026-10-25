/** 极简参数解析：支持 --flag、--flag=value、--flag value、-- 之后全当位置参数 */
import { Buffer } from 'node:buffer';

export interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  let noMoreFlags = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (noMoreFlags) {
      positional.push(a);
      continue;
    }
    if (a === '--') {
      noMoreFlags = true;
      continue;
    }
    if (a.startsWith('--')) {
      const body = a.slice(2);
      const eq = body.indexOf('=');
      if (eq >= 0) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('-')) {
          flags[body] = next;
          i++;
        } else {
          flags[body] = true;
        }
      }
      continue;
    }
    if (a.startsWith('-') && a.length > 1) {
      // 短选项合并：-abc -> a,b,c
      for (const ch of a.slice(1)) flags[ch] = true;
      continue;
    }
    positional.push(a);
  }
  return { positional, flags };
}

export function flagStr(flags: Record<string, string | boolean>, name: string, fallback = ''): string {
  const v = flags[name];
  if (v === undefined) return fallback;
  if (typeof v === 'boolean') return v ? '' : fallback;
  return v;
}

export function flagNum(flags: Record<string, string | boolean>, name: string, fallback: number): number {
  const v = flagStr(flags, name);
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function flagBool(flags: Record<string, string | boolean>, name: string): boolean {
  const v = flags[name];
  if (v === undefined) return false;
  return v !== false && v !== 'false' && v !== '0';
}

export const args = { parseArgs, flagStr, flagNum, flagBool };
export default args;
