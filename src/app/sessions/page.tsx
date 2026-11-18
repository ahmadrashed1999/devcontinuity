import Link from 'next/link';
import { FilterBar, Select, TextFilter } from '@/components/dc/actions';
import { AgentBadge, Empty, EndStatePill, PageHeader, Pager, qs } from '@/components/dc/ui';
import { ensureDb, prisma } from '@/server/db';
import { ago, daysAgo, fmtDate, fmtNum } from '@/lib/format';
import { endStateLabel } from '@/lib/i18n';
import { getT } from '@/lib/server-i18n';
import { cn } from '@/lib/utils';

export const dynamic = 'force-dynamic';
const LIMIT = 50;
const WINDOWS: Record<string, number> = { today: 1, '7d': 7, '30d': 30 };
const STATES = ['completed_turn', 'interrupted_tool', 'interrupted_response', 'awaiting_assistant', 'api_error', 'empty'];

export default async function SessionsPage({ searchParams }: PageProps<'/sessions'>) {
  await ensureDb();
  const { t, lang } = await getT();
  const sp = await searchParams;
  const s = (k: string) => (typeof sp[k] === 'string' && sp[k] ? (sp[k] as string) : undefined);
  const offset = Number(s('offset')) || 0;
  const where: Record<string, unknown> = {};
  if (s('agent')) where.agent = s('agent');
  if (s('projectId')) where.projectId = s('projectId');
  if (s('endState')) where.endState = s('endState');
  if (s('subagents') !== '1') where.isSubagent = false;
  if (s('when') && WINDOWS[s('when')!]) where.endedAt = { gte: daysAgo(WINDOWS[s('when')!]) };
  if (s('q')) where.OR = [{ title: { contains: s('q') } }, { firstUserPrompt: { contains: s('q') } }, { externalId: { contains: s('q') } }];
  const db = prisma();
  const { agent: _omit, ...withoutAgent } = where;
  void _omit;
  const [rows, total, projects, agents] = await Promise.all([
    db.session.findMany({ where, orderBy: { endedAt: 'desc' }, take: LIMIT, skip: offset, include: { project: { select: { id: true, name: true } } } }),
    db.session.count({ where }),
    db.project.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true } }),
    db.session.groupBy({ by: ['agent'], where: withoutAgent, _count: true }),
  ]);
  const params = { agent: s('agent'), projectId: s('projectId'), endState: s('endState'), q: s('q'), subagents: s('subagents'), when: s('when') };
  const base = `/sessions${qs(params)}`;
  const chip = (agent?: string) => `/sessions${qs({ ...params, agent })}`;
  const allCount = agents.reduce((a, x) => a + x._count, 0);

  return (
    <div>
      <PageHeader title={t.sessions} subtitle={`${fmtNum(total)} ${t.sessionsWord}`} />

      <div className="dc-scroll mb-3 flex gap-2 pb-1">
        <Link href={chip(undefined)} className={cn('inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-xs', !s('agent') ? 'border-primary/60 bg-primary/15 text-white' : 'border-border text-slate-300 hover:bg-secondary')}>
          {t.allAgents} <span className="tabular-nums text-muted-foreground">{fmtNum(allCount)}</span>
        </Link>
        {agents.sort((a, b) => b._count - a._count).map((a) => (
          <Link key={a.agent} href={chip(a.agent)} className={cn('inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3', s('agent') === a.agent ? 'border-primary/60 bg-primary/15' : 'border-border hover:bg-secondary')}>
            <AgentBadge agent={a.agent} />
            <span className="text-xs tabular-nums text-muted-foreground">{fmtNum(a._count)}</span>
          </Link>
        ))}
      </div>

      <FilterBar>
        {s('agent') && <input type="hidden" name="agent" value={s('agent')} />}
        <TextFilter name="q" value={s('q')} label={t.searchSessions} />
        <Select name="projectId" value={s('projectId')} label={t.project} options={projects.map((p) => [p.id, p.name])} />
        <Select name="endState" value={s('endState')} label={t.howItEnded} options={STATES.map((x) => [x, endStateLabel(t, x)])} />
        <Select name="when" value={s('when')} label={t.when} options={[['today', t.today], ['7d', t.last7], ['30d', t.last30]]} />
        <Select name="subagents" value={s('subagents')} label={t.subagent} options={[['1', t.showSubagents]]} />
      </FilterBar>

      {rows.length === 0 ? (
        <Empty>{t.noResults}</Empty>
      ) : (
        <ul className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border bg-card">
          {rows.map((r) => (
            <li key={r.id} className="flex items-start gap-3 px-4 py-3 hover:bg-secondary/25">
              <div className="min-w-0 flex-1">
                <div className="flex items-start gap-2">
                  {r.isSubagent && <span className="mt-0.5 shrink-0 rounded bg-violet-500/15 px-1.5 text-[10px] text-violet-300">{t.subagent}</span>}
                  <Link href={`/sessions/${r.id}`} className="line-clamp-2 text-sm font-medium text-slate-100 hover:text-primary">{r.title ?? r.externalId}</Link>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                  <AgentBadge agent={r.agent} className="text-[11px]" />
                  {r.primaryModel && <span className="max-w-48 truncate" title={r.primaryModel}>{r.primaryModel}</span>}
                  {r.project && <Link href={`/projects/${r.project.id}`} className="max-w-48 truncate hover:text-slate-200">{r.project.name}</Link>}
                  <span className="tabular-nums">{r.userMessageCount} {t.promptsWord} · {r.toolCallCount} {t.toolCalls}{r.toolErrorCount ? <span className="text-danger"> · {r.toolErrorCount} {t.errors}</span> : null}</span>
                </div>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-1.5 text-end">
                <EndStatePill state={r.endState} />
                <span className="whitespace-nowrap text-[11px] text-muted-foreground" title={fmtDate(r.endedAt)}>{ago(r.endedAt, lang)}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
      <Pager total={total} offset={offset} limit={LIMIT} base={base} />
    </div>
  );
}
