import Link from 'next/link';
import { ActionButton } from '@/components/dc/actions';
import { Md } from '@/components/dc/common';
import { DecisionCard, type Decision, OrderComposer } from '@/modules/org/ui';
import { Empty, PageHeader, Panel, Pill } from '@/components/dc/ui';
import { ensureDb, parseJson, prisma } from '@/server/db';
import { ago, fmtDate } from '@/lib/format';
import { getT } from '@/lib/server-i18n';

export const dynamic = 'force-dynamic';

const STATUS_TONE: Record<string, string> = { done: 'border-success/30 text-success', failed: 'border-danger/30 text-danger', rejected: 'border-danger/30 text-red-300', owner_review: 'border-cyan/30 text-cyan', running: 'border-primary/40 text-indigo-200', head_review: 'border-primary/40 text-indigo-200', qa: 'border-primary/40 text-indigo-200', security_review: 'border-primary/40 text-indigo-200', queued: 'border-border text-slate-300', blocked: 'border-warning/30 text-warning', changes_requested: 'border-warning/30 text-warning', cancelled: 'border-border text-slate-500' };

export default async function OrdersPage({ searchParams }: PageProps<'/owner/orders'>) {
  await ensureDb();
  const { t, lang } = await getT();
  const sp = await searchParams;
  const orderId = typeof sp.order === 'string' ? sp.order : undefined;
  const db = prisma();
  const projects = await db.project.findMany({ orderBy: { lastActivityAt: 'desc' }, select: { id: true, name: true } });
  if (orderId) {
    const order = await db.order.findUnique({ where: { id: orderId } });
    if (!order) return <Empty>Order not found.</Empty>;
    const items = await db.workItem.findMany({ where: { orderId }, orderBy: { createdAt: 'asc' } });
    const decisions = await db.decisionRequest.findMany({ where: { orderId }, orderBy: { createdAt: 'desc' } });
    const project = order.projectId ? projects.find((p) => p.id === order.projectId) : null;
    const plan = parseJson<{ summary?: string } | null>(order.plan, null);
    return (
      <div className="space-y-4">
        <PageHeader title={order.title} subtitle={<>{order.status.replace(/_/g, ' ')} · {project ? <Link href={`/projects/${project.id}`} className="text-primary">{project.name}</Link> : 'no project'} · created {fmtDate(order.createdAt)} · cost ${order.costUsd.toFixed(2)}</>} actions={!['done', 'rejected', 'cancelled', 'failed'].includes(order.status) ? <ActionButton path={`orders/${order.id}/cancel`} confirm="Cancel this order? Queued work stops; finished work and branches are kept.">Cancel order</ActionButton> : null} />
        <Panel title="Order"><div className="whitespace-pre-wrap text-sm text-slate-300" dir="auto">{order.instruction}</div>{order.error && <div className="mt-2 text-sm text-danger">{order.error}</div>}{plan?.summary && <div className="mt-3"><Md text={`**CEO plan:** ${plan.summary}`} /></div>}</Panel>
        <Panel title="Work breakdown">
          {items.length === 0 && <div className="text-sm text-muted-foreground">{order.status === 'planning' ? 'The CEO is preparing the plan…' : order.status === 'awaiting_approval' ? 'Waiting for your plan approval.' : 'No work items.'}</div>}
          <div className="space-y-2">
            {items.filter((i) => !i.parentId).map((ini) => (
              <div key={ini.id} className="rounded-lg border border-border p-3">
                <div className="flex items-center gap-2"><span className="font-medium text-white">{ini.title}</span><Pill className={STATUS_TONE[ini.status] ?? 'border-border'}>{ini.status.replace(/_/g, ' ')}</Pill><span className="text-xs text-muted-foreground">{ini.kind}</span></div>
                <div className="mt-2 space-y-1">
                  {items.filter((c) => c.parentId === ini.id).map((c) => {
                    const ev = parseJson<{ ownerMessage?: string; review?: { verdict: string }; qa?: { passed?: boolean } }>(c.evidence, {});
                    return (
                      <div key={c.id} className="flex flex-wrap items-center gap-2 rounded-md bg-background/50 px-2 py-1.5 text-sm">
                        <Pill className={STATUS_TONE[c.status] ?? 'border-border'}>{c.status.replace(/_/g, ' ')}</Pill>
                        <span className="text-slate-200">{c.title}</span>
                        <span className="text-xs text-muted-foreground">{c.roleKey} · {c.type}{c.executor ? ` · ${c.executor}` : ''}{c.branch ? ` · ${c.branch}` : ''} · ${c.costUsd.toFixed(2)} · {ago(c.updatedAt)}</span>
                        {ev.review && <span className="text-xs text-slate-400">review: {ev.review.verdict}</span>}
                        {ev.qa && 'passed' in ev.qa && <span className={`text-xs ${ev.qa.passed ? 'text-success' : 'text-danger'}`}>tests {ev.qa.passed ? 'passed' : 'failed'}</span>}
                        {['failed', 'blocked'].includes(c.status) && <ActionButton path={`workitems/${c.id}/retry`} className="h-6 px-2 text-xs">Retry</ActionButton>}
                        {ev.ownerMessage && <div className="w-full text-xs text-warning">{ev.ownerMessage}</div>}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </Panel>
        {decisions.map((d) => <DecisionCard key={d.id} d={{ ...d, createdAt: d.createdAt.toISOString() } as unknown as Decision} />)}
      </div>
    );
  }
  const orders = await db.order.findMany({ orderBy: { createdAt: 'desc' }, take: 100, include: { _count: { select: { workItems: true } } } });
  return (
    <div className="space-y-4">
      <PageHeader title={t.orders} subtitle="Every order you gave the AI organization, its plan, progress and cost." />
      <OrderComposer projects={projects} lang={lang} />
      {orders.length === 0 ? <Empty>No orders yet. Give your first order above.</Empty> : (
        <div className="overflow-hidden rounded-xl border border-border">
          <table className="w-full text-sm">
            <tbody>
              {orders.map((o) => (
                <tr key={o.id} className="border-t border-border first:border-0 hover:bg-secondary/30">
                  <td className="p-2"><Link href={`/owner/orders?order=${o.id}`} className="text-slate-100 hover:text-primary" dir="auto">{o.title}</Link></td>
                  <td className="p-2"><Pill className={STATUS_TONE[o.status] ?? 'border-border text-slate-300'}>{o.status.replace(/_/g, ' ')}</Pill></td>
                  <td className="p-2 text-xs text-muted-foreground">{projects.find((p) => p.id === o.projectId)?.name ?? '—'}</td>
                  <td className="p-2 text-xs text-muted-foreground">{o._count.workItems} items</td>
                  <td className="p-2 text-end text-xs tabular-nums">${o.costUsd.toFixed(2)}</td>
                  <td className="p-2 text-end text-xs text-muted-foreground">{ago(o.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
