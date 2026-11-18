import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * End-to-end test of the AI organization against a mock OpenAI-compatible model server and a
 * throwaway Git repository: order → CEO plan → owner approval → worker writes code in a sandbox
 * worktree → head review → owner review → owner-approved merge.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-org-'));
process.env.DEVCONTINUITY_DATA_DIR = path.join(tmp, 'data');
fs.mkdirSync(process.env.DEVCONTINUITY_DATA_DIR, { recursive: true });

let server: http.Server;
let port = 0;
const calls: string[] = [];

function reply(body: Record<string, unknown>) {
  const messages = body.messages as { role: string; content: string | null }[];
  const system = messages.find((m) => m.role === 'system')?.content ?? '';
  if (body.tools) {
    const hasResult = messages.some((m) => m.role === 'tool');
    calls.push(hasResult ? 'worker:finish' : 'worker:write');
    const call = hasResult
      ? { id: 'c2', type: 'function', function: { name: 'finish', arguments: JSON.stringify({ status: 'done', summary: 'Created hello.txt with the greeting.' }) } }
      : { id: 'c1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'hello.txt', content: 'Hello from the AI organization\n' }) } };
    return { model: 'mock-model', choices: [{ message: { content: null, tool_calls: [call] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 100, completion_tokens: 20 } };
  }
  let content: unknown;
  if (system.includes('Rules for the plan')) {
    calls.push('plan');
    content = { summary: 'Add a greeting file.', assumptions: [], risks: ['none'], questionsForOwner: [], estimatedCostUsd: 0.1, recommendation: 'Approve.', initiatives: [{ title: 'Greeting', goal: 'Add hello.txt', tasks: [{ title: 'Create hello.txt', roleKey: 'web_dev', type: 'code', description: 'Create hello.txt containing a greeting.', acceptance: ['hello.txt exists with a greeting'], dependsOnTaskNumbers: [] }] }] };
  } else if (system.includes('Review the deliverable strictly')) {
    calls.push('review');
    content = { verdict: 'approve', summary: 'Meets the criteria.', issues: [], acceptance: [{ criterion: 'hello.txt exists with a greeting', met: true, note: '' }] };
  } else if (system.includes('Report only real, specific risks')) {
    calls.push('security');
    content = { risk: 'none', findings: [] };
  } else {
    calls.push('text');
    content = 'ok';
  }
  return { model: 'mock-model', choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) }, finish_reason: 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 10 } };
}

const repo = path.join(tmp, 'repo');
const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      if (req.url?.endsWith('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'mock-model' }] }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(reply(JSON.parse(data))));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  port = (server.address() as { port: number }).port;

  execSync('npx prisma migrate deploy', { env: { ...process.env, DATABASE_URL: `file:${path.join(process.env.DEVCONTINUITY_DATA_DIR!, 'devcontinuity.db').replace(/\\/g, '/')}` }, stdio: 'ignore' });

  fs.mkdirSync(repo);
  git('init', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  fs.writeFileSync(path.join(repo, 'README.md'), '# test\n');
  git('add', '-A');
  git('commit', '-m', 'init');
}, 120_000);

afterAll(async () => {
  const { disconnectDb } = await import('../src/server/db');
  await disconnectDb();
  server?.close();
  try {
    execFileSync('git', ['-C', repo, 'worktree', 'prune']);
  } catch {
    /* ignore */
  }
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
});

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, ms = 60_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 200));
  }
}

