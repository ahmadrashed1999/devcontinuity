import { agentLabel } from './adapters';
import { parseJson, prisma } from './db';
import { isLimitEnding } from './handoff/limit';

/**
 * "AI Coding Wrapped": a month or a year of every agent's work in numbers. The aggregation is a pure
 * function over session rows so it can be tested and reused by the page, the CLI and the share image.
 */

export interface WrappedPeriod {
  kind: 'month' | 'year';
  /** "2026-11" or "2026" */
  key: string;
  start: Date;
  end: Date;
}

/** "2026-11" → that month, "2026" → that year, anything else → the current month. Local time. */
export function parsePeriod(input: string | undefined | null, now = new Date()): WrappedPeriod {
  const m = /^(\d{4})-(\d{2})$/.exec(input ?? '');
  if (m && Number(m[2]) >= 1 && Number(m[2]) <= 12) {
    const y = Number(m[1]);
    const mo = Number(m[2]) - 1;
    return { kind: 'month', key: input as string, start: new Date(y, mo, 1), end: new Date(y, mo + 1, 1) };
  }
  const y = /^(\d{4})$/.exec(input ?? '');
  if (y) return { kind: 'year', key: y[1], start: new Date(Number(y[1]), 0, 1), end: new Date(Number(y[1]) + 1, 0, 1) };
  const key = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  return parsePeriod(key, now);
}

export interface WrappedSessionRow {
  id: string;
  agent: string;
  title: string | null;
  projectName: string | null;
  startedAt: Date | null;
  endedAt: Date | null;
  endState: string;
  userMessageCount: number;
  toolCallCount: number;
  fileOpCount: number;
  providerMeta: string | null;
}

export interface AgentWrapped {
  agent: string;
  label: string;
  sessions: number;
  prompts: number;
  toolCalls: number;
  tokens: number | null;
  costUsd: number | null;
  finished: number;
  interrupted: number;
  errors: number;
  finishRate: number;
  interruptRate: number;
  errorRate: number;
}

export interface WrappedStats {
  period: { kind: 'month' | 'year'; key: string; start: string; end: string };
  totals: { sessions: number; prompts: number; toolCalls: number; agents: number; projects: number; activeDays: number; tokens: number | null; costUsd: number | null; costSessions: number; limitsHit: number };
  agents: AgentWrapped[];
  busiestDays: { day: string; sessions: number }[];
  byWeekday: number[];
  byHour: number[];
  topProjects: { name: string; sessions: number; agents: number }[];
  topTools: { name: string; calls: number }[];
  longest: { id: string; title: string | null; agent: string; label: string; project: string | null; minutes: number } | null;
}

const INTERRUPTED = new Set(['interrupted_tool', 'interrupted_response', 'awaiting_assistant']);

/** Tokens and cost recorded for a session, if any agent reported them. */
export function sessionUsage(providerMeta: string | null): { tokens: number | null; costUsd: number | null } {
  const meta = parseJson<{ usage?: { inputTokens?: number | null; outputTokens?: number | null; costUsd?: number | null } | null; cost?: { totalCostUSD?: number } }>(providerMeta, {});
  const u = meta.usage;
  const tokens = u && (u.inputTokens || u.outputTokens) ? (u.inputTokens ?? 0) + (u.outputTokens ?? 0) : null;
  const c = u?.costUsd ?? meta.cost?.totalCostUSD;
  return { tokens, costUsd: typeof c === 'number' && c > 0 ? c : null };
}

const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const rate = (n: number, d: number) => (d ? n / d : 0);

export function aggregateWrapped(rows: WrappedSessionRow[], period: WrappedPeriod, tools: { name: string; calls: number }[] = []): WrappedStats {
  const sessions = rows.filter((r) => r.endState !== 'empty');
  const agents = new Map<string, AgentWrapped>();
  const days = new Map<string, number>();
  const projects = new Map<string, { sessions: number; agents: Set<string> }>();
  const byWeekday = Array<number>(7).fill(0);
  const byHour = Array<number>(24).fill(0);
  let tokens = 0;
  let tokenSessions = 0;
  let cost = 0;
  let costSessions = 0;
  // Filled in by wrappedStats() from the end-state details (see handoff/limit.ts).
  const limitsHit = 0;
  let longest: WrappedStats['longest'] = null;

  for (const s of sessions) {
    const a = agents.get(s.agent) ?? { agent: s.agent, label: agentLabel(s.agent), sessions: 0, prompts: 0, toolCalls: 0, tokens: null, costUsd: null, finished: 0, interrupted: 0, errors: 0, finishRate: 0, interruptRate: 0, errorRate: 0 };
    a.sessions++;
    a.prompts += s.userMessageCount;
    a.toolCalls += s.toolCallCount;
    if (s.endState === 'completed_turn') a.finished++;
    else if (INTERRUPTED.has(s.endState)) a.interrupted++;
    else if (s.endState === 'api_error') a.errors++;
    const u = sessionUsage(s.providerMeta);
    if (u.tokens != null) {
      a.tokens = (a.tokens ?? 0) + u.tokens;
      tokens += u.tokens;
      tokenSessions++;
    }
    if (u.costUsd != null) {
      a.costUsd = (a.costUsd ?? 0) + u.costUsd;
      cost += u.costUsd;
      costSessions++;
    }
    agents.set(s.agent, a);

    const when = s.endedAt ?? s.startedAt;
    if (when) {
      days.set(dayKey(when), (days.get(dayKey(when)) ?? 0) + 1);
      byWeekday[when.getDay()]++;
      byHour[when.getHours()]++;
    }
    if (s.projectName) {
      const p = projects.get(s.projectName) ?? { sessions: 0, agents: new Set<string>() };
      p.sessions++;
      p.agents.add(s.agent);
      projects.set(s.projectName, p);
    }
    if (s.startedAt && s.endedAt) {
      // Sessions left open for days are not "long sessions": cap at 12 hours of activity.
      const minutes = Math.min((s.endedAt.getTime() - s.startedAt.getTime()) / 60_000, 12 * 60);
      if (minutes > 0 && (!longest || minutes > longest.minutes)) longest = { id: s.id, title: s.title, agent: s.agent, label: agentLabel(s.agent), project: s.projectName, minutes: Math.round(minutes) };
    }
  }
  for (const a of agents.values()) {
    a.finishRate = rate(a.finished, a.sessions);
    a.interruptRate = rate(a.interrupted, a.sessions);
    a.errorRate = rate(a.errors, a.sessions);
  }
  return {
    period: { kind: period.kind, key: period.key, start: period.start.toISOString(), end: period.end.toISOString() },
    totals: {
      sessions: sessions.length,
      prompts: sessions.reduce((n, s) => n + s.userMessageCount, 0),
      toolCalls: sessions.reduce((n, s) => n + s.toolCallCount, 0),
      agents: agents.size,
      projects: projects.size,
      activeDays: days.size,
      tokens: tokenSessions ? tokens : null,
      costUsd: costSessions ? cost : null,
      costSessions,
      limitsHit,
    },
    agents: [...agents.values()].sort((x, y) => y.sessions - x.sessions),
    busiestDays: [...days.entries()].map(([day, n]) => ({ day, sessions: n })).sort((x, y) => y.sessions - x.sessions || x.day.localeCompare(y.day)).slice(0, 5),
    byWeekday,
    byHour,
    topProjects: [...projects.entries()].map(([name, p]) => ({ name, sessions: p.sessions, agents: p.agents.size })).sort((x, y) => y.sessions - x.sessions).slice(0, 5),
    topTools: tools.slice(0, 5),
    longest,
  };
}

