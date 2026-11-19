import Link from 'next/link';
import { PageHeader, Panel, Stat } from '@/components/dc/ui';
import { costOverview } from '@/server/costs';
import { ensureDb } from '@/server/db';
import { fmtDate, agentName } from '@/lib/format';
import { getT } from '@/lib/server-i18n';

export const dynamic = 'force-dynamic';

export default async function CostsPage() {
  await ensureDb();
  const { t } = await getT();
  const c = await costOverview();
  const max = Math.max(0.01, ...c.byDay.map((d) => d.costUsd));
  const usd = (n: number) => `$${n.toFixed(n < 1 ? 3 : 2)}`;
  return (
    <div className="space-y-6">
      <PageHeader title={t.costs} subtitle={t.costsSubtitle} />
      {c.warnings.map((w) => <div key={w} className="rounded-xl border border-warning/40 bg-warning/10 p-3 text-sm text-amber-100">{w}</div>)}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label={t.cThisMonth} value={usd(c.monthSpent)} tone={c.monthSpent >= c.budget.warnAtUsd ? 'warning' : 'success'} hint={t.cWarnCap.replace('{warn}', String(c.budget.warnAtUsd)).replace('{cap}', String(c.budget.monthlyCapUsd))} href="/settings?tab=ai" />
        <Stat label={t.cBudgetLeft} value={usd(Math.max(0, c.budget.monthlyCapUsd - c.monthSpent))} />
        <Stat label={t.cLimitHits} value={c.limitEvents.length} tone={c.limitEvents.length ? 'danger' : 'default'} hint={t.cLimitHitsHint} />
        <Stat label={t.cAgentCost} value={usd(c.transcriptCostByAgent.reduce((a, x) => a + x.costUsd, 0))} hint={t.cAgentCostHint} />
      </div>
      <Panel title={t.cLast30}>
        {c.byDay.length === 0 ? <div className="text-sm text-muted-foreground">{t.cNoCalls}</div> : (
          <div className="flex h-32 items-end gap-1">{c.byDay.map((d) => <div key={d.day} title={`${d.day}: $${d.costUsd.toFixed(3)}`} className="flex-1 rounded-t bg-gradient-to-t from-primary to-cyan" style={{ height: `${Math.max(2, (d.costUsd / max) * 100)}%` }} />)}</div>
        )}
      </Panel>
      <div className="grid gap-4 xl:grid-cols-3">
        <Panel title={t.cByModel} bodyClass="p-0"><table className="w-full text-xs"><tbody>{c.byModel.map((m) => <tr key={m.model + m.provider} className="border-t border-border first:border-0"><td className="p-2 font-mono text-slate-300">{m.model}<div className="text-[10px] text-slate-500">{m.provider} · {m.calls} {t.cCalls} · {(m.inputTokens / 1000).toFixed(0)}k in / {(m.outputTokens / 1000).toFixed(0)}k out</div></td><td className="p-2 text-end tabular-nums">{usd(m.costUsd)}</td></tr>)}</tbody></table></Panel>
        <Panel title={t.cByJob} bodyClass="p-0"><table className="w-full text-xs"><tbody>{c.byJob.map((j) => <tr key={j.job} className="border-t border-border first:border-0"><td className="p-2 text-slate-300">{j.job} <span className="text-slate-500">({j.calls})</span></td><td className="p-2 text-end tabular-nums">{usd(j.costUsd)}</td></tr>)}</tbody></table></Panel>
        <Panel title={t.cByDept} bodyClass="p-0"><table className="w-full text-xs"><tbody>{c.byDepartment.map((d) => <tr key={d.department} className="border-t border-border first:border-0"><td className="p-2 text-slate-300">{d.department}</td><td className="p-2 text-end tabular-nums">{usd(d.costUsd)}{d.budgetUsd ? <span className="text-slate-500"> / ${d.budgetUsd}</span> : ''}</td></tr>)}</tbody></table></Panel>
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <Panel title={t.cAgentSpending} bodyClass="p-0">
          <table className="w-full text-xs"><tbody>{c.transcriptCostByAgent.map((a) => <tr key={a.agent} className="border-t border-border first:border-0"><td className="p-2 text-slate-300">{agentName(a.agent)}</td><td className="p-2 text-end tabular-nums">{usd(a.costUsd)}</td></tr>)}{c.transcriptCostByProject.map((p) => <tr key={p.project} className="border-t border-border"><td className="p-2 ps-6 text-slate-400">{p.project}</td><td className="p-2 text-end tabular-nums text-slate-400">{usd(p.costUsd)}</td></tr>)}</tbody></table>
          <p className="p-2 text-[11px] text-muted-foreground">{t.cAgentSpendingNote}</p>
        </Panel>
        <Panel title={t.cLimitStops} bodyClass="p-0">
          <table className="w-full text-xs"><tbody>{c.limitEvents.map((l) => <tr key={l.id} className="border-t border-border first:border-0"><td className="whitespace-nowrap p-2 text-muted-foreground">{fmtDate(l.at)}</td><td className="p-2"><Link href={`/sessions/${l.id}?tab=continue`} className="text-slate-200 hover:text-primary">{l.project ?? l.agent}</Link><div className="text-[10px] text-slate-500">{l.detail.slice(0, 120)}</div></td></tr>)}</tbody></table>
          <p className="p-2 text-[11px] text-muted-foreground">{t.cLimitTip}</p>
        </Panel>
      </div>
      <Panel title={t.cModelsUsed}><div className="flex flex-wrap gap-2 text-xs">{c.modelSessions.map((m) => <span key={m.model} className="rounded-md border border-border px-2 py-1 font-mono text-slate-300">{m.model} · {m.sessions}</span>)}</div></Panel>
    </div>
  );
}