describe('AI organization end-to-end', () => {
  it('runs order → plan → approval → work → review → owner merge', async () => {
    const { ensureDb, prisma, setSetting } = await import('../src/server/db');
    const { seedOrg } = await import('../src/modules/org/server/seed');
    const engine = await import('../src/modules/org/server/engine');
    await ensureDb();
    const seeded = await seedOrg();
    expect(seeded.departments).toBe(17);
    expect(seeded.roles).toBeGreaterThan(30);

    const db = prisma();
    const provider = await db.provider.create({ data: { kind: 'lmstudio', name: 'Mock local model', baseUrl: `http://127.0.0.1:${port}/v1` } });
    const route = [{ providerId: provider.id, model: 'mock-model' }];
    await setSetting('aiRoutes', { plan: route, worker: route, review: route, summary: route, analysis: route, chat: route, digest: route, triage: route });
    // The AI organization is an optional feature, off by default.
    await setSetting('features', { aiOrg: true });
    await db.role.update({ where: { key: 'web_dev' }, data: { executor: 'api', autonomy: 'L1' } });
    const project = await db.project.create({ data: { name: 'repo', slug: 'repo', rootPath: repo, pathKey: repo.toLowerCase().replace(/\\/g, '/'), pathVerified: true, pathExists: true, isGitRepo: true } });

    const order = await engine.createOrder({ instruction: 'Add a hello.txt greeting file', projectId: project.id });
    await engine.planOrder(order.id);
    const plan = await db.decisionRequest.findFirstOrThrow({ where: { orderId: order.id, kind: 'plan_approval', status: 'pending' } });
    expect((await db.order.findUnique({ where: { id: order.id } }))?.status).toBe('awaiting_approval');

    // Nothing runs before the owner approves.
    await engine.tick();
    expect(await db.workItem.count({ where: { orderId: order.id } })).toBe(0);

    await engine.answerDecision(plan.id, 'approve');
    const task = await db.workItem.findFirstOrThrow({ where: { orderId: order.id, kind: 'task' } });
    expect(task.status).toBe('queued');

    await engine.tick();
    const review = await waitFor(() => db.decisionRequest.findFirst({ where: { workItemId: task.id, kind: 'merge', status: 'pending' } }));
    const item = await db.workItem.findUniqueOrThrow({ where: { id: task.id } });
    expect(item.status).toBe('owner_review');
    expect(item.branch).toMatch(/^dc\//);
    expect(item.worktreePath && fs.existsSync(path.join(item.worktreePath, 'hello.txt'))).toBe(true);
    // The owner's repository is untouched until approval.
    expect(fs.existsSync(path.join(repo, 'hello.txt'))).toBe(false);
    expect(git('rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');
    expect(calls).toEqual(expect.arrayContaining(['plan', 'worker:write', 'worker:finish', 'review']));
    expect(await db.usageRecord.count({ where: { model: 'mock-model' } })).toBeGreaterThanOrEqual(4);

    const res = await engine.answerDecision(review.id, 'approve_merge');
    expect(res.message).toMatch(/Merged/);
    expect(fs.readFileSync(path.join(repo, 'hello.txt'), 'utf8')).toContain('Hello from the AI organization');
    expect((await db.workItem.findUnique({ where: { id: task.id } }))?.status).toBe('done');
    expect((await db.order.findUnique({ where: { id: order.id } }))?.status).toBe('done');
    expect(await db.auditEvent.count({ where: { action: 'git.merge' } })).toBe(1);
  }, 120_000);

  it('refuses merges onto a dirty tree and honours the kill switch', async () => {
    const { prisma, setSetting } = await import('../src/server/db');
    const { mergeApproved } = await import('../src/server/git/write');
    const { chat } = await import('../src/server/ai/gateway');
    fs.writeFileSync(path.join(repo, 'README.md'), '# changed by owner\n');
    const r = await mergeApproved(repo, 'main');
    expect(r.merged).toBe(false);
    expect(r.message).toMatch(/uncommitted/);
    expect(fs.readFileSync(path.join(repo, 'README.md'), 'utf8')).toContain('changed by owner');

    await setSetting('killSwitch', true);
    await expect(chat({ job: 'worker', messages: [{ role: 'user', content: 'x' }], ctx: { origin: 'org' } })).rejects.toThrow(/kill switch/);
    await setSetting('killSwitch', false);
    expect(await prisma().usageRecord.count()).toBeGreaterThan(0);
  }, 60_000);

  it('enforces the monthly budget for paid providers', async () => {
    const { prisma, setSetting } = await import('../src/server/db');
    const { chat } = await import('../src/server/ai/gateway');
    const db = prisma();
    const paid = await db.provider.create({ data: { kind: 'openai-compatible', name: 'Paid mock', baseUrl: `http://127.0.0.1:${port}/v1`, keyRef: 'env:DC_TEST_KEY' } });
    process.env.DC_TEST_KEY = 'test-key-123';
    await setSetting('aiConsent', true);
    await setSetting('budget', { monthlyCapUsd: 1, warnAtUsd: 0.5 });
    await db.usageRecord.create({ data: { providerKind: 'openai', model: 'x', job: 'summary', costUsd: 1.5 } });
    await expect(chat({ job: 'summary', route: `${paid.id}:mock-model`, messages: [{ role: 'user', content: 'hi' }], ctx: { origin: 'owner' } })).rejects.toThrow(/budget/);
  }, 30_000);
});
