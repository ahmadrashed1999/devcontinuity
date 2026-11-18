import crypto from 'node:crypto';
import { prisma } from '../db';
import { NormalizedSession, clip, isTrivialPrompt } from '../adapters/types';

export const TASK_STATUSES = ['completed', 'in_progress', 'pending', 'blocked', 'failed', 'requires_verification', 'cancelled'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const VERIFICATION_LEVELS = ['unverified', 'ai_reported', 'evidence_found', 'verified', 'failed'] as const;
export const PRIORITIES = ['low', 'medium', 'high', 'critical'] as const;

export interface Evidence {
  /** user_request | assistant_response | files_modified | git_commit | tool_errors | session_end | agent_todo | manual_note | ai_analysis */
  type: string;
  detail: string;
  sessionId?: string;
  seq?: number;
  at?: string;
}

/**
 * The central rule of task tracking: an agent saying "done" is a claim, not a fact.
 * Anything an agent reports as finished becomes `requires_verification`; only a person
 * (or a check they trigger) can set `completed`.
 */
export function statusFromAgentClaim(reported: string | undefined): TaskStatus {
  switch ((reported ?? '').toLowerCase()) {
    case 'completed':
    case 'complete':
    case 'done':
    case 'finished':
      return 'requires_verification';
    case 'in_progress':
    case 'in-progress':
    case 'active':
    case 'running':
      return 'in_progress';
    case 'cancelled':
    case 'canceled':
    case 'deleted':
      return 'cancelled';
    case 'blocked':
      return 'blocked';
    case 'failed':
      return 'failed';
    default:
      return 'pending';
  }
}

const h = (s: string) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);

export interface DerivedTask {
  dedupeKey: string;
  title: string;
  description?: string;
  status: TaskStatus;
  priority: string;
  source: 'user_request' | 'agent_todo';
  aiReportedStatus?: string;
  verification: string;
  evidence: Evidence[];
  relatedFiles: string[];
  sourceEventSeq?: number;
  occurredAt?: Date;
}

/** Turns one normalized session into task candidates, each carrying the transcript evidence it was derived from. */
export function deriveTasks(sessionId: string, sourceKey: string, s: NormalizedSession): DerivedTask[] {
  const out: DerivedTask[] = [];
  if (s.isSubagent) return out;
  const sk = h(sourceKey);

  s.prompts.forEach((p, i) => {
    if (isTrivialPrompt(p.text)) return;
    const isLast = i === s.prompts.length - 1;
    const at = p.timestamp?.toISOString();
    const evidence: Evidence[] = [{ type: 'user_request', detail: 'Requested by the user in this session.', sessionId, seq: p.seq, at }];
    let status: TaskStatus;
    let aiReported: string;
    let verification = 'unverified';

    if (p.answered) {
      status = 'requires_verification';
      aiReported = 'responded';
      verification = 'ai_reported';
      evidence.push({ type: 'assistant_response', detail: `The assistant ended its turn with a response (a claim, not verified): ${clip(p.finalResponse ?? '', 400)}`, sessionId, seq: p.finalSeq });
    } else if (!isLast) {
      status = 'requires_verification';
      aiReported = 'superseded';
      evidence.push({ type: 'session_end', detail: 'The user sent another message before the assistant finished this request, so its outcome is unknown.', sessionId });
    } else if (s.endState === 'api_error') {
      status = 'blocked';
      aiReported = 'error';
      evidence.push({ type: 'session_end', detail: `The session stopped on an API error: ${clip(s.endStateDetail ?? '', 300)}`, sessionId });
    } else {
      status = 'in_progress';
      aiReported = 'interrupted';
      evidence.push({ type: 'session_end', detail: `The session ended before the assistant finished this request. ${s.endStateDetail ?? ''}`.trim(), sessionId });
    }
    if (p.filesModified.length) {
      evidence.push({ type: 'files_modified', detail: `${p.filesModified.length} file(s) were written successfully by tools during this request (transcript record, not a check of the current disk).`, sessionId });
    }
    if (p.commits.length) {
      verification = 'evidence_found';
      evidence.push({ type: 'git_commit', detail: `Commit(s) recorded by the git tool during this request: ${p.commits.slice(0, 8).join(', ')}`, sessionId });
    }
    if (p.toolErrors) evidence.push({ type: 'tool_errors', detail: `${p.toolErrors} tool call(s) returned errors while working on this request.`, sessionId });

    const firstLine = p.text.split('\n').find((l) => l.trim()) ?? p.text;
    out.push({
      dedupeKey: `ur:${sk}:${h(p.key)}`,
      title: clip(firstLine.trim(), 140),
      description: p.text,
      status,
      priority: status === 'in_progress' || status === 'blocked' ? 'high' : 'medium',
      source: 'user_request',
      aiReportedStatus: aiReported,
      verification,
      evidence,
      relatedFiles: p.filesModified.slice(0, 40),
      sourceEventSeq: p.seq,
      occurredAt: p.timestamp,
    });
  });

  for (const t of s.todos) {
    out.push({
      dedupeKey: `todo:${sk}:${h(t.key)}`,
      title: clip(t.content, 140),
      description: t.content.length > 140 ? t.content : undefined,
      status: statusFromAgentClaim(t.status),
      priority: ['low', 'medium', 'high', 'critical'].includes(t.priority ?? '') ? (t.priority as string) : 'medium',
      source: 'agent_todo',
      aiReportedStatus: t.status,
      verification: /^(completed|complete|done)$/i.test(t.status) ? 'ai_reported' : 'unverified',
      evidence: [{ type: 'agent_todo', detail: `From the agent's own todo list, where it was marked "${t.status}". Agent-reported status is not proof of completion.`, sessionId }],
      relatedFiles: [],
      occurredAt: s.endedAt,
    });
  }
  return out;
}

/** Writes derived tasks. Tasks a person has edited (manualOverride) keep their status and verification. */
export async function saveDerivedTasks(sessionId: string, projectId: string | null, agent: string, tasks: DerivedTask[]): Promise<number> {
  const db = prisma();
  let n = 0;
  for (const t of tasks) {
    const base = {
      projectId,
      sessionId,
      title: t.title,
      description: t.description,
      agent,
      source: t.source,
      aiReportedStatus: t.aiReportedStatus,
      evidence: JSON.stringify(t.evidence),
      relatedFiles: JSON.stringify(t.relatedFiles),
      sourceEventSeq: t.sourceEventSeq,
      occurredAt: t.occurredAt,
    };
    const existing = await db.task.findUnique({ where: { dedupeKey: t.dedupeKey } });
    if (existing) {
      await db.task.update({ where: { id: existing.id }, data: existing.manualOverride ? base : { ...base, status: t.status, verification: t.verification, priority: t.priority } });
    } else {
      await db.task.create({ data: { ...base, dedupeKey: t.dedupeKey, status: t.status, verification: t.verification, priority: t.priority } });
    }
    n++;
  }
  return n;
}
