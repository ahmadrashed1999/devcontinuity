import type { AgentComparison } from '@/server/compare';
import type { Dict } from '@/lib/i18n';
import { AGENT_HEX } from '@/lib/format';
import { cn } from '@/lib/utils';

const pct = (n: number | null) => (n == null ? null : `${Math.round(n * 100)}%`);
const dec = (n: number | null, d = 1) => (n == null ? null : n.toFixed(d));

function Cell({ value, bar, tone, na }: { value: string | null; bar?: number | null; tone?: string; na: string }) {
  if (value == null) return <td className="px-3 py-2.5 text-end text-xs italic text-slate-500">{na}</td>;
  return (
    <td className="px-3 py-2.5 text-end">
      <div className="tabular-nums text-slate-100">{value}</div>
      {bar != null && (
        <div className="ms-auto mt-1 h-1.5 w-20 overflow-hidden rounded-full bg-secondary" dir="ltr">
          <div className={cn('h-full rounded-full', tone)} style={{ width: `${Math.round(Math.min(1, bar) * 100)}%` }} />
        </div>
      )}
    </td>
  );
}

/** Server component: the agent comparison table, with honest "not enough data" cells. */
export function AgentCompare({ agents, days, t }: { agents: AgentComparison[]; days: number; t: Dict }) {
  if (!agents.length) return <div className="rounded-xl border border-border bg-card p-6 text-sm text-muted-foreground">{t.compareNone}</div>;
  const maxTools = Math.max(0.0001, ...agents.map((a) => a.toolsPerPrompt ?? 0));
  const maxFiles = Math.max(0.0001, ...agents.map((a) => a.filesPerSession ?? 0));
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">{t.compareIntro.replace('{days}', String(days))}</p>
      <div className="overflow-x-auto rounded-xl border border-border bg-card">
        <table className="w-full min-w-[760px] text-sm">
          <thead>
            <tr className="border-b border-border text-xs text-muted-foreground">
              <th className="px-4 py-2 text-start font-medium">{t.agent}</th>
              <th className="px-3 py-2 text-end font-medium">{t.compareSessions}</th>
              <th className="px-3 py-2 text-end font-medium">{t.compareCompletion}</th>
              <th className="px-3 py-2 text-end font-medium">{t.compareInterruption}</th>
              <th className="px-3 py-2 text-end font-medium">{t.compareError}</th>
              <th className="px-3 py-2 text-end font-medium">{t.compareToolsPerPrompt}</th>
              <th className="px-3 py-2 text-end font-medium">{t.compareFilesPerSession}</th>
              <th className="px-4 py-2 text-end font-medium">{t.compareCostPerDone}</th>
            </tr>
          </thead>
          <tbody>
            {agents.map((a) => (
              <tr key={a.agent} className={cn('border-b border-border/50', !a.enoughData && 'opacity-70')}>
                <td className="px-4 py-2.5">
                  <span className="font-medium" style={{ color: AGENT_HEX[a.agent] ?? '#e2e8f0' }}>{a.label}</span>
                  {!a.enoughData && <div className="text-[11px] text-warning">{t.compareNotEnough.replace('{n}', '5')}</div>}
                </td>
                <td className="px-3 py-2.5 text-end tabular-nums text-slate-100">{a.sessions}</td>
                <Cell na={t.compareNa} value={pct(a.completionRate)} bar={a.completionRate} tone="bg-success" />
                <Cell na={t.compareNa} value={pct(a.interruptionRate)} bar={a.interruptionRate} tone="bg-warning" />
                <Cell na={t.compareNa} value={pct(a.errorRate)} bar={a.errorRate} tone="bg-danger" />
                <Cell na={t.compareNa} value={dec(a.toolsPerPrompt)} bar={a.toolsPerPrompt == null ? null : a.toolsPerPrompt / maxTools} tone="bg-primary" />
                <Cell na={t.compareNa} value={dec(a.filesPerSession)} bar={a.filesPerSession == null ? null : a.filesPerSession / maxFiles} tone="bg-cyan" />
                <td className="px-4 py-2.5 text-end">
                  {a.costPerCompleted != null ? <span className="tabular-nums text-slate-100">${a.costPerCompleted.toFixed(2)}</span> : <span className="text-xs italic text-slate-500" title={t.compareCostHelp}>{a.costedSessions ? t.compareFewCosted.replace('{n}', String(a.costedSessions)) : t.compareNoCost}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">{t.compareFootnote}</p>
    </div>
  );
}
