import fs from 'node:fs';
import path from 'node:path';
import { audit } from '../audit';
import { parseJson, prisma } from '../db';
import { commitExists } from '../git/git';

/**
 * Evidence-based triage of tasks that agents reported as done. For each request it checks, on disk
 * and in Git, whether the recorded changes are still there. The result is only a suggestion: the
 * owner approves it in batches before any task becomes completed.
 */

export type Triage = 'likely_done' | 'likely_not_done' | 'no_code_changes' | 'unknown';

export interface TriageEvidence {
  changes: number;
  present: number;
  missing: number;
  filesGone: number;
  commits: number;
  commitsInRepo: number;
  answered: boolean;
  errors: number;
}

export function decide(e: TriageEvidence, projectAvailable: boolean): { triage: Triage; reason: string } {
  if (!projectAvailable) return { triage: 'unknown', reason: 'The project folder is not available, so nothing could be checked.' };
  if (e.commitsInRepo > 0 && e.answered) return { triage: 'likely_done', reason: `${e.commitsInRepo} recorded commit(s) exist in the repository.` };
  if (e.changes === 0) return e.answered ? { triage: 'no_code_changes', reason: 'The agent answered but changed no files (question, explanation or investigation).' } : { triage: 'likely_not_done', reason: 'No answer and no file changes were recorded.' };
  const ratio = e.present / e.changes;
  if (ratio >= 0.8 && e.answered) return { triage: 'likely_done', reason: `${e.present}/${e.changes} recorded changes are still present in the files${e.errors ? `; ${e.errors} tool error(s) occurred along the way` : ''}.` };
  if (ratio < 0.3) return { triage: 'likely_not_done', reason: `Only ${e.present}/${e.changes} recorded changes are still present (${e.filesGone} file(s) gone). The work may have been reverted or replaced.` };
  return { triage: 'unknown', reason: `${e.present}/${e.changes} recorded changes are present; partial evidence.` };
}

function snippetOf(text: string): string | null {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length >= 18 && !/^[{}()[\];,]+$/.test(l));
  lines.sort((a, b) => b.length - a.length);
  return lines[0]?.slice(0, 160) ?? null;
}

export async function triageProject(projectId: string): Promise<Record<Triage, number>> {
  const db = prisma();
  const project = await db.project.findUnique({ where: { id: projectId } });
  const available = !!project?.pathVerified && fs.existsSync(project.rootPath);
  const tasks = await db.task.findMany({ where: { projectId, status: 'requires_verification', source: 'user_request', manualOverride: false, sessionId: { not: null } }, orderBy: { sourceEventSeq: 'asc' } });
  const counts: Record<Triage, number> = { likely_done: 0, likely_not_done: 0, no_code_changes: 0, unknown: 0 };
  const fileCache = new Map<string, string | null>();
  const read = (p: string) => {
    if (!fileCache.has(p)) {
      try {
        const st = fs.statSync(p);
        fileCache.set(p, st.size < 5_000_000 ? fs.readFileSync(p, 'utf8').replace(/\s+/g, ' ') : null);
      } catch {
        fileCache.set(p, null);
      }
    }
    return fileCache.get(p);
  };
  const bySession = new Map<string, typeof tasks>();
  for (const t of tasks) bySession.set(t.sessionId!, [...(bySession.get(t.sessionId!) ?? []), t]);

  for (const [sessionId, list] of bySession) {
    const session = await db.session.findUnique({ where: { id: sessionId }, select: { providerMeta: true, cwd: true } });
    const prompts = await db.event.findMany({ where: { sessionId, kind: 'user_message', isMeta: false }, select: { seq: true }, orderBy: { seq: 'asc' } });
    const calls = await db.event.findMany({ where: { sessionId, kind: 'tool_call', OR: [{ toolName: { in: ['Edit', 'Write', 'MultiEdit', 'edit', 'write'] } }] }, select: { seq: true, text: true, filePath: true, toolUseId: true }, orderBy: { seq: 'asc' } });
    const errs = await db.event.findMany({ where: { sessionId, kind: 'tool_result', isError: true }, select: { seq: true, toolUseId: true } });
    const failed = new Set(errs.map((e) => e.toolUseId).filter(Boolean));
    const gitOps = parseJson<{ gitOps?: { kind: string; sha?: string; seq: number }[] }>(session?.providerMeta, {}).gitOps ?? [];
    for (const t of list) {
      const start = t.sourceEventSeq ?? 0;
      const next = prompts.find((p) => p.seq > start)?.seq ?? Number.MAX_SAFE_INTEGER;
      const ev: TriageEvidence = { changes: 0, present: 0, missing: 0, filesGone: 0, commits: 0, commitsInRepo: 0, answered: t.aiReportedStatus === 'responded', errors: errs.filter((e) => e.seq > start && e.seq < next).length };
      const seenFiles = new Set<string>();
      for (const c of calls.filter((c) => c.seq > start && c.seq < next && !failed.has(c.toolUseId))) {
        let input: Record<string, unknown> = {};
        try {
          input = JSON.parse(c.text ?? '{}');
        } catch {
          continue;
        }
        const file = (input.file_path as string) ?? (input.filePath as string) ?? c.filePath;
        const newText = (input.new_string as string) ?? (input.newString as string) ?? (input.content as string);
        if (!file || typeof newText !== 'string') continue;
        const abs = path.isAbsolute(file) ? file : path.join(session?.cwd ?? project?.rootPath ?? '', file);
        const snip = snippetOf(newText);
        if (!snip) continue;
        ev.changes++;
        const content = read(abs);
        if (content == null) {
          ev.missing++;
          if (!seenFiles.has(abs)) ev.filesGone++;
        } else if (content.includes(snip.replace(/\s+/g, ' '))) ev.present++;
        else ev.missing++;
        seenFiles.add(abs);
      }
      for (const g of gitOps.filter((g) => g.kind === 'commit' && g.sha && g.seq > start && g.seq < next)) {
        ev.commits++;
        if (available && project && (await commitExists(project.rootPath, g.sha!))) ev.commitsInRepo++;
      }
      const d = decide(ev, available);
      counts[d.triage]++;
      await db.task.update({ where: { id: t.id }, data: { triage: d.triage, triageReason: `${d.reason} [changes ${ev.present}/${ev.changes}, commits ${ev.commitsInRepo}/${ev.commits}, errors ${ev.errors}]` } });
    }
  }
  await audit('owner', 'triage.project', projectId, counts);
  return counts;
}

/** Owner approval of triage suggestions in a batch. */
export async function applyTriage(input: { projectId?: string; triage: Triage; action: 'completed' | 'pending' | 'cancelled'; taskIds?: string[] }): Promise<number> {
  const db = prisma();
  const tasks = await db.task.findMany({ where: { status: 'requires_verification', triage: input.triage, projectId: input.projectId, id: input.taskIds ? { in: input.taskIds } : undefined } });
  for (const t of tasks) {
    const ev = parseJson<unknown[]>(t.evidence, []);
    ev.push({ type: 'manual_note', detail: `Owner approved triage "${input.triage}" → ${input.action}. ${t.triageReason ?? ''}`, at: new Date().toISOString() });
    await db.task.update({ where: { id: t.id }, data: { status: input.action, verification: input.action === 'completed' ? 'verified' : t.verification, manualOverride: true, evidence: JSON.stringify(ev) } });
  }
  await audit('owner', 'triage.apply', input.projectId ?? 'all', { ...input, count: tasks.length });
  return tasks.length;
}
