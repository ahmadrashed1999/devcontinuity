import { aiOrgEnabled } from './features';
import { audit, notify } from './audit';
import { parseJson, prisma } from './db';
import { buildDigest } from './digest';
import { analyzeWorktrees } from './git/worktrees';
import { runImport, silentReporter } from './import/importer';
import { isLocked, withLock } from './lock';
import { startVerification } from './verify/runner';

export interface Timing {
  every: 'day' | 'week' | 'hours';
  at?: string;
  weekday?: number;
  hours?: number;
}

/** Next run time after `from` (local time). */
export function nextRun(t: Timing, from = new Date()): Date {
  if (t.every === 'hours') return new Date(from.getTime() + Math.max(1, t.hours ?? 1) * 3600_000);
  const [h, m] = (t.at ?? '08:00').split(':').map(Number);
  const d = new Date(from);
  d.setHours(h, m, 0, 0);
  if (t.every === 'day') {
    if (d <= from) d.setDate(d.getDate() + 1);
    return d;
  }
  const wd = t.weekday ?? 0;
  let add = (wd - d.getDay() + 7) % 7;
  if (add === 0 && d <= from) add = 7;
  d.setDate(d.getDate() + add);
  return d;
}

export async function runScheduleAction(action: string, payload: Record<string, unknown>): Promise<string> {
  const db = prisma();
  switch (action) {
    case 'digest_daily':
      return (await buildDigest('owner_daily')).title;
    case 'digest_weekly':
      return (await buildDigest('owner_weekly')).title;
    case 'archive_assets': {
      const r = await withLock('import', 60 * 60_000, () => runImport({ agents: ['claude-code'], includeAssets: true }, silentReporter));
      return isLocked(r) ? 'skipped: another import is running' : `archived; ${r.assetsCopied} new file(s)`;
    }
    case 'worktree_scan': {
      const projects = await db.project.findMany({ where: { isGitRepo: true, pathExists: true } });
      let risky = 0;
      let unmerged = 0;
      for (const p of projects) {
        const r = await analyzeWorktrees(p.id).catch(() => null);
        risky += r?.worktrees.filter((w) => w.state === 'at_risk').length ?? 0;
        unmerged += r?.worktrees.filter((w) => w.state === 'unmerged').length ?? 0;
      }
      if (risky || unmerged) await notify('warning', 'Worktrees with unsaved or unmerged work', `${risky} worktree(s) have uncommitted changes and ${unmerged} have unmerged commits.`, '/worktrees', `wt-scan-${new Date().toISOString().slice(0, 10)}`);
      return `${risky} at risk, ${unmerged} unmerged`;
    }
    case 'verify_project':
    case 'security_scan': {
      const projectId = String(payload.projectId ?? '');
      const command = String(payload.command ?? (action === 'security_scan' ? 'npm audit' : ''));
      const id = await startVerification(projectId, command, undefined, 'schedule');
      return `started verification ${id}`;
    }
    case 'order': {
      if (!(await aiOrgEnabled())) return 'skipped: the AI organization is turned off (Settings → Features)';
      // The AI organization is an optional module: loaded only when it is switched on.
      const { createOrder } = await import('@/modules/org/server/engine');
      const o = await createOrder({ instruction: String(payload.instruction ?? ''), projectId: (payload.projectId as string) || null, lang: String(payload.lang ?? 'en') });
      return `order created ${o.id} (plan will come to you for approval)`;
    }
  }
  throw new Error(`Unknown schedule action ${action}`);
}

export async function schedulerTick(log: (m: string) => void = () => {}) {
  const db = prisma();
  const now = new Date();
  for (const s of await db.schedule.findMany({ where: { enabled: true } })) {
    const timing = parseJson<Timing>(s.timing, { every: 'day', at: '08:00' });
    if (!s.nextRunAt) {
      await db.schedule.update({ where: { id: s.id }, data: { nextRunAt: nextRun(timing, now) } });
      continue;
    }
    if (s.nextRunAt > now) continue;
    await db.schedule.update({ where: { id: s.id }, data: { lastRunAt: now, nextRunAt: nextRun(timing, now) } });
    log(`schedule: ${s.name}`);
    try {
      const result = await runScheduleAction(s.action, parseJson<Record<string, unknown>>(s.payload, {}));
      await db.schedule.update({ where: { id: s.id }, data: { lastResult: `ok: ${result}`.slice(0, 500) } });
      await audit('schedule', `schedule.${s.action}`, s.id, { result });
    } catch (e) {
      await db.schedule.update({ where: { id: s.id }, data: { lastResult: `error: ${(e as Error).message}`.slice(0, 500) } });
      await notify('error', `Scheduled job failed: ${s.name}`, (e as Error).message, '/schedules');
    }
  }
}