export async function wrappedStats(period: WrappedPeriod): Promise<WrappedStats> {
  const db = prisma();
  const where = { isSubagent: false, endedAt: { gte: period.start, lt: period.end } };
  const [rows, tools, limits] = await Promise.all([
    db.session.findMany({ where, select: { id: true, agent: true, title: true, startedAt: true, endedAt: true, endState: true, userMessageCount: true, toolCallCount: true, fileOpCount: true, providerMeta: true, project: { select: { name: true } } } }),
    db.event.groupBy({ by: ['toolName'], where: { kind: 'tool_call', toolName: { not: null }, session: where }, _count: true, orderBy: { _count: { toolName: 'desc' } }, take: 8 }),
    db.session.findMany({ where: { ...where, endState: 'api_error' }, select: { endStateDetail: true } }),
  ]);
  const stats = aggregateWrapped(
    rows.map((r) => ({ ...r, projectName: r.project?.name ?? null })),
    period,
    tools.map((t) => ({ name: t.toolName ?? '?', calls: t._count })),
  );
  stats.totals.limitsHit = limits.filter((l) => isLimitEnding('api_error', l.endStateDetail)).length;
  return stats;
}

/** Months (newest first) and years that have sessions, for the period picker. */
export async function wrappedPeriods(): Promise<{ months: string[]; years: string[] }> {
  const rows = await prisma().session.findMany({ where: { isSubagent: false, endedAt: { not: null } }, select: { endedAt: true } });
  const months = new Set<string>();
  for (const r of rows) if (r.endedAt) months.add(`${r.endedAt.getFullYear()}-${String(r.endedAt.getMonth() + 1).padStart(2, '0')}`);
  const sorted = [...months].sort().reverse();
  return { months: sorted, years: [...new Set(sorted.map((m) => m.slice(0, 4)))] };
}

/** Plain-text version for the CLI ("dc wrapped"). */
export function renderWrappedText(s: WrappedStats): string {
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  const num = (n: number) => n.toLocaleString('en-US');
  const L = [`AI Coding Wrapped ${s.period.key}`, ''];
  L.push(`${num(s.totals.sessions)} sessions · ${num(s.totals.prompts)} prompts · ${num(s.totals.toolCalls)} tool calls · ${s.totals.agents} agents · ${s.totals.projects} projects · ${s.totals.activeDays} active days`);
  if (s.totals.tokens != null) L.push(`${num(s.totals.tokens)} tokens recorded`);
  if (s.totals.costUsd != null) L.push(`$${s.totals.costUsd.toFixed(2)} spent where agents report cost (${s.totals.costSessions} sessions)`);
  if (s.totals.limitsHit) L.push(`${s.totals.limitsHit} usage/rate limit stop(s)`);
  L.push('', 'Agent           sessions  prompts  tools   finished  interrupted  errors');
  for (const a of s.agents) L.push(`${a.label.padEnd(15)} ${String(a.sessions).padStart(8)} ${String(a.prompts).padStart(8)} ${String(a.toolCalls).padStart(6)}   ${pct(a.finishRate).padStart(8)}  ${pct(a.interruptRate).padStart(11)}  ${pct(a.errorRate).padStart(6)}`);
  if (s.topProjects.length) L.push('', `Top projects: ${s.topProjects.map((p) => `${p.name} (${p.sessions})`).join(', ')}`);
  if (s.busiestDays.length) L.push(`Busiest days: ${s.busiestDays.map((d) => `${d.day} (${d.sessions})`).join(', ')}`);
  if (s.topTools.length) L.push(`Most used tools: ${s.topTools.map((t) => `${t.name} (${t.calls})`).join(', ')}`);
  if (s.longest) L.push(`Longest session: ${s.longest.title ?? '(untitled)'} — ${s.longest.label}, ${s.longest.minutes} min`);
  return L.join('\n');
}
