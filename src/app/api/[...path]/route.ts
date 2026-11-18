import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { NextRequest } from 'next/server';
import { ADAPTERS, AGENT_LABELS } from '@/server/adapters';
import type { AgentId } from '@/server/adapters/types';
import { AiError, aiStatus, listModels, testConnection } from '@/server/ai/anthropic';
import { analyzeProject, analyzeSession } from '@/server/ai/features';
import { createBackup, restoreBackup } from '@/server/backup/backup';
import { APP_VERSION, dataPath, ensureDir, timestampSlug } from '@/server/config';
import { ensureDb, getSetting, parseJson, prisma, setSetting } from '@/server/db';
import { getDiff, getGitState } from '@/server/git/git';
import { buildResumeContext, renderContinuationPrompt } from '@/server/handoff/context';
import { createHandoff, dropInHandoff, previewHandoff } from '@/server/handoff/package';
import { runImport, scanAll } from '@/server/import/importer';
import { generateProjectDocs } from '@/server/intelligence/docs';
import { PRIORITIES, TASK_STATUSES, VERIFICATION_LEVELS } from '@/server/intelligence/tasks';
import { cancelJob, getJob, startJob, subscribeJob } from '@/server/jobs/manager';
import { exportSession, rawRecord } from '@/server/export';
import { globalSearch } from '@/server/search';
import { PathError, isInside, safeFileName, validateLocalPath } from '@/server/security/paths';
import { redactSecrets } from '@/server/security/redact';
import { extractZipSafely } from '@/server/zip';
import { v2Routes } from '@/server/api/v2';
import { liveRoutes } from '@/server/api/live';
import { DEMO_MESSAGE, demoAllows, isDemo } from '@/server/demo';

type Ctx = { params: Promise<{ path: string[] }> };
type Handler = (req: NextRequest, m: string[]) => Promise<Response>;

