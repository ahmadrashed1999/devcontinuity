import Link from 'next/link';
import { AgentBadge, Empty, PageHeader, Panel } from '@/components/dc/ui';
import { WrappedShare } from '@/components/dc/wrapped-share';
import { cn } from '@/lib/utils';
import { AGENT_HEX, fmtNum } from '@/lib/format';
import { getT } from '@/lib/server-i18n';
import { ensureDb } from '@/server/db';
import { parsePeriod, wrappedPeriods, wrappedStats } from '@/server/wrapped';

export const dynamic = 'force-dynamic';

function periodLabel(key: string, lang: 'en' | 'ar'): string {
  const [y, m] = key.split('-').map(Number);
  if (!m) return String(y);
  return new Intl.DateTimeFormat(lang === 'ar' ? 'ar' : 'en', { month: 'long', year: 'numeric' }).format(new Date(y, m - 1, 1));
}

function Bars({ values, labels, color = 'bg-primary' }: { values: number[]; labels: string[]; color?: string }) {
  const max = Math.max(1, ...values);
  return (
    <div className="flex h-28 items-end gap-1" dir="ltr">
      {values.map((v, i) => (
        <div key={i} className="flex min-w-0 flex-1 flex-col items-center gap-1" title={`${labels[i]}: ${v}`}>
          <div className={cn('w-full rounded-t', color)} style={{ height: `${Math.max(v ? 4 : 1, (v / max) * 88)}px`, opacity: v ? 1 : 0.2 }} />
          <span className="truncate text-[10px] text-slate-500">{labels[i]}</span>
        </div>
      ))}
    </div>
  );
}

