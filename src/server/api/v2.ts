import fs from 'node:fs';
import path from 'node:path';
import type { NextRequest } from 'next/server';
import { detectAgents, LAUNCH_AGENTS, LaunchAgent } from '../agents/binaries';
import { launchAgent } from '../agents/launcher';
import { DEFAULT_BASE_URL, JOBS, LOCAL_KINDS, PROVIDER_KINDS, ProviderKind, getBudget, getRoutes, listProviderModels, listProviders, testProvider, validateBaseUrl } from '../ai/gateway';
import { ask } from '../ask';
import { audit } from '../audit';
import { decryptBackupFile, runCloudBackup } from '../backup/cloud';
import { dataPath } from '../config';
import { costOverview } from '../costs';
import { getSetting, parseJson, prisma, setSetting } from '../db';
import { buildDigest } from '../digest';
import { analyzeWorktrees } from '../git/worktrees';
import { githubStatus, projectGithub } from '../github';
import { startJob } from '../jobs/manager';
import { abortAll, answerDecision, createCompare, createOrder } from '../org/engine';
import { nextRun, runScheduleAction, Timing } from '../org/scheduler';
import { seedOrg } from '../org/seed';
import { CONTINUE_TARGETS, dismissLimitHandoff, getFallbackAgent, pendingLimitHandoffs, setFallbackAgent } from '../handoff/limit';
import { mcpServer } from '../live/connect';
import { copySkill, importExistingRules, mcpInventory, mcpSnippets, previewRules, skillInventory, syncRules, TARGETS } from '../rules';
import { PathError, isInside, validateLocalPath } from '../security/paths';
import { deleteSecret, listSecretNames, setSecret } from '../security/vault';
import { applyTriage, Triage, triageProject } from '../verify/triage';
import { cancelVerification, detectCommands, startVerification, validateCommand } from '../verify/runner';

