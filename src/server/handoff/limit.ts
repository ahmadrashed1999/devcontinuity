import { AGENT_LABELS } from '../adapters';
import { getSetting, prisma, setSetting } from '../db';

/**
 * Automatic handoff when an agent stops on a usage, rate or billing limit: the session is flagged,
 * the owner is notified, and the Overview offers to continue the same work in another agent with
 * one click (launch it with the briefing, or copy the briefing).
 */

/** Limit wording seen in Claude Code, Codex, Gemini CLI, Copilot, Cursor and API error messages. */
export const LIMIT_RE = /\b(usage|rate|session|weekly|daily|monthly|5-hour|token|spend|plan)[ -]?limits?\b|\blimit (reached|exceeded|hit)\b|hit (your|the) (\w+ )?limit|quota|credit balance|out of credits|insufficient[_ ](credits|quota|funds)|billing|subscription|payment required|too many requests|\b429\b|rate[_ ]limit/i;

export function isLimitEnding(endState: string | null | undefined, detail: string | null | undefined): boolean {
  return endState === 'api_error' && LIMIT_RE.test(detail ?? '');
}

/** Agents a stopped session can be continued in. "launch": DevContinuity can open it with the briefing. */
export const CONTINUE_TARGETS = [
  { id: 'codex', launch: true },
  { id: 'claude-code', launch: true },
  { id: 'opencode', launch: true },
  { id: 'cursor', launch: true },
  { id: 'gemini-cli', launch: false },
  { id: 'windsurf', launch: false },
  { id: 'antigravity', launch: false },
  { id: 'copilot', launch: false },
  { id: 'generic', launch: false },
] as const;
export type ContinueTarget = (typeof CONTINUE_TARGETS)[number]['id'];
export const CONTINUE_TARGET_IDS = CONTINUE_TARGETS.map((t) => t.id) as string[];

export const targetLabel = (id: string): string => (id === 'generic' ? 'any AI' : (AGENT_LABELS as Record<string, string>)[id] ?? id);
export const canLaunch = (id: string): boolean => CONTINUE_TARGETS.some((t) => t.id === id && t.launch);

/** Briefing wording per target (renderContinuationPrompt knows these ids). */
export const PROMPT_FLAVOR: Record<string, string> = { codex: 'codex', 'claude-code': 'claude-code', opencode: 'opencode', cursor: 'cursor' };

export async function getFallbackAgent(): Promise<ContinueTarget> {
  const v = await getSetting<string>('fallbackAgent', 'codex');
  return (CONTINUE_TARGET_IDS.includes(v) ? v : 'codex') as ContinueTarget;
}

export async function setFallbackAgent(id: string): Promise<void> {
  if (!CONTINUE_TARGET_IDS.includes(id)) throw Object.assign(new Error(`Unknown agent "${id}".`), { status: 400 });
  await setSetting('fallbackAgent', id);
}

/** The preferred fallback first, then the rest; never the agent that just stopped. */
export function rankTargets(fromAgent: string, preferred: string): ContinueTarget[] {
  const ids = CONTINUE_TARGET_IDS.filter((id) => id !== fromAgent);
  const first = ids.includes(preferred) ? preferred : ids[0];
  return [first, ...ids.filter((id) => id !== first)] as ContinueTarget[];
}

export interface LimitHandoff {
  sessionId: string;
  agent: string;
  agentLabel: string;
  title: string | null;
  project: { id: string; name: string } | null;
  cwd: string | null;
  endedAt: Date | null;
  detail: string | null;
  targets: ContinueTarget[];
}

/**
 * Limit stops from the last few days that nobody has picked up yet: no later session in the same
 * project (or folder) and not dismissed.
 */
export async function pendingLimitHandoffs(opts: { days?: number; now?: number } = {}): Promise<LimitHandoff[]> {
  const db = prisma();
  const since = new Date((opts.now ?? Date.now()) - (opts.days ?? 3) * 86_400_000);
  const rows = await db.session.findMany({
    where: { isSubagent: false, endState: 'api_error', endedAt: { gte: since } },
    orderBy: { endedAt: 'desc' },
    take: 40,
    include: { project: { select: { id: true, name: true } } },
  });
  const limited = rows.filter((s) => isLimitEnding(s.endState, s.endStateDetail));
  if (!limited.length) return [];
  const dismissed = new Set(await getSetting<string[]>('limitHandoffDismissed', []));
  const preferred = await getFallbackAgent();
  const out: LimitHandoff[] = [];
  const seen = new Set<string>();
  for (const s of limited) {
    if (dismissed.has(s.id)) continue;
    const scope = s.projectId ?? s.cwd ?? s.id;
    if (seen.has(scope)) continue; // one card per project: the latest stop
    seen.add(scope);
    const later = await db.session.count({
      where: { isSubagent: false, id: { not: s.id }, startedAt: { gt: s.endedAt ?? s.startedAt ?? since }, ...(s.projectId ? { projectId: s.projectId } : s.cwd ? { cwd: s.cwd } : { id: '__none__' }) },
    });
    if (later > 0) continue;
    out.push({ sessionId: s.id, agent: s.agent, agentLabel: targetLabel(s.agent), title: s.title, project: s.project, cwd: s.cwd, endedAt: s.endedAt, detail: s.endStateDetail, targets: rankTargets(s.agent, preferred) });
  }
  return out;
}

export async function dismissLimitHandoff(sessionId: string): Promise<void> {
  const list = await getSetting<string[]>('limitHandoffDismissed', []);
  if (!list.includes(sessionId)) await setSetting('limitHandoffDismissed', [...list, sessionId].slice(-200));
}

/** Notification copy for a limit stop. */
export function limitNotice(agent: string, where: string, detail: string | null, fallback: string) {
  return {
    title: `${targetLabel(agent)} hit its limit in ${where}`,
    body: `Continue in ${targetLabel(fallback)} with one click from the Overview (the briefing has the last request, changed files and errors).${detail ? ` Reason: ${detail}` : ''}`,
  };
}