export default async function WrappedPage({ searchParams }: PageProps<'/wrapped'>) {
  await ensureDb();
  const { t, lang } = await getT();
  const sp = await searchParams;
  const periods = await wrappedPeriods();
  const requested = typeof sp.period === 'string' ? sp.period : periods.months[0];
  const period = parsePeriod(requested);
  const s = await wrappedStats(period);
  const label = periodLabel(period.key, lang);
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  const weekdays = Array.from({ length: 7 }, (_, i) => new Intl.DateTimeFormat(lang === 'ar' ? 'ar' : 'en', { weekday: 'short' }).format(new Date(2024, 0, 7 + i)));
  const chip = (key: string, text: string) => (
    <Link key={key} href={`/wrapped?period=${key}`} className={cn('rounded-lg border px-2.5 py-1 text-xs', key === period.key ? 'border-primary bg-primary/20 text-white' : 'border-border text-slate-400 hover:bg-secondary')}>
      {text}
    </Link>
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title={t.wrapped}
        subtitle={t.wrappedSubtitle}
        actions={s.totals.sessions > 0 && <WrappedShare fileName={`ai-coding-wrapped-${period.key}.png`} stats={{ periodLabel: label, sessions: s.totals.sessions, prompts: s.totals.prompts, toolCalls: s.totals.toolCalls, activeDays: s.totals.activeDays, tokens: s.totals.tokens, topProject: s.topProjects[0]?.name ?? null, agents: s.agents.map((a) => ({ agent: a.agent, label: a.label, sessions: a.sessions, finishRate: a.finishRate })) }} />}
      />

      <div className="flex flex-wrap items-center gap-1.5">
        <span className="me-1 text-xs text-muted-foreground">{t.wrappedMonth}</span>
        {periods.months.slice(0, 12).map((m) => chip(m, periodLabel(m, lang)))}
        <span className="ms-3 me-1 text-xs text-muted-foreground">{t.wrappedYear}</span>
        {periods.years.map((y) => chip(y, y))}
      </div>

      {s.totals.sessions === 0 ? (
        <Empty>{t.wrappedEmpty}</Empty>
      ) : (
        <>
          <section className="relative overflow-hidden rounded-2xl border border-primary/30 bg-gradient-to-br from-primary/20 via-card to-cyan/10 p-6">
            <div className="text-sm font-semibold text-indigo-300">{t.wrappedShareTitle} · {label}</div>
            <div className="mt-2 flex flex-wrap items-baseline gap-x-3">
              <span className="text-5xl font-extrabold tabular-nums text-white sm:text-6xl">{fmtNum(s.totals.sessions)}</span>
              <span className="text-lg text-slate-300">{t.wrappedSessions} {t.wrappedAcross.replace('{n}', String(s.totals.agents))}</span>
            </div>
            <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              {([
                [fmtNum(s.totals.prompts), t.wrappedPrompts],
                [fmtNum(s.totals.toolCalls), t.wrappedToolCalls],
                [fmtNum(s.totals.projects), t.wrappedProjects],
                [fmtNum(s.totals.activeDays), t.wrappedActiveDays],
                [s.totals.tokens != null ? fmtNum(s.totals.tokens) : t.wrappedNotRecorded, t.wrappedTokens],
                [s.totals.costUsd != null ? `$${s.totals.costUsd.toFixed(2)}` : t.wrappedNotRecorded, t.wrappedCost],
              ] as [string, string][]).map(([v, l]) => (
                <div key={l} className="rounded-xl border border-white/10 bg-white/5 p-3">
                  <div className="text-xl font-bold tabular-nums text-white">{v}</div>
                  <div className="text-xs text-slate-400">{l}</div>
                </div>
              ))}
            </div>
            {s.totals.limitsHit > 0 && <div className="mt-3 text-xs text-red-300">{s.totals.limitsHit} {t.wrappedLimits}</div>}
          </section>

          <Panel title={t.wrappedPerAgent} bodyClass="p-0">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm">
                <thead>
                  <tr className="border-b border-border text-xs text-muted-foreground">
                    <th className="px-4 py-2 text-start font-medium">{t.agent}</th>
                    <th className="px-3 py-2 text-end font-medium">{t.wrappedSessions}</th>
                    <th className="px-3 py-2 text-end font-medium">{t.wrappedPrompts}</th>
                    <th className="px-3 py-2 text-end font-medium">{t.wrappedToolCalls}</th>
                    <th className="px-3 py-2 text-end font-medium">{t.wrappedTokens}</th>
                    <th className="px-4 py-2 text-start font-medium">{t.wrappedFinished} / {t.wrappedInterrupted} / {t.wrappedErrors}</th>
                  </tr>
                </thead>
                <tbody>
                  {s.agents.map((a) => (
                    <tr key={a.agent} className="border-b border-border/50">
                      <td className="px-4 py-2"><AgentBadge agent={a.agent} /></td>
                      <td className="px-3 py-2 text-end tabular-nums text-white">{fmtNum(a.sessions)}</td>
                      <td className="px-3 py-2 text-end tabular-nums">{fmtNum(a.prompts)}</td>
                      <td className="px-3 py-2 text-end tabular-nums">{fmtNum(a.toolCalls)}</td>
                      <td className="px-3 py-2 text-end tabular-nums text-muted-foreground">{a.tokens != null ? fmtNum(a.tokens) : '–'}</td>
                      <td className="px-4 py-2">
                        <div className="flex h-2.5 w-full max-w-64 overflow-hidden rounded-full bg-secondary" dir="ltr" title={`${pct(a.finishRate)} / ${pct(a.interruptRate)} / ${pct(a.errorRate)}`}>
                          <div className="bg-success" style={{ width: pct(a.finishRate) }} />
                          <div className="bg-warning" style={{ width: pct(a.interruptRate) }} />
                          <div className="bg-danger" style={{ width: pct(a.errorRate) }} />
                        </div>
                        <div className="mt-0.5 text-[11px] text-muted-foreground">{pct(a.finishRate)} · {pct(a.interruptRate)} · {pct(a.errorRate)}</div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>

          <div className="grid gap-6 lg:grid-cols-2">
            <Panel title={t.wrappedWeekdays}><Bars values={s.byWeekday} labels={weekdays} /></Panel>
            <Panel title={t.wrappedHours}><Bars values={s.byHour} labels={s.byHour.map((_, h) => (h % 3 === 0 ? String(h) : ''))} color="bg-cyan" /></Panel>
            <Panel title={t.wrappedTopProjects} bodyClass="p-0">
              <ul className="divide-y divide-border/60">
                {s.topProjects.map((p, i) => (
                  <li key={p.name} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                    <span className="w-5 text-muted-foreground">{i + 1}</span>
                    <span className="min-w-0 flex-1 truncate text-slate-100">{p.name}</span>
                    <span className="text-xs text-muted-foreground">{fmtNum(p.sessions)} {t.wrappedSessions} · {p.agents} {t.wrappedAgents}</span>
                  </li>
                ))}
              </ul>
            </Panel>
            <Panel title={t.wrappedBusiest} bodyClass="p-0">
              <ul className="divide-y divide-border/60">
                {s.busiestDays.map((d) => (
                  <li key={d.day} className="flex items-center justify-between px-4 py-2.5 text-sm">
                    <span className="text-slate-100">{new Intl.DateTimeFormat(lang === 'ar' ? 'ar' : 'en', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(`${d.day}T12:00:00`))}</span>
                    <span className="text-xs text-muted-foreground">{d.sessions} {t.wrappedSessions}</span>
                  </li>
                ))}
              </ul>
            </Panel>
            <Panel title={t.wrappedTopTools} bodyClass="p-0">
              <ul className="divide-y divide-border/60">
                {s.topTools.map((x) => (
                  <li key={x.name} className="flex items-center justify-between px-4 py-2.5 text-sm">
                    <span className="font-mono text-xs text-slate-100" dir="ltr">{x.name}</span>
                    <span className="text-xs text-muted-foreground">{fmtNum(x.calls)}</span>
                  </li>
                ))}
              </ul>
            </Panel>
            {s.longest && (
              <Panel title={t.wrappedLongest}>
                <Link href={`/sessions/${s.longest.id}`} className="block text-sm font-medium text-slate-100 hover:text-primary">{s.longest.title ?? '—'}</Link>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
                  <span style={{ color: AGENT_HEX[s.longest.agent] }}>{s.longest.label}</span>
                  {s.longest.project && <span>{s.longest.project}</span>}
                  <span className="text-white">{s.longest.minutes} {t.wrappedMinutes}</span>
                </div>
              </Panel>
            )}
          </div>

          <p className="text-xs text-muted-foreground">
            {t.wrappedCli} <code className="rounded bg-secondary px-1.5 py-0.5" dir="ltr">npx devcontinuity wrapped --{period.kind} {period.key}</code>
          </p>
        </>
      )}
    </div>
  );
}