const json = (data: unknown, status = 200) => Response.json(data, { status });
class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
const bad = (msg: string): never => {
  throw new HttpError(400, msg);
};
async function body(req: NextRequest): Promise<Record<string, unknown>> {
  try {
    const b = await req.json();
    return b && typeof b === 'object' ? (b as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
const q = (req: NextRequest, k: string) => req.nextUrl.searchParams.get(k) ?? undefined;
const AGENT_IDS = ADAPTERS.map((a) => a.id) as string[];

function fileResponse(file: string, downloadName: string, type = 'application/zip'): Response {
  const stream = Readable.toWeb(fs.createReadStream(file)) as ReadableStream;
  return new Response(stream, { headers: { 'Content-Type': type, 'Content-Length': String(fs.statSync(file).size), 'Content-Disposition': `attachment; filename="${safeFileName(downloadName)}"` } });
}

async function project(id: string) {
  const p = await prisma().project.findUnique({ where: { id } });
  if (!p) throw new HttpError(404, 'Project not found.');
  return p;
}

const routes: [string, string, Handler][] = [
  ['GET', 'health', async () => json({ ok: true, version: APP_VERSION, ai: await aiStatus() })],

  // ---------- Recovery & import ----------
  ['GET', 'inventory', async (req) => {
    const agents = q(req, 'agent') ? [q(req, 'agent') as AgentId] : undefined;
    const inv = await scanAll({ agents });
    const db = prisma();
    const known = new Map((await db.session.findMany({ select: { sourceKey: true, sourceSize: true, sourceMtime: true } })).map((s) => [s.sourceKey, s]));
    return json(
      inv.map((i) => {
        let imported = 0;
        let changed = 0;
        for (const s of i.sessions) {
          const k = known.get(s.sourceKey);
          if (!k) continue;
          if (k.sourceSize === s.size && k.sourceMtime?.getTime() === s.mtime.getTime()) imported++;
          else changed++;
        }
        return { agent: i.agent, label: i.label, root: i.root, exists: i.exists, assets: i.assets, notes: i.notes.slice(0, 30), unrecoverable: i.unrecoverable, errors: i.errors.slice(0, 30), validation: i.validation, sessionCount: i.sessions.length, subagentCount: i.sessions.filter((s) => s.isSubagent).length, totalBytes: i.sessions.reduce((a, s) => a + (/\.(db|vscdb)$/i.test(s.sourcePath) ? 0 : s.size), 0), alreadyImported: imported, changedSinceImport: changed, newSessions: i.sessions.length - imported - changed, projectDirs: i.projectDirs.sort((a, b) => (b.lastWrite?.getTime() ?? 0) - (a.lastWrite?.getTime() ?? 0)).slice(0, 300) };
      }),
    );
  }],
  ['POST', 'import', async (req) => {
    const b = await body(req);
    const agents = Array.isArray(b.agents) ? (b.agents.filter((a) => AGENT_IDS.includes(String(a))) as AgentId[]) : undefined;
    const extraRoots: Partial<Record<AgentId, string[]>> = {};
    if (typeof b.root === 'string' && b.root.trim()) {
      const agent = (AGENT_IDS.includes(String(b.rootAgent)) ? b.rootAgent : 'claude-code') as AgentId;
      extraRoots[agent] = [validateLocalPath(b.root)];
    }
    const id = await startJob('import', (h) => runImport({ agents, force: b.force === true, includeAssets: b.includeAssets !== false, extraRoots, onlyExtraRoots: b.onlyRoot === true }, h), { exclusive: true });
    return json({ jobId: id }, 202);
  }],
  ['POST', 'upload', async (req) => {
    const form = await req.formData();
    const file = form.get('file');
    if (!(file instanceof File)) bad('No file uploaded.');
    const f = file as File;
    if (f.size > 2 * 1024 * 1024 * 1024) bad('File too large (max 2 GB).');
    const agent = (AGENT_IDS.includes(String(form.get('agent'))) ? String(form.get('agent')) : 'generic') as AgentId;
    const projectId = typeof form.get('projectId') === 'string' && form.get('projectId') ? String(form.get('projectId')) : undefined;
    const name = safeFileName(f.name);
    if (!/\.(json|jsonl|ndjson|zip)$/i.test(name)) bad('Only .json, .jsonl, .ndjson or .zip files can be imported.');
    const root = ensureDir(dataPath('uploads', `${timestampSlug()}-${agent}`));
    const target = agent === 'claude-code' ? ensureDir(path.join(root, 'projects', 'uploaded')) : root;
    const saved = path.join(target, name);
    fs.writeFileSync(saved, Buffer.from(await f.arrayBuffer()), { flag: 'wx' });
    if (/\.zip$/i.test(name)) {
      await extractZipSafely(saved, path.join(target, 'extracted'), { accept: (n) => /\.(json|jsonl|ndjson)$/i.test(n), maxTotalBytes: 8 * 1024 * 1024 * 1024 });
      fs.renameSync(saved, path.join(root, `${name}.original`));
      // Flatten extracted files into the scan location (names made unique, nothing overwritten).
      const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
      for (const fpath of walk(path.join(target, 'extracted'))) {
        let dest = path.join(target, safeFileName(path.relative(path.join(target, 'extracted'), fpath).replace(/[\\/]/g, '__')));
        if (fs.existsSync(dest)) dest = dest.replace(/(\.\w+)$/, `-${Date.now()}$1`);
        fs.renameSync(fpath, dest);
      }
    }
    const jobId = await startJob('import', (h) => runImport({ agents: [agent], extraRoots: { [agent]: [root] }, onlyExtraRoots: true, fallbackProjectId: projectId }, h), { exclusive: true });
    return json({ jobId, savedTo: root }, 202);
  }],
  ['GET', 'jobs', async () => json(await prisma().job.findMany({ orderBy: { createdAt: 'desc' }, take: 30, select: { id: true, type: true, status: true, progress: true, total: true, message: true, error: true, createdAt: true, finishedAt: true } }))],
  ['GET', 'jobs/:id', async (_r, [id]) => {
    const j = await getJob(id);
    return j ? json(j) : json({ error: 'Job not found.' }, 404);
  }],
  ['POST', 'jobs/:id/cancel', async (_r, [id]) => json({ cancelled: cancelJob(id) })],
  ['GET', 'jobs/:id/stream', async (req, [id]) => {
    const first = await getJob(id);
    if (!first) return json({ error: 'Job not found.' }, 404);
    const enc = new TextEncoder();
    let unsub = () => {};
    let ping: ReturnType<typeof setInterval> | undefined;
    const stream = new ReadableStream({
      start(controller) {
        const push = (s: unknown) => {
          try {
            controller.enqueue(enc.encode(`data: ${JSON.stringify(s)}\n\n`));
          } catch {
            /* closed */
          }
        };
        push(first);
        if (first.status !== 'running') return controller.close();
        let last = 0;
        unsub = subscribeJob(id, (s) => {
          const now = Date.now();
          if (s.status === 'running' && now - last < 250) return;
          last = now;
          push(s);
          if (s.status !== 'running') {
            unsub();
            if (ping) clearInterval(ping);
            try {
              controller.close();
            } catch {
              /* closed */
            }
          }
        });
        ping = setInterval(() => controller.enqueue(enc.encode(': ping\n\n')), 15000);
        req.signal.addEventListener('abort', () => {
          unsub();
          if (ping) clearInterval(ping);
        });
      },
      cancel() {
        unsub();
        if (ping) clearInterval(ping);
      },
    });
    return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' } });
  }],

  // ---------- Projects ----------
  ['GET', 'projects', async () => json(await prisma().project.findMany({ orderBy: { lastActivityAt: 'desc' }, include: { _count: { select: { sessions: true, tasks: true } } } }))],
  ['GET', 'projects/:id', async (_r, [id]) => json(await project(id))],
  ['PATCH', 'projects/:id', async (req, [id]) => {
    const b = await body(req);
    await project(id);
    const data: Record<string, unknown> = {};
    if (typeof b.name === 'string' && b.name.trim()) data.name = b.name.trim().slice(0, 120);
    if (typeof b.description === 'string') data.description = b.description.slice(0, 5000);
    if (typeof b.archived === 'boolean') data.archived = b.archived;
    return json(await prisma().project.update({ where: { id }, data }));
  }],
  ['GET', 'projects/:id/git', async (_r, [id]) => {
    const p = await project(id);
    if (!p.pathVerified) return json({ isRepo: false, error: 'The project folder is not known.' });
    const state = await getGitState(p.rootPath);
    await prisma().project.update({ where: { id }, data: { gitState: JSON.stringify(state), gitCheckedAt: new Date(), isGitRepo: state.isRepo } });
    return json(state);
  }],
  ['GET', 'projects/:id/diff', async (req, [id]) => {
    const p = await project(id);
    if (!p.pathVerified) bad('The project folder is not known.');
    return json(await getDiff(p.rootPath, { file: q(req, 'file'), staged: q(req, 'staged') === '1' }));
  }],
  ['POST', 'projects/:id/docs', async (_r, [id]) => {
    await project(id);
    const docs = await generateProjectDocs(id);
    return json({ generated: docs.map((d) => d.docType), dir: docs[0]?.dir });
  }],
  ['PUT', 'projects/:id/docs/:type', async (req, [id, type]) => {
    const b = await body(req);
    if (typeof b.content !== 'string') bad('content is required.');
    const doc = await prisma().knowledgeDoc.upsert({ where: { projectId_docType: { projectId: id, docType: type } }, create: { projectId: id, docType: type, content: String(b.content), source: 'manual' }, update: { content: String(b.content), source: 'manual', generatedAt: new Date() } });
    return json(doc);
  }],

  // ---------- Sessions ----------
  ['GET', 'sessions', async (req) => {
    const where: Record<string, unknown> = {};
    if (q(req, 'projectId')) where.projectId = q(req, 'projectId');
    if (q(req, 'agent')) where.agent = q(req, 'agent');
    if (q(req, 'endState')) where.endState = q(req, 'endState');
    if (q(req, 'subagents') !== '1') where.isSubagent = false;
    if (q(req, 'q')) where.OR = [{ title: { contains: q(req, 'q') } }, { externalId: { contains: q(req, 'q') } }, { firstUserPrompt: { contains: q(req, 'q') } }];
    const take = Math.min(Number(q(req, 'limit')) || 50, 200);
    const skip = Number(q(req, 'offset')) || 0;
    const [rows, total] = await Promise.all([prisma().session.findMany({ where, orderBy: { endedAt: 'desc' }, take, skip, include: { project: { select: { name: true } } } }), prisma().session.count({ where })]);
    return json({ total, rows });
  }],
  ['GET', 'sessions/:id', async (_r, [id]) => {
    const s = await prisma().session.findUnique({ where: { id }, include: { project: { select: { id: true, name: true } } } });
    if (!s) throw new HttpError(404, 'Session not found.');
    const subagents = await prisma().session.findMany({ where: { agent: s.agent, parentExternalId: s.externalId, isSubagent: true }, select: { id: true, title: true, subagentId: true, eventCount: true, endState: true } });
    return json({ ...s, providerMeta: parseJson(s.providerMeta, {}), models: parseJson(s.models, []), subagents });
  }],
  ['GET', 'sessions/:id/events', async (req, [id]) => {
    const kinds = (q(req, 'kinds') ?? '').split(',').filter((k) => /^[a-z_]+$/.test(k));
    const where: Record<string, unknown> = { sessionId: id };
    if (kinds.length) where.kind = { in: kinds };
    if (q(req, 'q')) where.text = { contains: q(req, 'q') };
    if (q(req, 'errors') === '1') where.isError = true;
    const after = Number(q(req, 'after'));
    if (!Number.isNaN(after) && q(req, 'after') !== undefined) where.seq = { gt: after };
    const take = Math.min(Number(q(req, 'limit')) || 200, 1000);
    const rows = await prisma().event.findMany({ where, orderBy: { seq: 'asc' }, take });
    return json({ rows: rows.map((e) => ({ ...e, meta: parseJson(e.meta, null) })), hasMore: rows.length === take });
  }],
  ['GET', 'sessions/:id/raw/:seq', async (_r, [id, seq]) => json(await rawRecord(id, Number(seq)))],
  ['GET', 'sessions/:id/export', async (req, [id]) => exportSession(id, (q(req, 'format') ?? 'markdown') as 'json' | 'jsonl' | 'markdown')],

  // ---------- Continue with another agent ----------
  ['GET', 'resume', async (req) => {
    const ctx = await buildResumeContext({ projectId: q(req, 'projectId'), sessionId: q(req, 'sessionId') });
    const agent = q(req, 'agent') ?? 'generic';
    return json({ prompt: renderContinuationPrompt(ctx, agent), context: { project: ctx.project, focus: ctx.focus, taskCounts: ctx.taskCounts, nextSteps: ctx.nextSteps, git: ctx.git ? { branch: ctx.git.branch, changes: ctx.git.counts.total, head: ctx.git.head } : null } });
  }],
  ['GET', 'handoffs', async (req) => json(await prisma().handoff.findMany({ where: { projectId: q(req, 'projectId') }, orderBy: { createdAt: 'desc' }, take: 50, include: { project: { select: { name: true } } } }))],
  ['POST', 'handoffs/preview', async (req) => {
    const b = await body(req);
    return json(await previewHandoff({ projectId: typeof b.projectId === 'string' ? b.projectId : undefined, sessionId: typeof b.sessionId === 'string' ? b.sessionId : undefined, targetAgent: typeof b.targetAgent === 'string' ? b.targetAgent : 'generic' }));
  }],
  ['POST', 'handoffs', async (req) => {
    const b = await body(req);
    // Choices from the "review before sharing" step: replaced file texts, or null to leave a file out.
    const overrides = b.overrides && typeof b.overrides === 'object' ? Object.fromEntries(Object.entries(b.overrides as Record<string, unknown>).filter(([, v]) => v === null || typeof v === 'string')) as Record<string, string | null> : undefined;
    const h = await createHandoff({ projectId: typeof b.projectId === 'string' ? b.projectId : undefined, sessionId: typeof b.sessionId === 'string' ? b.sessionId : undefined, targetAgent: typeof b.targetAgent === 'string' ? b.targetAgent : 'generic', overrides });
    return json({ id: h.id, dirPath: h.dirPath, zipPath: h.zipPath, files: h.fileNames, prompt: h.prompt }, 201);
  }],
  ['GET', 'handoffs/:id/download', async (_r, [id]) => {
    const h = await prisma().handoff.findUnique({ where: { id } });
    if (!h?.zipPath || !fs.existsSync(h.zipPath) || !isInside(h.zipPath, dataPath('handoffs'))) throw new HttpError(404, 'Handoff ZIP not found.');
    return fileResponse(h.zipPath, path.basename(h.zipPath));
  }],
  ['POST', 'handoffs/:id/dropin', async (_r, [id]) => json(await dropInHandoff(id))],

  // ---------- Tasks ----------
  ['GET', 'tasks', async (req) => {
    const where: Record<string, unknown> = {};
    for (const k of ['projectId', 'sessionId', 'status', 'verification', 'source', 'agent', 'priority']) if (q(req, k)) where[k] = q(req, k);
    if (q(req, 'q')) where.OR = [{ title: { contains: q(req, 'q') } }, { description: { contains: q(req, 'q') } }];
    const take = Math.min(Number(q(req, 'limit')) || 100, 500);
    const [rows, total] = await Promise.all([prisma().task.findMany({ where, orderBy: [{ occurredAt: 'desc' }, { createdAt: 'desc' }], take, skip: Number(q(req, 'offset')) || 0, include: { project: { select: { name: true } } } }), prisma().task.count({ where })]);
    return json({ total, rows });
  }],
  ['POST', 'tasks', async (req) => {
    const b = await body(req);
    if (typeof b.title !== 'string' || !b.title.trim()) bad('title is required.');
    const status = TASK_STATUSES.includes(b.status as never) ? String(b.status) : 'pending';
    return json(await prisma().task.create({ data: { title: String(b.title).slice(0, 300), description: typeof b.description === 'string' ? b.description : null, projectId: typeof b.projectId === 'string' ? b.projectId : null, status: status === 'completed' ? 'requires_verification' : status, priority: PRIORITIES.includes(b.priority as never) ? String(b.priority) : 'medium', source: 'manual', manualOverride: true, dependencies: Array.isArray(b.dependencies) ? JSON.stringify(b.dependencies) : null, relatedFiles: Array.isArray(b.relatedFiles) ? JSON.stringify(b.relatedFiles) : null, evidence: JSON.stringify([{ type: 'manual_note', detail: 'Created manually.' }]) } }), 201);
  }],
  ['PATCH', 'tasks/:id', async (req, [id]) => {
    const b = await body(req);
    const t = await prisma().task.findUnique({ where: { id } });
    if (!t) throw new HttpError(404, 'Task not found.');
    const data: Record<string, unknown> = { manualOverride: true };
    const evidence = parseJson<unknown[]>(t.evidence, []);
    if (b.status !== undefined) {
      if (!TASK_STATUSES.includes(b.status as never)) bad('Invalid status.');
      // Marking complete is a human decision and must carry a reason.
      if (b.status === 'completed' && (typeof b.note !== 'string' || !b.note.trim())) bad('Marking a task completed requires a verification note (what you checked).');
      data.status = b.status;
      if (b.status === 'completed') data.verification = 'verified';
      if (b.status === 'failed') data.verification = 'failed';
    }
    if (b.verification !== undefined) {
      if (!VERIFICATION_LEVELS.includes(b.verification as never)) bad('Invalid verification level.');
      data.verification = b.verification;
    }
    if (b.priority !== undefined) {
      if (!PRIORITIES.includes(b.priority as never)) bad('Invalid priority.');
      data.priority = b.priority;
    }
    if (typeof b.title === 'string' && b.title.trim()) data.title = b.title.slice(0, 300);
    if (Array.isArray(b.dependencies)) data.dependencies = JSON.stringify(b.dependencies.map(String).slice(0, 50));
    if (Array.isArray(b.relatedFiles)) data.relatedFiles = JSON.stringify(b.relatedFiles.map(String).slice(0, 200));
    if (typeof b.note === 'string' && b.note.trim()) evidence.push({ type: 'manual_note', detail: redactSecrets(b.note.trim().slice(0, 2000)), at: new Date().toISOString() });
    data.evidence = JSON.stringify(evidence);
    return json(await prisma().task.update({ where: { id }, data }));
  }],

  // ---------- Knowledge ----------
  ['GET', 'knowledge', async (req) => json(await prisma().knowledgeItem.findMany({ where: { projectId: q(req, 'projectId'), kind: q(req, 'kind') }, orderBy: [{ occurredAt: 'desc' }, { createdAt: 'desc' }], take: 300, include: { project: { select: { name: true } } } }))],
  ['POST', 'knowledge', async (req) => {
    const b = await body(req);
    if (typeof b.projectId !== 'string' || typeof b.title !== 'string' || typeof b.body !== 'string') bad('projectId, title and body are required.');
    const kind = ['decision', 'issue', 'note', 'memory', 'plan', 'summary'].includes(String(b.kind)) ? String(b.kind) : 'note';
    return json(await prisma().knowledgeItem.create({ data: { projectId: String(b.projectId), kind, title: String(b.title).slice(0, 200), body: String(b.body).slice(0, 50_000), source: 'manual', status: typeof b.status === 'string' ? b.status : null, occurredAt: new Date() } }), 201);
  }],
  ['PATCH', 'knowledge/:id', async (req, [id]) => {
    const b = await body(req);
    const data: Record<string, unknown> = {};
    if (typeof b.title === 'string') data.title = b.title.slice(0, 200);
    if (typeof b.body === 'string') data.body = b.body.slice(0, 50_000);
    if (typeof b.status === 'string') data.status = b.status;
    return json(await prisma().knowledgeItem.update({ where: { id }, data }));
  }],

  // ---------- Search ----------
  ['GET', 'search', async (req) => json(await globalSearch(q(req, 'q') ?? '', { projectId: q(req, 'projectId'), agent: q(req, 'agent'), kinds: q(req, 'kinds')?.split(','), limit: Number(q(req, 'limit')) || 40, offset: Number(q(req, 'offset')) || 0 }))],

  // ---------- Settings & AI ----------
  ['GET', 'settings', async () => json({ aiConsent: await getSetting('aiConsent', false), aiModel: await getSetting('aiModel', ''), agentRoots: await getSetting('agentRoots', {}), ai: await aiStatus(), adapters: ADAPTERS.map((a) => ({ id: a.id, label: a.label, capabilities: a.capabilities, defaultRoots: a.defaultRoots() })) })],
  ['PUT', 'settings', async (req) => {
    const b = await body(req);
    if (typeof b.aiConsent === 'boolean') await setSetting('aiConsent', b.aiConsent);
    if (typeof b.aiModel === 'string') {
      if (b.aiModel && !/^[\w.:@/-]{2,100}$/.test(b.aiModel)) bad('Invalid model id.');
      await setSetting('aiModel', b.aiModel.trim());
    }
    if (b.agentRoots && typeof b.agentRoots === 'object') {
      const clean: Record<string, string[]> = {};
      for (const [k, v] of Object.entries(b.agentRoots as Record<string, unknown>)) {
        if (!AGENT_IDS.includes(k) || !Array.isArray(v)) continue;
        clean[k] = v.filter((x) => typeof x === 'string' && x.trim()).map((x) => validateLocalPath(x));
      }
      await setSetting('agentRoots', clean);
    }
    return json({ ok: true });
  }],
  ['GET', 'ai/models', async () => json(await listModels())],
  ['POST', 'ai/test', async () => json(await testConnection())],
  ['POST', 'ai/session/:id', async (_r, [id]) => json(await analyzeSession(id))],
  ['POST', 'ai/project/:id', async (_r, [id]) => json(await analyzeProject(id))],

  // ---------- Backups ----------
  ['GET', 'backups', async () => json((await prisma().backup.findMany({ orderBy: { createdAt: 'desc' } })).map((b) => ({ ...b, exists: fs.existsSync(b.filePath) })))],
  ['POST', 'backups', async (req) => {
    const b = await body(req);
    const jobId = await startJob('backup', async (h) => {
      h.progress(0, 1, b.includeArchives ? 'Writing full backup (includes the archived transcripts; this can take a while)…' : 'Writing backup…');
      const r = await createBackup({ includeArchives: b.includeArchives === true, note: typeof b.note === 'string' ? b.note.slice(0, 300) : undefined });
      h.progress(1, 1, 'Backup written.');
      return r;
    }, { exclusive: true });
    return json({ jobId }, 202);
  }],
  ['POST', 'backups/:id/restore', async (req, [id]) => {
    const b = await body(req);
    if (b.confirm !== 'RESTORE') bad('Send {"confirm":"RESTORE"} to restore. The current database will be kept in data/pre-restore.');
    const row = await prisma().backup.findUnique({ where: { id } });
    if (!row || !fs.existsSync(row.filePath)) throw new HttpError(404, 'Backup file not found.');
    return json(await restoreBackup(row.filePath));
  }],
  ['GET', 'backups/:id/download', async (_r, [id]) => {
    const row = await prisma().backup.findUnique({ where: { id } });
    if (!row || !fs.existsSync(row.filePath) || !isInside(row.filePath, dataPath('backups'))) throw new HttpError(404, 'Backup file not found.');
    return fileResponse(row.filePath, path.basename(row.filePath));
  }],
  ['GET', 'agents', async () => {
    const counts = await prisma().session.groupBy({ by: ['agent'], _count: true, _max: { endedAt: true } });
    return json(ADAPTERS.map((a) => ({ id: a.id, label: AGENT_LABELS[a.id], capabilities: a.capabilities, defaultRoots: a.defaultRoots(), sessions: counts.find((c) => c.agent === a.id)?._count ?? 0, lastActivity: counts.find((c) => c.agent === a.id)?._max.endedAt ?? null })));
  }],
];

routes.push(...v2Routes, ...liveRoutes);

/** From the phone (via the Cloudflare tunnel) the API is read-only, except answering decisions when the owner allows it. */
async function remoteAllowed(method: string, segs: string[]): Promise<boolean> {
  if (method === 'GET') return !(segs[0] === 'backups' && segs[2] === 'download');
  if (segs[0] === 'decisions' && segs.length === 2 && method === 'POST') return getSetting<boolean>('remoteApprovals', false);
  if (segs[0] === 'notifications' && segs[1] === 'read') return true;
  return false;
}

function match(method: string, segs: string[]): { h: Handler; m: string[] } | null {
  for (const [rm, pattern, h] of routes) {
    if (rm !== method) continue;
    const ps = pattern.split('/');
    if (ps.length !== segs.length) continue;
    const m: string[] = [];
    let ok = true;
    for (let i = 0; i < ps.length; i++) {
      if (ps[i].startsWith(':')) m.push(decodeURIComponent(segs[i]));
      else if (ps[i] !== segs[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return { h, m };
  }
  return null;
}

async function dispatch(method: string, req: NextRequest, ctx: Ctx): Promise<Response> {
  const { path: segs } = await ctx.params;
  const found = match(method, segs);
  if (!found) return json({ error: `No route for ${method} /api/${segs.join('/')}` }, 404);
  try {
    if (isDemo() && !demoAllows(method, segs)) return json({ error: DEMO_MESSAGE, demo: true }, 403);
    await ensureDb();
    if (req.headers.get('x-dc-remote') === '1' && !(await remoteAllowed(method, segs))) return json({ error: 'Remote access is read-only. Do this from the PC, or allow remote approvals in Settings.' }, 403);
    return await found.h(req, found.m);
  } catch (e) {
    const err = e as Error & { status?: number };
    const status = e instanceof HttpError || e instanceof AiError || e instanceof PathError ? (err.status ?? 400) : typeof err.status === 'number' ? err.status : 500;
    if (status >= 500) console.error(`[api] ${method} /api/${segs.join('/')}:`, redactSecrets(err.message));
    return json({ error: redactSecrets(err.message) }, status);
  }
}

export const GET = (req: NextRequest, ctx: Ctx) => dispatch('GET', req, ctx);
export const POST = (req: NextRequest, ctx: Ctx) => dispatch('POST', req, ctx);
export const PUT = (req: NextRequest, ctx: Ctx) => dispatch('PUT', req, ctx);
export const PATCH = (req: NextRequest, ctx: Ctx) => dispatch('PATCH', req, ctx);
export const DELETE = (req: NextRequest, ctx: Ctx) => dispatch('DELETE', req, ctx);
