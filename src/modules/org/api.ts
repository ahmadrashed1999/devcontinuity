import type { NextRequest } from 'next/server';
import { audit } from '@/server/audit';
import { getSetting, parseJson, prisma, setSetting } from '@/server/db';
import { PathError } from '@/server/security/paths';
import { validateCommand } from '@/server/verify/runner';
import { abortAll, answerDecision, createCompare, createOrder } from './server/engine';
import { seedOrg } from './server/seed';

/**
 * API of the optional AI organization module. The core API router only dispatches to these routes
 * while the module is switched on (Settings → Features); otherwise they answer 404.
 */

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

export const orgRoutes: [string, string, Handler][] = [
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
];
