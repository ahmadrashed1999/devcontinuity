import Link from 'next/link';
import { KillSwitch, Md } from '@/components/dc/common';
import { DecisionCard, type Decision, OrderComposer } from '@/components/dc/org-ui';
import { ActionButton } from '@/components/dc/actions';
import { PageHeader, Panel, Stat } from '@/components/dc/ui';
import { getBudget, spentThisMonth } from '@/server/ai/gateway';
import { ensureDb, getSetting, prisma } from '@/server/db';
import { seedOrg } from '@/server/org/seed';
import { ago, fmtNum } from '@/lib/format';
import { getT } from '@/lib/server-i18n';

export const dynamic = 'force-dynamic';

const isFresh = (at: string, ms: number) => !!at && Date.now() - new Date(at).getTime() < ms;

export default async function OwnerToday() {
  await ensureDb();
  await seedOrg();
  const { t, lang } = await getT();
  const db = prisma();
  const [decisions, reviews, running, queued, brief, budget, spent, hb, orders, projects, unverified, recentDone] = await Promise.all([
    db.decisionRequest.findMany({ where: { status: 'pending' }, orderBy: { createdAt: 'desc' }, take: 3 }),
    db.workItem.count({ where: { status: 'owner_review' } }),
    db.run.count({ where: { status: 'running' } }),
    db.workItem.count({ where: { status: 'queued', kind: 'task' } }),
    db.report.findFirst({ where: { kind: { in: ['owner_daily', 'owner_weekly'] } }, orderBy: { createdAt: 'desc' } }),
    getBudget(),
    spentThisMonth(),
    getSetting<{ pid: number | null; at: string }>('orchestrator', { pid: null, at: '' }),
    db.order.findMany({ where: { status: { in: ['planning', 'awaiting_approval', 'in_progress'] } }, orderBy: { createdAt: 'desc' }, take: 6 }),
    db.project.findMany({ orderBy: { lastActivityAt: 'desc' }, select: { id: true, name: true } }),
    db.task.count({ where: { status: 'requires_verification' } }),
    db.workItem.findMany({ where: { status: 'done', kind: 'task' }, orderBy: { updatedAt: 'desc' }, take: 5 }),
  ]);
  const pendingCount = await db.decisionRequest.count({ where: { status: 'pending' } });
  const online = !!hb.pid && isFresh(hb.at, 30_000);
  return (
    <div className="space-y-6">
      <PageHeader title={lang === 'ar' ? 'صباح الخير — أنت المالك' : 'Owner Console'} subtitle={lang === 'ar' ? 'فريقك يخطط وينفذ ويراجع. القرار لك.' : 'Your AI organization plans, executes and reviews. You decide.'} actions={<><KillSwitch big /></>} />
      {!online && <div className="rounded-xl border border-warning/40 bg-warning/10 p-3 text-sm text-amber-100">The background service is offline, so auto-sync, schedules and AI work are paused. Start DevContinuity from the tray icon (or run <code>npm run orchestrator</code>).</div>}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat label={t.decisions} value={fmtNum(pendingCount)} tone={pendingCount ? 'warning' : 'default'} href="/owner/decisions" />
        <Stat label={t.reviews} value={fmtNum(reviews)} tone={reviews ? 'cyan' : 'default'} href="/owner/reviews" />
        <Stat label="Working now" value={fmtNum(running)} hint={`${queued} queued`} href="/activity" />
        <Stat label="AI spend this month" value={`$${spent.toFixed(2)}`} hint={`cap $${budget.monthlyCapUsd} · warn $${budget.warnAtUsd}`} tone={spent >= budget.warnAtUsd ? 'warning' : 'success'} href="/costs" />
        <Stat label="Unverified agent claims" value={fmtNum(unverified)} tone="primary" href="/verify" />
        <Stat label="Background service" value={online ? 'Online' : 'Offline'} tone={online ? 'success' : 'danger'} href="/activity" />
      </div>
      <OrderComposer projects={projects} lang={lang} />
      <div className="grid gap-6 xl:grid-cols-[1.4fr_1fr]">
        <div className="space-y-4">
          <div className="flex items-center justify-between"><h2 className="font-semibold text-white">{t.decisions}</h2><Link href="/owner/decisions" className="text-xs text-primary">All ({pendingCount})</Link></div>
          {decisions.length === 0 && <div className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">{lang === 'ar' ? 'لا توجد قرارات بانتظارك.' : 'No decisions waiting for you.'}</div>}
          {decisions.map((d) => <DecisionCard key={d.id} d={{ ...d, createdAt: d.createdAt.toISOString() } as unknown as Decision} />)}
        </div>
        <div className="space-y-4">
          <Panel title={brief ? `${brief.title} · ${ago(brief.createdAt)}` : 'Owner brief'} actions={<ActionButton path="digest/daily">Generate now</ActionButton>}>
            {brief ? <Md text={(lang === 'ar' ? brief.contentAr : brief.content) ?? brief.content} /> : <div className="text-sm text-muted-foreground">The first brief is generated at 08:00 by the background service, or click “Generate now”.</div>}
          </Panel>
          <Panel title="Active orders" actions={<Link href="/owner/orders" className="text-xs text-primary">All</Link>}>
            {orders.length === 0 ? <div className="text-sm text-muted-foreground">No active orders.</div> : orders.map((o) => <Link key={o.id} href={`/owner/orders?order=${o.id}`} className="flex items-center gap-2 py-1 text-sm hover:text-primary"><span className="truncate text-slate-200">{o.title}</span><span className="ms-auto shrink-0 text-xs text-muted-foreground">{o.status.replace(/_/g, ' ')} · ${o.costUsd.toFixed(2)}</span></Link>)}
          </Panel>
          {recentDone.length > 0 && <Panel title="Recently delivered">{recentDone.map((w) => <div key={w.id} className="py-0.5 text-sm text-slate-300">✅ {w.title} <span className="text-xs text-muted-foreground">{ago(w.updatedAt)}</span></div>)}</Panel>}
        </div>
      </div>
    </div>
  );
}
