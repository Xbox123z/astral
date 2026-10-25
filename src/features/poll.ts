/**
 * 群投票。
 *
 * 设计取舍：
 *  - 完全无中心：每人本地维护一份票箱，收到别人的 vote 就合并。
 *  - 用「投票 id + 选项序号 + 投票人 id」去重，同一人改票以最新为准。
 *  - 不做密码学防伪造（大群里防不住刷票），但每票都带发送者 id，
 *    可以事后审计谁投了什么——这对「朋友局」场景够用且透明。
 *  - 需要匿名时可用 /poll --anonymous，此时只记 hash(peerId+pollId) 用于去重。
 */

import { createHash } from 'node:crypto';
import type { Peer } from '../net/peer.js';

export interface PollOption {
  label: string;
  count: number;
}

export interface Poll {
  id: string;
  question: string;
  options: PollOption[];
  multi: boolean;
  anonymous: boolean;
  creator: string;
  creatorNick: string;
  createdAt: number;
  /** 截止时间（0 = 不限时） */
  closesAt: number;
  /** voterKey -> 选项序号数组 */
  ballots: Map<string, number[]>;
  closed: boolean;
}

export class PollManager {
  private polls = new Map<string, Poll>();
  private onChange: (() => void) | null = null;

  constructor(
    private peer: Peer,
    private notify: (text: string) => void = () => {},
  ) {}

  setChangeHandler(cb: () => void): void {
    this.onChange = cb;
  }

  get active(): Poll | undefined {
    // 最近一个未关闭的
    const list = Array.from(this.polls.values()).filter((p) => !p.closed);
    return list[list.length - 1];
  }

  all(): Poll[] {
    return Array.from(this.polls.values());
  }

  /** 发起投票（同时广播） */
  create(question: string, options: string[], opts: { multi?: boolean; anonymous?: boolean; seconds?: number } = {}): Poll {
    const id = createHash('sha256')
      .update(`${this.peer.id}:${question}:${Date.now()}`)
      .digest('hex')
      .slice(0, 12);
    const poll: Poll = {
      id,
      question,
      options: options.map((o) => ({ label: o, count: 0 })),
      multi: opts.multi ?? false,
      anonymous: opts.anonymous ?? false,
      creator: this.peer.id,
      creatorNick: this.peer.nick,
      createdAt: Date.now(),
      closesAt: opts.seconds ? Date.now() + opts.seconds * 1000 : 0,
      ballots: new Map(),
      closed: false,
    };
    this.polls.set(id, poll);
    this.peer.send({
      t: 'poll-create',
      id,
      from: this.peer.id,
      nick: this.peer.nick,
      question,
      options,
      multi: poll.multi,
      ts: Date.now(),
    });
    this.onChange?.();
    return poll;
  }

  /** 投票；choices 为选项序号（multi 时可多个） */
  vote(pollId: string, choices: number[]): boolean {
    const p = this.polls.get(pollId);
    if (!p || p.closed) return false;
    if (p.closesAt && Date.now() > p.closesAt) {
      p.closed = true;
      return false;
    }
    const valid = choices.filter((c) => c >= 0 && c < p.options.length);
    if (!valid.length) return false;
    if (!p.multi) valid.splice(1); // 单选只保留第一个
    p.ballots.set(this.voterKey(p), valid);
    this.peer.send({
      t: 'poll-vote',
      id: `${pollId}:${Date.now()}`,
      from: this.peer.id,
      pollId,
      choices: valid,
      ts: Date.now(),
    });
    this.onChange?.();
    return true;
  }

  /** 关闭投票（发起人可关） */
  close(pollId: string): void {
    const p = this.polls.get(pollId);
    if (!p) return;
    p.closed = true;
    this.notify(`投票「${p.question}」已关闭`);
    this.onChange?.();
  }

  /* ---------------- 网络事件 ---------------- */

  handleCreate(msg: { id: string; from: string; nick: string; question: string; options: string[]; multi: boolean }): void {
    if (this.polls.has(msg.id)) return;
    const poll: Poll = {
      id: msg.id,
      question: msg.question,
      options: msg.options.map((o) => ({ label: o, count: 0 })),
      multi: msg.multi,
      anonymous: false,
      creator: msg.from,
      creatorNick: msg.nick,
      createdAt: Date.now(),
      closesAt: 0,
      ballots: new Map(),
      closed: false,
    };
    this.polls.set(msg.id, poll);
    this.notify(`📊 ${msg.nick} 发起投票：${msg.question}`);
    this.onChange?.();
  }

  handleVote(msg: { from: string; pollId: string; choices: number[] }): void {
    const p = this.polls.get(msg.pollId);
    if (!p || p.closed) return;
    const key = p.anonymous
      ? createHash('sha256').update(`${msg.from}:${p.id}`).digest('hex').slice(0, 16)
      : msg.from;
    const valid = msg.choices.filter((c) => c >= 0 && c < p.options.length);
    if (!valid.length) return;
    p.ballots.set(key, p.multi ? valid : valid.slice(0, 1));
    this.onChange?.();
  }

  /* ---------------- 统计与渲染 ---------------- */

  private voterKey(p: Poll): string {
    return p.anonymous
      ? createHash('sha256').update(`${this.peer.id}:${p.id}`).digest('hex').slice(0, 16)
      : this.peer.id;
  }

  results(p: Poll): { counts: number[]; voters: number; total: number; percent: number[] } {
    const counts = new Array(p.options.length).fill(0) as number[];
    for (const choices of p.ballots.values()) {
      for (const c of choices) counts[c] = (counts[c] ?? 0) + 1;
    }
    const voters = p.ballots.size;
    const total = counts.reduce((a, b) => a + b, 0) || 1;
    return { counts, voters, total, percent: counts.map((c) => c / total) };
  }

  /** ASCII 结果面板 */
  render(p: Poll, width = 40): string {
    const { counts, voters, percent } = this.results(p);
    const lines: string[] = [];
    const remain = p.closesAt ? Math.max(0, Math.round((p.closesAt - Date.now()) / 1000)) : -1;
    lines.push(`📊 ${p.question}${p.closed ? '（已结束）' : remain >= 0 ? `（${remain}s）` : ''}`);
    p.options.forEach((o, i) => {
      const pct = percent[i] ?? 0;
      const barLen = Math.max(0, Math.min(width - 24, Math.round(pct * (width - 24))));
      const bar = '█'.repeat(barLen) + '░'.repeat(Math.max(0, width - 24 - barLen));
      lines.push(`  ${String(i + 1)}. ${o.label}`);
      lines.push(`     ${bar} ${counts[i]}票 ${(pct * 100).toFixed(0)}%`);
    });
    lines.push(`  共 ${voters} 人参与${p.multi ? '（可多选）' : ''}${p.anonymous ? ' · 匿名' : ''}`);
    return lines.join('\n');
  }
}

export const poll = { PollManager };
export default poll;
