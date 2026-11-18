import Link from 'next/link';
import { FilterBar, Select } from '@/components/dc/actions';
import { EndStatePill, PageHeader } from '@/components/dc/ui';
import { ensureDb, parseJson, prisma } from '@/server/db';
import { AGENT_COLORS, fmtDate, agentName } from '@/lib/format';
import { getT } from '@/lib/server-i18n';

export const dynamic = 'force-dynamic';

const daysAgo = (days: number) => new Date(Date.now() - days * 86400_000);

type Item = { at: Date; kind: 'session' | 'commit' | 'pr' | 'handoff'; title: string; href?: string; projectName?: string; agent?: string; endState?: string; detail?: string };

export default async function TimelinePage({ searchParams }: PageProps<'/timeline'>) {
  await ensureDb();
  const { t } = await getT();
  const sp = await searchParams;
  const projectId = typeof sp.projectId === 'string' && sp.projectId ? sp.projectId : undefined;
  const days = Number(sp.days) || 30;
  const since = daysAgo(days);
  const db = prisma();
  const [sessions, handoffs, projects] = await Promise.all([
    db.session.findMany({ where: { projectId, isSubagent: false, endedAt: { gte: since }, endState: { not: 'empty' } }, orderBy: { endedAt: 'desc' }, take: 400, include: { project: { select: { name: true } } } }),
    db.handoff.findMany({ where: { projectId, createdAt: { gte: since } }, include: { project: { select: { name: true } } } }),
    db.project.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true } }),
  ]);
  const items: Item[] = [];
  for (const s of sessions) {
    items.push({ at: s.endedAt!, kind: 'session', title: s.title ?? s.externalId, href: `/sessions/${s.id}`, projectName: s.project?.name, agent: s.agent, endState: s.endState, detail: `${s.userMessageCount} prompts · ${s.toolCallCount} tool calls${s.worktree ? ` · worktree ${s.worktree}` : ''}` });
    for (const g of parseJson<{ gitOps?: { kind: string; sha?: string; branch?: string; prUrl?: string; timestamp?: string }[] }>(s.providerMeta, {}).gitOps ?? []) {
      if (!g.timestamp || new Date(g.timestamp) < since) continue;
      if (g.kind === 'commit') items.push({ at: new Date(g.timestamp), kind: 'commit', title: `Commit ${g.sha?.slice(0, 10) ?? ''}${g.branch ? ` on ${g.branch}` : ''}`, href: `/sessions/${s.id}`, projectName: s.project?.name, agent: s.agent, detail: 'recorded by the git tool in the transcript' });
      if (g.kind === 'pr' && g.prUrl) items.push({ at: new Date(g.timestamp), kind: 'pr', title: `Pull request ${g.prUrl.split('/').slice(-1)[0]}`, href: g.prUrl, projectName: s.project?.name, agent: s.agent });
    }
  }
  for (const h of handoffs) items.push({ at: h.createdAt, kind: 'handoff', title: `Handoff created for ${h.targetAgent}`, href: `/handoff`, projectName: h.project.name });
  items.sort((a, b) => b.at.getTime() - a.at.getTime());
  const byDay = new Map<string, Item[]>();
  for (const it of items) {
    const d = fmtDate(it.at, false);
    byDay.set(d, [...(byDay.get(d) ?? []), it]);
  }
  const dot = { session: 'bg-primary', commit: 'bg-success', pr: 'bg-cyan', handoff: 'bg-warning' };
  return (
    <div>
      <PageHeader title={t.timeline} subtitle="Sessions, commits and pull requests recorded in transcripts, plus handoffs, newest first." />
      <FilterBar>
        <Select name="projectId" value={projectId} label="Project" options={projects.map((p) => [p.id, p.name])} />
        <Select name="days" value={String(days)} label="Period" options={[['7', 'Last 7 days'], ['30', 'Last 30 days'], ['90', 'Last 90 days'], ['3650', 'Everything']]} />
      </FilterBar>
      <div className="space-y-6">
        {[...byDay.entries()].map(([day, list]) => (
          <div key={day}>
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{day}</div>
            <div className="space-y-1.5 border-s border-border ps-4">
              {list.map((it, i) => (
                <div key={i} className="relative flex flex-wrap items-center gap-2 text-sm">
                  <span className={`absolute -start-[21px] top-1.5 size-2.5 rounded-full ${dot[it.kind]}`} />
                  <span className="w-12 text-xs tabular-nums text-slate-500">{fmtDate(it.at).slice(11)}</span>
                  {it.href ? <Link href={it.href} className="text-slate-100 hover:text-primary">{it.title}</Link> : <span>{it.title}</span>}
                  {it.endState && <EndStatePill state={it.endState} />}
                  {it.agent && <span className={`text-xs ${AGENT_COLORS[it.agent]}`}>{agentName(it.agent)}</span>}
                  {it.projectName && <span className="text-xs text-muted-foreground">{it.projectName}</span>}
                  {it.detail && <span className="text-[11px] text-slate-500">{it.detail}</span>}
                </div>
              ))}
            </div>
          </div>
        ))}
        {items.length === 0 && <div className="text-sm text-muted-foreground">No activity in this period.</div>}
      </div>
    </div>
  );
}