type Handler = (req: NextRequest, m: string[]) => Promise<Response>;
const json = (data: unknown, status = 200) => Response.json(data, { status });
async function body(req: NextRequest): Promise<Record<string, unknown>> {
  try {
    const b = await req.json();
    return b && typeof b === 'object' ? (b as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
const q = (req: NextRequest, k: string) => req.nextUrl.searchParams.get(k) ?? undefined;
const str = (v: unknown, max = 5000) => (typeof v === 'string' ? v.slice(0, max) : undefined);
function need(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new PathError(msg);
}
const EXECUTORS = ['api', 'claude-code', 'codex', 'opencode'];
const AUTONOMY = ['L0', 'L1', 'L2', 'L3'];

/** How to register DevContinuity's own MCP server, for this installation (checkout or npm). */
function devcontinuityMcpSnippets() {
  const m = mcpServer();
  return mcpSnippets('devcontinuity', m.command, m.args);
}

export const v2Routes: [string, string, Handler][] = [
  // ---------- Organization ----------
  ['GET', 'org', async () => {
    const depts = await prisma().department.findMany({ orderBy: { sort: 'asc' }, include: { roles: { orderBy: { sort: 'asc' } } } });
    const busy = await prisma().workItem.groupBy({ by: ['roleKey', 'status'], where: { status: { notIn: ['done', 'rejected', 'cancelled', 'failed'] } }, _count: true });
    return json({ departments: depts, workload: busy });
  }],
  ['POST', 'org/seed', async () => json(await seedOrg())],
  ['POST', 'departments', async (req) => {
    const b = await body(req);
    need(str(b.key) && /^[a-z0-9_]{2,40}$/.test(String(b.key)) && str(b.name), 'key (a-z, 0-9, _) and name are required.');
    return json(await prisma().department.create({ data: { key: String(b.key), name: String(b.name), nameAr: str(b.nameAr) ?? String(b.name), description: str(b.description) ?? null, sort: 500 } }), 201);
  }],
  ['PATCH', 'departments/:id', async (req, [id]) => {
    const b = await body(req);
    const data: Record<string, unknown> = {};
    for (const k of ['name', 'nameAr', 'description']) if (typeof b[k] === 'string') data[k] = str(b[k]);
    if (typeof b.enabled === 'boolean') data.enabled = b.enabled;
    if (b.budgetUsd === null || typeof b.budgetUsd === 'number') data.budgetUsd = b.budgetUsd;
    await audit('owner', 'department.update', id, data);
    return json(await prisma().department.update({ where: { id }, data }));
  }],
  ['POST', 'roles', async (req) => {
    const b = await body(req);
    need(str(b.key) && /^[a-z0-9_]{2,40}$/.test(String(b.key)) && str(b.title) && str(b.departmentId), 'key, title and departmentId are required.');
    const role = await prisma().role.create({ data: { key: String(b.key), departmentId: String(b.departmentId), title: String(b.title), titleAr: str(b.titleAr) ?? String(b.title), level: ['head', 'worker'].includes(String(b.level)) ? String(b.level) : 'worker', reportsToKey: str(b.reportsToKey) ?? null, executor: EXECUTORS.includes(String(b.executor)) ? String(b.executor) : 'api', modelRoute: str(b.modelRoute, 200) ?? 'worker', instructions: str(b.instructions, 8000) ?? 'Do the assigned task carefully and report precisely.', autonomy: AUTONOMY.includes(String(b.autonomy)) ? String(b.autonomy) : 'L1', sort: 500 } });
    await audit('owner', 'role.create', role.key);
    return json(role, 201);
  }],
  ['PATCH', 'roles/:id', async (req, [id]) => {
    const b = await body(req);
    const data: Record<string, unknown> = {};
    for (const k of ['title', 'titleAr', 'instructions', 'reportsToKey']) if (typeof b[k] === 'string') data[k] = str(b[k], 8000);
    if (typeof b.modelRoute === 'string') data.modelRoute = str(b.modelRoute, 200);
    if (typeof b.enabled === 'boolean') data.enabled = b.enabled;
    if (b.executor !== undefined) {
      need(EXECUTORS.includes(String(b.executor)), 'Invalid executor.');
      data.executor = b.executor;
    }
    if (b.autonomy !== undefined) {
      need(AUTONOMY.includes(String(b.autonomy)), 'Invalid autonomy level.');
      data.autonomy = b.autonomy;
    }
    if (Array.isArray(b.allowedCommands)) data.allowedCommands = JSON.stringify(b.allowedCommands.map((c) => validateCommand(String(c))));
    if (typeof b.departmentId === 'string') data.departmentId = b.departmentId;
    await audit('owner', 'role.update', id, data);
    return json(await prisma().role.update({ where: { id }, data }));
  }],
  ['POST', 'org/executors', async (req) => {
    const b = await body(req);
    need(EXECUTORS.includes(String(b.executor)), 'Invalid executor.');
    const where = b.scope === 'all' ? { level: 'worker' } : { level: 'worker', autonomy: { in: ['L2', 'L3'] } };
    const r = await prisma().role.updateMany({ where, data: { executor: String(b.executor) } });
    await audit('owner', 'org.executors', String(b.executor), { scope: b.scope, count: r.count });
    return json({ updated: r.count });
  }],

  // ---------- Orders, work, decisions ----------
  ['GET', 'orders', async () => json(await prisma().order.findMany({ orderBy: { createdAt: 'desc' }, take: 100, include: { _count: { select: { workItems: true } } } }))],
  ['POST', 'orders', async (req) => {
    const b = await body(req);
    return json(await createOrder({ instruction: String(b.instruction ?? ''), projectId: str(b.projectId) || null, title: str(b.title), lang: str(b.lang) }), 201);
  }],
  ['GET', 'orders/:id', async (_r, [id]) => {
    const db = prisma();
    const order = await db.order.findUnique({ where: { id } });
    if (!order) throw Object.assign(new Error('Order not found.'), { status: 404 });
    const items = await db.workItem.findMany({ where: { orderId: id }, orderBy: [{ createdAt: 'asc' }], select: { id: true, parentId: true, kind: true, type: true, title: true, status: true, roleKey: true, executor: true, branch: true, costUsd: true, attempts: true, evidence: true, updatedAt: true } });
    const decisions = await db.decisionRequest.findMany({ where: { orderId: id }, orderBy: { createdAt: 'desc' } });
    return json({ order: { ...order, plan: parseJson(order.plan, null) }, items: items.map((i) => ({ ...i, evidence: parseJson(i.evidence, {}) })), decisions });
  }],
  ['POST', 'orders/:id/cancel', async (_r, [id]) => {
    await prisma().workItem.updateMany({ where: { orderId: id, status: { in: ['planned', 'queued', 'changes_requested', 'blocked'] } }, data: { status: 'cancelled' } });
    await prisma().order.update({ where: { id }, data: { status: 'cancelled' } });
    await prisma().decisionRequest.updateMany({ where: { orderId: id, status: 'pending' }, data: { status: 'expired' } });
    await audit('owner', 'order.cancel', id);
    return json({ ok: true });
  }],
  ['GET', 'workitems/:id', async (_r, [id]) => {
    const db = prisma();
    const w = await db.workItem.findUnique({ where: { id }, include: { runs: { orderBy: { startedAt: 'asc' }, include: { role: { select: { title: true, key: true } } } } } });
    if (!w) throw Object.assign(new Error('Not found.'), { status: 404 });
    return json({ ...w, evidence: parseJson(w.evidence, {}), acceptance: parseJson(w.acceptance, []) });
  }],
  ['POST', 'workitems/:id/retry', async (_r, [id]) => {
    await prisma().workItem.update({ where: { id }, data: { status: 'queued', attempts: 0 } });
    await audit('owner', 'workitem.retry', id);
    return json({ ok: true });
  }],
  ['POST', 'compare', async (req) => {
    const b = await body(req);
    const ex = Array.isArray(b.executors) ? b.executors.map(String) : [];
    need(ex.length === 2 && ex.every((e) => EXECUTORS.includes(e)), 'Choose two executors.');
    return json(await createCompare({ projectId: String(b.projectId), instruction: String(b.instruction ?? ''), executors: [ex[0], ex[1]], roleKey: str(b.roleKey) }), 201);
  }],
  ['GET', 'decisions', async (req) => json(await prisma().decisionRequest.findMany({ where: { status: q(req, 'status') ?? 'pending', kind: q(req, 'kind') ? { in: q(req, 'kind')!.split(',') } : undefined }, orderBy: { createdAt: 'desc' }, take: 100 }))],
  ['POST', 'decisions/:id', async (req, [id]) => {
    const b = await body(req);
    return json(await answerDecision(id, String(b.answer ?? ''), str(b.comment, 4000)));
  }],

  // ---------- Control ----------
  ['GET', 'killswitch', async () => json({ on: await getSetting('killSwitch', false) })],
  ['PUT', 'killswitch', async (req) => {
    const b = await body(req);
    await setSetting('killSwitch', b.on === true);
    if (b.on === true) abortAll();
    await audit('owner', b.on === true ? 'killswitch.on' : 'killswitch.off');
    return json({ on: b.on === true });
  }],
  ['GET', 'activity', async () => {
    const db = prisma();
    const [running, recent, hb, queued, sync] = await Promise.all([
      db.run.findMany({ where: { status: 'running' }, orderBy: { startedAt: 'desc' }, include: { role: { select: { title: true, key: true } }, workItem: { select: { id: true, title: true, orderId: true } } } }),
      db.run.findMany({ where: { status: { not: 'running' } }, orderBy: { startedAt: 'desc' }, take: 40, include: { role: { select: { title: true } }, workItem: { select: { id: true, title: true, orderId: true } } } }),
      getSetting<{ pid: number | null; at: string; active?: number }>('orchestrator', { pid: null, at: '' }),
      db.workItem.count({ where: { status: 'queued', kind: 'task' } }),
      getSetting('lastAutoSync', null),
    ]);
    const online = !!hb.pid && Date.now() - new Date(hb.at).getTime() < 30_000;
    return json({ orchestrator: { ...hb, online }, running: running.map((r) => ({ ...r, log: r.log?.slice(-4000) })), recent: recent.map((r) => ({ ...r, log: undefined, output: undefined })), queued, lastAutoSync: sync, killSwitch: await getSetting('killSwitch', false) });
  }],
  ['GET', 'runs/:id', async (_r, [id]) => json(await prisma().run.findUnique({ where: { id }, include: { role: { select: { title: true } } } }))],
  ['GET', 'notifications', async (req) => {
    const rows = await prisma().notification.findMany({ where: q(req, 'unread') === '1' ? { read: false } : {}, orderBy: { at: 'desc' }, take: 50 });
    // The badge counts what needs attention (warnings and errors), not routine information.
    return json({ unread: await prisma().notification.count({ where: { read: false, level: { in: ['error', 'warning'] } } }), rows });
  }],
  ['POST', 'notifications/read', async (req) => {
    const b = await body(req);
    await prisma().notification.updateMany({ where: Array.isArray(b.ids) ? { id: { in: b.ids.map(Number) } } : {}, data: { read: true } });
    return json({ ok: true });
  }],
  ['GET', 'audit', async (req) => json(await prisma().auditEvent.findMany({ orderBy: { at: 'desc' }, take: Math.min(Number(q(req, 'limit')) || 200, 1000) }))],
  ['GET', 'reports', async (req) => json(await prisma().report.findMany({ where: { kind: q(req, 'kind') }, orderBy: { createdAt: 'desc' }, take: 30 }))],
  ['POST', 'digest/:kind', async (_r, [kind]) => json(await buildDigest(kind === 'weekly' ? 'owner_weekly' : 'owner_daily'))],

  // ---------- AI providers, routes, budget ----------
  ['GET', 'providers', async () => json({ providers: await listProviders(), kinds: PROVIDER_KINDS, defaults: DEFAULT_BASE_URL, routes: await getRoutes(), jobs: JOBS, budget: await getBudget(), prices: await getSetting('modelPrices', {}), secrets: await listSecretNames(), privateProjectIds: await getSetting('privateProjectIds', []) })],
  ['POST', 'providers', async (req) => {
    const b = await body(req);
    const kind = String(b.kind) as ProviderKind;
    need(PROVIDER_KINDS.includes(kind), 'Invalid provider kind.');
    const baseUrl = str(b.baseUrl) ? validateBaseUrl(String(b.baseUrl)) : kind === 'openai-compatible' ? null : null;
    need(kind !== 'openai-compatible' || baseUrl, 'A base URL is required for a custom provider.');
    const name = str(b.name, 80) || kind;
    const p = await prisma().provider.create({ data: { kind, name, baseUrl, models: Array.isArray(b.models) ? JSON.stringify(b.models.map(String)) : null } });
    if (str(b.apiKey) && !LOCAL_KINDS.includes(kind)) {
      await setSecret(`provider:${p.id}`, String(b.apiKey).trim());
      await prisma().provider.update({ where: { id: p.id }, data: { keyRef: `secret:provider:${p.id}` } });
    } else if (str(b.keyEnv)) await prisma().provider.update({ where: { id: p.id }, data: { keyRef: `env:${String(b.keyEnv).replace(/[^\w]/g, '')}` } });
    await audit('owner', 'provider.create', p.id, { kind, name });
    return json(p, 201);
  }],
  ['PATCH', 'providers/:id', async (req, [id]) => {
    const b = await body(req);
    const data: Record<string, unknown> = {};
    if (typeof b.name === 'string') data.name = str(b.name, 80);
    if (typeof b.enabled === 'boolean') data.enabled = b.enabled;
    if (typeof b.baseUrl === 'string') data.baseUrl = b.baseUrl ? validateBaseUrl(b.baseUrl) : null;
    if (Array.isArray(b.models)) data.models = JSON.stringify(b.models.map(String));
    if (typeof b.priority === 'number') data.priority = b.priority;
    if (str(b.apiKey)) {
      await setSecret(`provider:${id}`, String(b.apiKey).trim());
      data.keyRef = `secret:provider:${id}`;
    }
    await audit('owner', 'provider.update', id, { ...data, apiKey: b.apiKey ? '(changed)' : undefined });
    return json(await prisma().provider.update({ where: { id }, data }));
  }],
  ['DELETE', 'providers/:id', async (_r, [id]) => {
    await prisma().provider.delete({ where: { id } });
    await deleteSecret(`provider:${id}`);
    await audit('owner', 'provider.delete', id);
    return json({ ok: true });
  }],
  ['GET', 'providers/:id/models', async (_r, [id]) => json(await listProviderModels(id))],
  ['POST', 'providers/:id/test', async (req, [id]) => json(await testProvider(id, String((await body(req)).model ?? '')))],
  ['PUT', 'ai/routes', async (req) => {
    const b = await body(req);
    const clean: Record<string, { providerId: string; model: string }[]> = {};
    for (const j of JOBS) {
      const list = (b as Record<string, unknown>)[j];
      if (Array.isArray(list)) clean[j] = list.filter((e) => e && typeof e === 'object' && (e as { providerId?: string }).providerId && (e as { model?: string }).model).map((e) => ({ providerId: String((e as { providerId: string }).providerId), model: String((e as { model: string }).model).slice(0, 120) })).slice(0, 5);
    }
    await setSetting('aiRoutes', clean);
    await audit('owner', 'ai.routes', null, clean);
    return json({ ok: true });
  }],
  ['PUT', 'ai/prices', async (req) => {
    const b = await body(req);
    const clean: Record<string, { input: number; output: number }> = {};
    for (const [k, v] of Object.entries(b)) if (v && typeof v === 'object' && Number.isFinite(Number((v as { input: number }).input)) && Number.isFinite(Number((v as { output: number }).output))) clean[k.slice(0, 120)] = { input: Number((v as { input: number }).input), output: Number((v as { output: number }).output) };
    await setSetting('modelPrices', clean);
    return json({ ok: true });
  }],
  ['PUT', 'budget', async (req) => {
    const b = await body(req);
    const cap = Number(b.monthlyCapUsd);
    const warn = Number(b.warnAtUsd);
    need(Number.isFinite(cap) && cap >= 0 && Number.isFinite(warn) && warn >= 0, 'Invalid budget.');
    await setSetting('budget', { monthlyCapUsd: cap, warnAtUsd: warn });
    await audit('owner', 'budget.update', null, { cap, warn });
    return json({ ok: true });
  }],
  ['PUT', 'settings/advanced', async (req) => {
    const b = await body(req);
    const nums: [string, number, number][] = [['orgMaxConcurrent', 1, 6], ['taskCostCapUsd', 0.05, 50], ['agentMaxSteps', 5, 150], ['maxRework', 0, 5]];
    for (const [k, min, max] of nums) if (typeof b[k] === 'number') await setSetting(k, Math.min(max, Math.max(min, Number(b[k]))));
    for (const k of ['digestUseAi', 'remoteApprovals']) if (typeof b[k] === 'boolean') await setSetting(k, b[k]);
    if (Array.isArray(b.privateProjectIds)) await setSetting('privateProjectIds', b.privateProjectIds.map(String));
    await audit('owner', 'settings.advanced', null, b);
    return json({ ok: true });
  }],
  ['GET', 'settings/advanced', async () => json({ orgMaxConcurrent: await getSetting('orgMaxConcurrent', 2), taskCostCapUsd: await getSetting('taskCostCapUsd', 2), agentMaxSteps: await getSetting('agentMaxSteps', 40), maxRework: await getSetting('maxRework', 2), digestUseAi: await getSetting('digestUseAi', false), remoteApprovals: await getSetting('remoteApprovals', false), privateProjectIds: await getSetting('privateProjectIds', []) })],
  ['PUT', 'secrets/:name', async (req, [name]) => {
    need(['backupPassphrase', 'r2SecretAccessKey'].includes(name), 'Unknown secret.');
    const v = str((await body(req)).value, 500);
    need(v && v.length >= (name === 'backupPassphrase' ? 12 : 8), name === 'backupPassphrase' ? 'Use a passphrase of at least 12 characters.' : 'Value too short.');
    await setSecret(name, v);
    await audit('owner', 'secret.set', name);
    return json({ ok: true });
  }],

  // ---------- Agents: detection, launch, Claude readiness ----------
  ['GET', 'agents/detect', async () => json({ agents: await detectAgents(), paths: await getSetting('agentPaths', {}) })],
  ['PUT', 'agents/paths', async (req) => {
    const b = await body(req);
    const clean: Record<string, string> = {};
    for (const a of LAUNCH_AGENTS) if (typeof b[a] === 'string' && (b[a] as string).trim()) clean[a] = validateLocalPath(b[a]);
    await setSetting('agentPaths', clean);
    return json({ ok: true });
  }],
  ['POST', 'launch', async (req) => {
    const b = await body(req);
    need(LAUNCH_AGENTS.includes(String(b.agent) as LaunchAgent), 'Unknown agent.');
    return json(await launchAgent({ agent: String(b.agent) as LaunchAgent, projectId: str(b.projectId), sessionId: str(b.sessionId), dir: str(b.dir) ? validateLocalPath(b.dir) : undefined, resume: b.resume === true, promptText: str(b.promptText, 200_000) }));
  }],
  // ---------- Automatic handoff when an agent hits a limit ----------
  ['GET', 'handoff/limits', async () => json({ items: await pendingLimitHandoffs(), fallback: await getFallbackAgent(), targets: CONTINUE_TARGETS })],
  ['POST', 'handoff/limits/:id/dismiss', async (_r, [id]) => {
    await dismissLimitHandoff(id);
    return json({ ok: true });
  }],
  ['GET', 'settings/fallback-agent', async () => json({ fallback: await getFallbackAgent(), targets: CONTINUE_TARGETS })],
  ['PUT', 'settings/fallback-agent', async (req) => {
    await setFallbackAgent(String((await body(req)).agent ?? ''));
    return json({ fallback: await getFallbackAgent() });
  }],
  ['GET', 'claude/status', async () => {
    const agents = await detectAgents();
    const claude = agents.find((a) => a.agent === 'claude-code')!;
    const home = process.env.USERPROFILE ?? '';
    const signedIn = fs.existsSync(path.join(home, '.claude', '.credentials.json'));
    const lastLimit = await prisma().session.findFirst({ where: { agent: 'claude-code', endState: 'api_error' }, orderBy: { endedAt: 'desc' }, select: { endedAt: true, endStateDetail: true } });
    const lastOk = await prisma().session.findFirst({ where: { agent: 'claude-code', endState: 'completed_turn' }, orderBy: { endedAt: 'desc' }, select: { endedAt: true } });
    const workersOnClaude = await prisma().role.count({ where: { executor: 'claude-code' } });
    const resumable = await prisma().session.count({ where: { agent: 'claude-code', isSubagent: false, endState: { in: ['interrupted_tool', 'interrupted_response', 'awaiting_assistant', 'api_error'] } } });
    return json({ cli: claude, credentialsFilePresent: signedIn, lastLimit, lastOk, workersOnClaude, resumable, mcp: devcontinuityMcpSnippets() });
  }],

  // ---------- Ask my projects ----------
  ['POST', 'ask', async (req) => {
    const b = await body(req);
    need(str(b.question) && String(b.question).trim().length > 2, 'Ask a question.');
    return json(await ask(String(b.question).trim(), { threadId: str(b.threadId), projectId: str(b.projectId) }));
  }],
  ['GET', 'ask/threads', async () => json(await prisma().chatThread.findMany({ orderBy: { updatedAt: 'desc' }, take: 50 }))],
  ['GET', 'ask/threads/:id', async (_r, [id]) => json(await prisma().chatThread.findUnique({ where: { id }, include: { messages: { orderBy: { createdAt: 'asc' } } } }))],

  // ---------- Verification & triage ----------
  ['GET', 'projects/:id/verify', async (_r, [id]) => {
    const p = await prisma().project.findUnique({ where: { id } });
    need(p, 'Project not found.');
    const runs = await prisma().verificationRun.findMany({ where: { projectId: id }, orderBy: { startedAt: 'desc' }, take: 20 });
    const triage = await prisma().task.groupBy({ by: ['triage'], where: { projectId: id, status: 'requires_verification' }, _count: true });
    return json({ testCommand: p.testCommand, detected: p.pathVerified && fs.existsSync(p.rootPath) ? detectCommands(p.rootPath) : [], runs, triage });
  }],
  ['PUT', 'projects/:id/test-command', async (req, [id]) => {
    const c = str((await body(req)).command, 300);
    await prisma().project.update({ where: { id }, data: { testCommand: c ? validateCommand(c) : null } });
    return json({ ok: true });
  }],
  ['POST', 'projects/:id/verify', async (req, [id]) => json({ runId: await startVerification(id, String((await body(req)).command ?? '')) }, 202)],
  ['GET', 'verify/:id', async (_r, [id]) => json(await prisma().verificationRun.findUnique({ where: { id } }))],
  ['POST', 'verify/:id/cancel', async (_r, [id]) => json({ cancelled: cancelVerification(id) })],
  ['POST', 'tasks/bulk-verify', async (req) => {
    const b = await body(req);
    const ids = Array.isArray(b.taskIds) ? b.taskIds.map(String) : [];
    const run = str(b.runId) ? await prisma().verificationRun.findUnique({ where: { id: String(b.runId) } }) : null;
    need(ids.length && run && run.status === 'passed', 'Select tasks and a passed verification run.');
    for (const t of await prisma().task.findMany({ where: { id: { in: ids } } })) {
      const ev = parseJson<unknown[]>(t.evidence, []);
      ev.push({ type: 'manual_note', detail: `Owner verified with passing run: ${run.command} (${run.finishedAt?.toISOString()})`, at: new Date().toISOString() });
      await prisma().task.update({ where: { id: t.id }, data: { status: 'completed', verification: 'verified', manualOverride: true, evidence: JSON.stringify(ev) } });
    }
    await audit('owner', 'tasks.bulk-verify', run.id, { count: ids.length });
    return json({ updated: ids.length });
  }],
  ['POST', 'projects/:id/triage', async (_r, [id]) => json({ jobId: await startJob('triage', async (h) => {
    h.progress(0, 1, 'Checking recorded changes against the files and Git…');
    const r = await triageProject(id);
    h.progress(1, 1, 'Triage finished.');
    return r;
  }) }, 202)],
  ['POST', 'triage/all', async () => json({ jobId: await startJob('triage', async (h) => {
    const projects = await prisma().project.findMany({ where: { tasks: { some: { status: 'requires_verification' } } }, select: { id: true, name: true } });
    const total: Record<string, number> = {};
    for (let i = 0; i < projects.length; i++) {
      h.progress(i, projects.length, `Triage: ${projects[i].name}`);
      for (const [k, v] of Object.entries(await triageProject(projects[i].id))) total[k] = (total[k] ?? 0) + v;
    }
    h.progress(projects.length, projects.length, 'Triage finished.');
    return total;
  }, { exclusive: true }) }, 202)],
  ['POST', 'triage/apply', async (req) => {
    const b = await body(req);
    need(['likely_done', 'likely_not_done', 'no_code_changes', 'unknown'].includes(String(b.triage)) && ['completed', 'pending', 'cancelled'].includes(String(b.action)), 'Invalid triage action.');
    return json({ updated: await applyTriage({ projectId: str(b.projectId), triage: b.triage as Triage, action: b.action as 'completed' | 'pending' | 'cancelled', taskIds: Array.isArray(b.taskIds) ? b.taskIds.map(String) : undefined }) });
  }],

  // ---------- Worktrees ----------
  ['GET', 'projects/:id/worktrees', async (_r, [id]) => json(await analyzeWorktrees(id))],

  // ---------- Rules, MCP, skills ----------
  ['GET', 'projects/:id/rules', async (_r, [id]) => {
    const p = await prisma().project.findUnique({ where: { id } });
    need(p, 'Project not found.');
    return json({ rules: p.rules ?? '', targets: TARGETS, preview: p.pathVerified && fs.existsSync(p.rootPath) ? await previewRules(id) : [] });
  }],
  ['PUT', 'projects/:id/rules', async (req, [id]) => {
    await prisma().project.update({ where: { id }, data: { rules: str((await body(req)).rules, 50_000) ?? '' } });
    return json({ ok: true });
  }],
  ['POST', 'projects/:id/rules/import', async (_r, [id]) => json({ rules: await importExistingRules(id) })],
  ['POST', 'projects/:id/rules/sync', async (req, [id]) => {
    const t = (await body(req)).targets;
    return json(await syncRules(id, Array.isArray(t) ? t.map(String) : []));
  }],
  ['GET', 'mcp', async () => json({ ...(await mcpInventory()), skills: skillInventory(), devcontinuity: devcontinuityMcpSnippets() })],
  ['POST', 'skills/copy', async (req) => {
    const b = await body(req);
    return json({ copiedTo: await copySkill(String(b.from), String(b.skill), String(b.to)) });
  }],

  // ---------- Costs & GitHub ----------
  ['GET', 'costs', async () => json(await costOverview())],
  ['GET', 'github/status', async () => json(await githubStatus())],
  ['GET', 'projects/:id/github', async (_r, [id]) => json(await projectGithub(id))],

  // ---------- Schedules ----------
  ['GET', 'schedules', async () => json(await prisma().schedule.findMany({ orderBy: { createdAt: 'asc' } }))],
  ['POST', 'schedules', async (req) => {
    const b = await body(req);
    const actions = ['digest_daily', 'digest_weekly', 'archive_assets', 'worktree_scan', 'verify_project', 'security_scan', 'order'];
    need(str(b.name) && actions.includes(String(b.action)), 'Name and a valid action are required.');
    const timing = (b.timing ?? { every: 'day', at: '08:00' }) as Timing;
    need(['day', 'week', 'hours'].includes(timing.every), 'Invalid timing.');
    const payload = (b.payload ?? {}) as Record<string, unknown>;
    if (payload.command) validateCommand(String(payload.command));
    const s = await prisma().schedule.create({ data: { name: String(b.name), action: String(b.action), timing: JSON.stringify(timing), payload: JSON.stringify(payload), nextRunAt: nextRun(timing) } });
    await audit('owner', 'schedule.create', s.id, b);
    return json(s, 201);
  }],
  ['PATCH', 'schedules/:id', async (req, [id]) => {
    const b = await body(req);
    const data: Record<string, unknown> = {};
    if (typeof b.enabled === 'boolean') data.enabled = b.enabled;
    if (b.timing) {
      data.timing = JSON.stringify(b.timing);
      data.nextRunAt = nextRun(b.timing as Timing);
    }
    if (typeof b.name === 'string') data.name = str(b.name, 120);
    return json(await prisma().schedule.update({ where: { id }, data }));
  }],
  ['DELETE', 'schedules/:id', async (_r, [id]) => {
    await prisma().schedule.delete({ where: { id } });
    await audit('owner', 'schedule.delete', id);
    return json({ ok: true });
  }],
  ['POST', 'schedules/:id/run', async (_r, [id]) => {
    const s = await prisma().schedule.findUnique({ where: { id } });
    need(s, 'Schedule not found.');
    const result = await runScheduleAction(s.action, parseJson(s.payload, {}));
    await prisma().schedule.update({ where: { id }, data: { lastRunAt: new Date(), lastResult: `ok (manual): ${result}`.slice(0, 500) } });
    return json({ result });
  }],

  // ---------- Prompt library ----------
  ['GET', 'prompts', async () => json(await prisma().promptTemplate.findMany({ orderBy: [{ uses: 'desc' }, { title: 'asc' }] }))],
  ['POST', 'prompts', async (req) => {
    const b = await body(req);
    need(str(b.title) && str(b.body), 'Title and body are required.');
    return json(await prisma().promptTemplate.create({ data: { title: String(b.title).slice(0, 160), body: String(b.body).slice(0, 30_000), category: str(b.category, 40) ?? 'general', tags: str(b.tags, 300) ?? null, lang: b.lang === 'ar' ? 'ar' : 'en' } }), 201);
  }],
  ['PATCH', 'prompts/:id', async (req, [id]) => {
    const b = await body(req);
    const data: Record<string, unknown> = {};
    for (const k of ['title', 'body', 'category', 'tags']) if (typeof b[k] === 'string') data[k] = str(b[k], 30_000);
    return json(await prisma().promptTemplate.update({ where: { id }, data }));
  }],
  ['DELETE', 'prompts/:id', async (_r, [id]) => {
    await prisma().promptTemplate.delete({ where: { id } });
    return json({ ok: true });
  }],
  ['POST', 'prompts/:id/use', async (req, [id]) => {
    const b = await body(req);
    const t = await prisma().promptTemplate.findUnique({ where: { id } });
    need(t, 'Template not found.');
    const project = str(b.projectId) ? await prisma().project.findUnique({ where: { id: String(b.projectId) } }) : null;
    const vars: Record<string, string> = { project: project?.name ?? '', projectPath: project?.rootPath ?? '', ...(typeof b.vars === 'object' && b.vars ? (b.vars as Record<string, string>) : {}) };
    const text = t.body.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => vars[k] ?? `{{${k}}}`);
    await prisma().promptTemplate.update({ where: { id }, data: { uses: { increment: 1 } } });
    return json({ text });
  }],

  // ---------- Cloud backup ----------
  ['GET', 'backup/cloud', async () => {
    const secrets = await listSecretNames();
    const dir = dataPath('backups');
    const encrypted = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.dcenc')).map((f) => ({ name: f, sizeMb: fs.statSync(path.join(dir, f)).size / 1048576 })) : [];
    return json({ settings: await getSetting('cloudBackup', {}), hasPassphrase: secrets.includes('backupPassphrase'), hasR2Secret: secrets.includes('r2SecretAccessKey'), encrypted });
  }],
  ['PUT', 'backup/cloud', async (req) => {
    const b = await body(req);
    const folder = str(b.folder) ? validateLocalPath(b.folder) : undefined;
    const r2 = b.r2 && typeof b.r2 === 'object' ? (b.r2 as Record<string, string>) : undefined;
    if (r2) need(/^[a-f0-9]{32}$/i.test(r2.accountId ?? '') && /^[a-z0-9][a-z0-9-]{1,62}$/.test(r2.bucket ?? '') && (r2.accessKeyId ?? '').length >= 16, 'Invalid R2 account id, bucket or access key id.');
    await setSetting('cloudBackup', { folder, r2: r2 ? { accountId: r2.accountId, bucket: r2.bucket, accessKeyId: r2.accessKeyId, prefix: r2.prefix || 'devcontinuity' } : undefined });
    return json({ ok: true });
  }],
  ['POST', 'backup/cloud/run', async () => json({ jobId: await startJob('cloud-backup', async (h) => {
    h.progress(0, 1, 'Creating, encrypting and uploading the backup…');
    const r = await runCloudBackup();
    h.progress(1, 1, r.results.join('; '));
    return r;
  }, { exclusive: true }) }, 202)],
  ['POST', 'backup/decrypt', async (req) => {
    const b = await body(req);
    const file = path.join(dataPath('backups'), path.basename(String(b.name ?? '')));
    need(file.endsWith('.dcenc') && fs.existsSync(file) && isInside(file, dataPath('backups')), 'Encrypted backup not found.');
    const out = await decryptBackupFile(file, String(b.passphrase ?? ''));
    const row = await prisma().backup.create({ data: { filePath: out, sizeMb: fs.statSync(out).size / 1048576, kind: 'decrypted', note: `decrypted from ${path.basename(file)}` } });
    return json({ backupId: row.id, file: out });
  }],

  // ---------- Remote access & voice ----------
  ['GET', 'remote/status', async () => json({ allowRemote: process.env.DEVCONTINUITY_ALLOW_REMOTE === '1', hosts: (process.env.DEVCONTINUITY_REMOTE_HOSTS ?? '').split(',').filter(Boolean), accessTeam: process.env.CF_ACCESS_TEAM_DOMAIN ?? null, accessAudConfigured: !!process.env.CF_ACCESS_AUD, remoteApprovals: await getSetting('remoteApprovals', false), cloudflaredInstalled: (process.env.PATH ?? '').split(path.delimiter).some((d) => d && fs.existsSync(path.join(d, 'cloudflared.exe'))) })],
  ['POST', 'voice/intent', async (req) => {
    const text = String((await body(req)).text ?? '').trim();
    const projects = await prisma().project.findMany({ select: { id: true, name: true } });
    const agentWords: [RegExp, LaunchAgent][] = [[/claude|كلود/i, 'claude-code'], [/codex|كودكس/i, 'codex'], [/open ?code|أوبن ?كود/i, 'opencode'], [/cursor|كيرسر|كرسر/i, 'cursor']];
    const agent = agentWords.find(([re]) => re.test(text))?.[1];
    const project = projects.filter((p) => text.toLowerCase().includes(p.name.toLowerCase()) || text.toLowerCase().includes(p.name.toLowerCase().replace(/[-_]/g, ' '))).sort((a, b) => b.name.length - a.name.length)[0];
    if (/^(continue|resume|كمل|أكمل|تابع|استمر)/i.test(text) && project && agent) return json({ action: 'launch', agent, projectId: project.id, projectName: project.name });
    if (/^(ask|what|where|which|how|why|when|هل|ما|ماذا|أين|اين|كيف|لماذا|متى)/i.test(text)) return json({ action: 'ask', question: text });
    return json({ action: 'order', instruction: text, projectId: project?.id ?? null });
  }],
];
