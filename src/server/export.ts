import fs from 'node:fs';
import { AGENT_LABELS } from './adapters';
import { parseJson, prisma } from './db';
import { readRawRange } from './parsers/jsonl';
import { safeFileName } from './security/paths';
import { redactDeep, redactSecrets } from './security/redact';

/** Original record behind one event, read from the archive copy (never the original file), with secrets redacted. */
export async function rawRecord(sessionId: string, seq: number) {
  const db = prisma();
  const e = await db.event.findFirst({ where: { sessionId, seq } });
  const s = await db.session.findUnique({ where: { id: sessionId }, select: { archivePath: true } });
  if (!e || !s) throw Object.assign(new Error('Event not found.'), { status: 404 });
  if (e.rawOffset == null || e.rawLength == null || !s.archivePath || !fs.existsSync(s.archivePath)) return { available: false, reason: 'The original record is not available (no byte range recorded, or the archive copy is missing).' };
  const maxBytes = 2 * 1024 * 1024;
  const text = await readRawRange(s.archivePath, e.rawOffset, Math.min(e.rawLength, maxBytes));
  if (e.rawLength > maxBytes) return { available: true, truncated: true, bytes: e.rawLength, text: redactSecrets(text) };
  try {
    return { available: true, truncated: false, bytes: e.rawLength, record: redactDeep(JSON.parse(text)) };
  } catch {
    return { available: true, truncated: false, bytes: e.rawLength, text: redactSecrets(text) };
  }
}

const PAGE = 2000;

/** Streams a session export. Event text is already redacted at import; full originals stay in the archive. */
export async function exportSession(sessionId: string, format: 'json' | 'jsonl' | 'markdown'): Promise<Response> {
  const db = prisma();
  const s = await db.session.findUnique({ where: { id: sessionId }, include: { project: { select: { name: true, rootPath: true } } } });
  if (!s) throw Object.assign(new Error('Session not found.'), { status: 404 });
  const enc = new TextEncoder();
  const header = { id: s.id, agent: s.agent, externalId: s.externalId, title: s.title, project: s.project, cwd: s.cwd, worktree: s.worktree, gitBranch: s.gitBranch, startedAt: s.startedAt, endedAt: s.endedAt, endState: s.endState, endStateDetail: s.endStateDetail, models: parseJson(s.models, []), summary: s.summary, eventCount: s.eventCount, sourcePath: s.sourcePath, sha256: s.sha256, exportedAt: new Date().toISOString(), note: 'Exported by DevContinuity. Secrets are redacted and long texts may be truncated; the byte-exact original is kept in the local archive.' };
  const stream = new ReadableStream({
    async start(controller) {
      const w = (t: string) => controller.enqueue(enc.encode(t));
      if (format === 'json') w(`{"session":${JSON.stringify(header)},"events":[`);
      else if (format === 'jsonl') w(`${JSON.stringify({ type: 'session', ...header })}\n`);
      else {
        w(`# ${s.title ?? 'Session'}\n\n- Agent: ${AGENT_LABELS[s.agent] ?? s.agent}\n- Session id: \`${s.externalId}\`\n- Project: ${s.project?.name ?? '-'} (${s.project?.rootPath ?? s.cwd ?? '-'})\n- Active: ${s.startedAt?.toISOString() ?? '?'} → ${s.endedAt?.toISOString() ?? '?'}\n- Ended: ${s.endState} — ${s.endStateDetail ?? ''}\n\n> ${header.note}\n\n`);
      }
      let after = -1;
      let first = true;
      for (;;) {
        const rows = await db.event.findMany({ where: { sessionId, seq: { gt: after } }, orderBy: { seq: 'asc' }, take: PAGE });
        if (rows.length === 0) break;
        for (const e of rows) {
          const ev = { seq: e.seq, kind: e.kind, role: e.role, rawType: e.rawType, subtype: e.subtype, timestamp: e.timestamp, toolName: e.toolName, toolUseId: e.toolUseId, isError: e.isError, isMeta: e.isMeta, model: e.model, filePath: e.filePath, command: e.command, text: e.text, truncated: e.truncated, meta: parseJson(e.meta, null) };
          if (format === 'json') {
            w(`${first ? '' : ','}${JSON.stringify(ev)}`);
            first = false;
          } else if (format === 'jsonl') w(`${JSON.stringify(ev)}\n`);
          else if (['user_message', 'assistant_message', 'tool_call', 'tool_result', 'error', 'summary'].includes(e.kind) && !(e.kind === 'user_message' && e.isMeta)) {
            const t = e.timestamp ? e.timestamp.toISOString().slice(0, 19).replace('T', ' ') : '';
            const title = e.kind === 'user_message' ? 'User' : e.kind === 'assistant_message' ? 'Assistant' : e.kind === 'tool_call' ? `Tool call: ${e.toolName ?? ''}` : e.kind === 'tool_result' ? `Tool result${e.isError ? ' (error)' : ''}` : e.kind === 'summary' ? 'Summary' : 'Error';
            const body = (e.text ?? '').replace(/```/g, '`\u200b``');
            w(`### ${title} · ${t}\n\n${e.kind === 'user_message' || e.kind === 'assistant_message' ? body : `\`\`\`\n${body.slice(0, 4000)}\n\`\`\``}\n\n`);
          }
        }
        after = rows[rows.length - 1].seq;
      }
      if (format === 'json') w(']}');
      controller.close();
    },
  });
  const ext = format === 'markdown' ? 'md' : format;
  const type = format === 'markdown' ? 'text/markdown; charset=utf-8' : format === 'jsonl' ? 'application/x-ndjson' : 'application/json';
  return new Response(stream, { headers: { 'Content-Type': type, 'Content-Disposition': `attachment; filename="${safeFileName(`${s.title ?? s.externalId}`.slice(0, 60))}-${s.externalId.slice(0, 8)}.${ext}"` } });
}
