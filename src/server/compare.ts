import { agentLabel } from './adapters';
import { prisma } from './db';
import { sessionUsage } from './wrapped';

/**
 * Side-by-side agent comparison from recorded sessions: how often each agent finishes, gets
 * interrupted or errors, how many tools it uses per prompt, how many files a session changes and
 * what a finished session costs where cost is recorded. Small samples are flagged, not ranked.
 */

/** Below this many sessions an agent's rates are shown as "not enough data". */
export const MIN_SESSIONS = 5;
/** Cost per finished session needs at least this many finished sessions with a recorded cost. */
export const MIN_COSTED = 3;

export interface CompareInput {
  agent: string;
  endState: string;
  userMessageCount: number;
  toolCallCount: number;
  providerMeta: string | null;
  /** Distinct files written or edited in the session. */
  filesChanged: number;
}

export interface AgentComparison {
  agent: string;
  label: string;
  sessions: number;
  enoughData: boolean;
  completionRate: number | null;
  interruptionRate: number | null;
  errorRate: number | null;
  toolsPerPrompt: number | null;
  filesPerSession: number | null;
  /** null when fewer than MIN_COSTED finished sessions have a cost. */
  costPerCompleted: number | null;
  costedSessions: number;
}

const INTERRUPTED = new Set(['interrupted_tool', 'interrupted_response', 'awaiting_assistant']);

export function compareAgents(rows: CompareInput[]): AgentComparison[] {
  const groups = new Map<string, CompareInput[]>();
  for (const r of rows) if (r.endState !== 'empty') groups.set(r.agent, [...(groups.get(r.agent) ?? []), r]);
  const out: AgentComparison[] = [];
  for (const [agent, list] of groups) {
    const n = list.length;
    const enough = n >= MIN_SESSIONS;
    const finished = list.filter((s) => s.endState === 'completed_turn');
    const prompts = list.reduce((a, s) => a + s.userMessageCount, 0);
    const costs = finished.map((s) => sessionUsage(s.providerMeta).costUsd).filter((c): c is number => c != null);
    out.push({
      agent,
      label: agentLabel(agent),
      sessions: n,
      enoughData: enough,
      completionRate: enough ? finished.length / n : null,
      interruptionRate: enough ? list.filter((s) => INTERRUPTED.has(s.endState)).length / n : null,
      errorRate: enough ? list.filter((s) => s.endState === 'api_error').length / n : null,
      toolsPerPrompt: enough && prompts > 0 ? list.reduce((a, s) => a + s.toolCallCount, 0) / prompts : null,
      filesPerSession: enough ? list.reduce((a, s) => a + s.filesChanged, 0) / n : null,
      costPerCompleted: costs.length >= MIN_COSTED ? costs.reduce((a, c) => a + c, 0) / costs.length : null,
      costedSessions: costs.length,
    });
  }
  return out.sort((a, b) => Number(b.enoughData) - Number(a.enoughData) || b.sessions - a.sessions);
}

export async function agentComparison(days = 90): Promise<{ days: number; agents: AgentComparison[] }> {
  const db = prisma();
  const since = new Date(Date.now() - days * 86_400_000);
  const [sessions, files] = await Promise.all([
    db.session.findMany({ where: { isSubagent: false, endedAt: { gte: since } }, select: { id: true, agent: true, endState: true, userMessageCount: true, toolCallCount: true, providerMeta: true } }),
    db.fileOp.groupBy({ by: ['sessionId', 'path'], where: { op: { in: ['write', 'edit', 'notebook_edit'] }, session: { isSubagent: false, endedAt: { gte: since } } } }),
  ]);
  const perSession = new Map<string, number>();
  for (const f of files) perSession.set(f.sessionId, (perSession.get(f.sessionId) ?? 0) + 1);
  return { days, agents: compareAgents(sessions.map((s) => ({ ...s, filesChanged: perSession.get(s.id) ?? 0 }))) };
}
