import { agentLabel } from './adapters';
import { prisma } from './db';

/**
 * Shared memory across agents: a compact, plain-text summary of what every agent did recently in a
 * project folder, its open tasks and its last errors. Served by the MCP tools "project_context" and
 * "recent_activity" so an agent can start where the others stopped, and fed by "log_summary".
 */

const one = (s: string | null | undefined, n: number) => {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const day = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 16).replace('T', ' ') : '-');
const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');

/** The project whose folder contains the directory (deepest match). */
export async function projectForDirectory(directory: string) {
  const dir = norm(directory);
  if (!dir) return null;
  const all = await prisma().project.findMany({ where: { pathVerified: true } });
  return all.filter((p) => dir === p.pathKey || dir.startsWith(`${p.pathKey}/`)).sort((a, b) => b.pathKey.length - a.pathKey.length)[0] ?? null;
}

const END: Record<string, string> = { completed_turn: 'finished', interrupted_tool: 'stopped mid-tool', interrupted_response: 'interrupted', awaiting_assistant: 'no reply yet', api_error: 'error', empty: 'empty', unknown: 'unknown' };

export interface ContextOptions {
  /** Sessions listed per agent. */
  perAgent?: number;
  /** Look back this many days. */
  days?: number;
  now?: number;
}

/** Markdown-ish summary, kept short enough to paste into an agent's context (a few KB). */
export async function projectContext(projectId: string, opts: ContextOptions = {}): Promise<string> {
  const db = prisma();
  const p = await db.project.findUnique({ where: { id: projectId } });
  if (!p) throw new Error('Project not found.');
  const since = new Date((opts.now ?? Date.now()) - (opts.days ?? 14) * 86_400_000);
  const perAgent = opts.perAgent ?? 3;

  const sessions = await db.session.findMany({ where: { projectId, isSubagent: false, endState: { not: 'empty' }, endedAt: { gte: since } }, orderBy: { endedAt: 'desc' }, take: 80 });
  const byAgent = new Map<string, typeof sessions>();
  for (const s of sessions) byAgent.set(s.agent, [...(byAgent.get(s.agent) ?? []), s]);

  const [tasks, errors, files, summaries] = await Promise.all([
    db.task.findMany({ where: { projectId, status: { in: ['in_progress', 'blocked', 'pending', 'requires_verification', 'failed'] } }, orderBy: [{ occurredAt: 'desc' }, { createdAt: 'desc' }], take: 12 }),
    db.event.findMany({ where: { session: { projectId }, OR: [{ kind: 'error' }, { isError: true }], timestamp: { gte: since } }, orderBy: { timestamp: 'desc' }, take: 5, select: { text: true, toolName: true, command: true, timestamp: true, session: { select: { agent: true } } } }),
    db.fileOp.findMany({ where: { projectId, op: { in: ['write', 'edit', 'notebook_edit'] }, timestamp: { gte: since } }, orderBy: { timestamp: 'desc' }, take: 60, select: { path: true, timestamp: true, session: { select: { agent: true } } } }),
    db.event.findMany({ where: { session: { projectId }, kind: 'summary', timestamp: { gte: since } }, orderBy: { timestamp: 'desc' }, take: 4, select: { text: true, timestamp: true, session: { select: { agent: true } } } }),
  ]);

  const L: string[] = [`# Shared memory: ${p.name}`, `Folder: ${p.rootPath}. Everything every AI agent recorded here in the last ${opts.days ?? 14} days, newest first. Verify on disk before relying on it.`, ''];
  if (!sessions.length) L.push('No agent sessions recorded in this period.', '');
  else {
    L.push('## What each agent did');
    for (const [agent, rows] of [...byAgent.entries()].sort((a, b) => (b[1][0].endedAt?.getTime() ?? 0) - (a[1][0].endedAt?.getTime() ?? 0))) {
      L.push(`### ${agentLabel(agent)} (${rows.length} session${rows.length === 1 ? '' : 's'})`);
      for (const s of rows.slice(0, perAgent)) {
        L.push(`- ${day(s.endedAt)} · ${END[s.endState] ?? s.endState} · ${one(s.title ?? s.firstUserPrompt, 90) || '(untitled)'}`);
        if (s.lastUserPrompt && s.lastUserPrompt !== s.title) L.push(`  last request: ${one(s.lastUserPrompt, 160)}`);
        if (s.endState !== 'completed_turn' && s.endStateDetail) L.push(`  stopped because: ${one(s.endStateDetail, 140)}`);
        else if (s.lastAssistantText) L.push(`  last answer: ${one(s.lastAssistantText, 160)}`);
      }
    }
    L.push('');
  }
  if (summaries.length) {
    L.push('## Summaries agents logged (log_summary)');
    for (const e of summaries) L.push(`- ${day(e.timestamp)} ${agentLabel(e.session.agent)}: ${one(e.text, 240)}`);
    L.push('');
  }
  if (tasks.length) {
    L.push('## Open tasks');
    for (const t of tasks) L.push(`- [${t.status.replace(/_/g, ' ')}${t.verification === 'verified' ? '' : `, ${t.verification.replace(/_/g, ' ')}`}] ${one(t.title, 140)}${t.agent ? ` (${agentLabel(t.agent)})` : ''}`);
    L.push('');
  }
  if (errors.length) {
    L.push('## Last errors');
    for (const e of errors) L.push(`- ${day(e.timestamp)} ${agentLabel(e.session.agent)}${e.command ? ` \`${one(e.command, 60)}\`` : e.toolName ? ` ${e.toolName}` : ''}: ${one(e.text, 200)}`);
    L.push('');
  }
  if (files.length) {
    const seen = new Map<string, string>();
    for (const f of files) if (!seen.has(f.path)) seen.set(f.path, agentLabel(f.session.agent));
    const rel = (x: string) => (norm(x).startsWith(`${p.pathKey}/`) ? x.slice(p.rootPath.length + 1).replace(/\\/g, '/') : x);
    L.push('## Files changed recently', ...[...seen.entries()].slice(0, 12).map(([f, a]) => `- ${rel(f)} (${a})`), '');
  }
  L.push('When you finish, call the DevContinuity "log_summary" tool with what you did and what is left, so the next agent knows.');
  return L.join('\n');
}

export async function projectContextForDirectory(directory: string, opts: ContextOptions = {}): Promise<string> {
  const p = await projectForDirectory(directory);
  if (!p) return 'No DevContinuity project matches this directory yet. Nothing other agents did here has been recorded.';
  return projectContext(p.id, opts);
}
