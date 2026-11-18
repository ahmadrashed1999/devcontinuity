import Link from 'next/link';
import { ArrowRightLeft, ChevronRight, Plug, Upload } from 'lucide-react';
import { AgentBadge, EndStatePill, Empty, LinkButton, PageHeader, Panel, Sparkline, Stat } from '@/components/dc/ui';
import { ensureDb, prisma } from '@/server/db';
import { AGENT_COLORS, ago, fmtNum } from '@/lib/format';
import { getT } from '@/lib/server-i18n';

export const dynamic = 'force-dynamic';

const DAYS = 14;
const DAY = 86_400_000;
const PROBLEMS = ['interrupted_tool', 'interrupted_response', 'awaiting_assistant', 'api_error'];

/** The clock is read once per request, outside render. */
function clock() {
  const now = Date.now();
  return { now, since: new Date(now - DAYS * DAY), weekAgo: new Date(now - 7 * DAY) };
}

export default async function Overview() {
  await ensureDb();
  const { t, lang } = await getT();
  const db = prisma();
  const { now, since, weekAgo } = clock();

  const [total, perAgent, window, feed, attention, projects, weekProjects, claims, events, lastSync] = await Promise.all([
    db.session.count({ where: { isSubagent: false } }),
    db.session.groupBy({ by: ['agent'], where: { isSubagent: false }, _count: true, _max: { endedAt: true } }),
    db.session.findMany({ where: { isSubagent: false, endedAt: { gte: since } }, select: { agent: true, endedAt: true } }),
    db.session.findMany({ where: { isSubagent: false, endState: { not: 'empty' } }, orderBy: { endedAt: 'desc' }, take: 14, include: { project: { select: { id: true, name: true } } } }),
    db.session.findMany({ where: { isSubagent: false, endState: { in: PROBLEMS }, endedAt: { gte: since } }, orderBy: { endedAt: 'desc' }, take: 6, include: { project: { select: { id: true, name: true } } } }),
    db.project.findMany({ orderBy: { lastActivityAt: 'desc' }, take: 6, include: { _count: { select: { sessions: true } }, tasks: { where: { status: { in: ['in_progress', 'blocked'] } }, select: { id: true } } } }),
    db.session.findMany({ where: { isSubagent: false, endedAt: { gte: weekAgo }, projectId: { not: null } }, select: { projectId: true }, distinct: ['projectId'] }),
    db.task.count({ where: { status: 'requires_verification' } }),
    db.session.aggregate({ _sum: { eventCount: true } }),
    db.setting.findUnique({ where: { key: 'lastAutoSync' } }),
  ]);

  if (total === 0) {
    return (
      <div>
        <PageHeader title={t.dashboard} subtitle={t.overviewSubtitle} />
        <Empty action={<div className="flex flex-wrap justify-center gap-2"><LinkButton href="/import" variant="primary"><Upload className="size-4" /> {t.import}</LinkButton><LinkButton href="/agents"><Plug className="size-4" /> {t.connectMore}</LinkButton></div>}>{t.importFirst}</Empty>
      </div>
    );
  }

  // Sessions per agent per day for the sparklines (oldest → newest).
  const buckets = new Map<string, number[]>();
  for (const s of window) {
    if (!s.endedAt) continue;
    const day = DAYS - 1 - Math.floor((now - s.endedAt.getTime()) / DAY);
    if (day < 0 || day >= DAYS) continue;
    const arr = buckets.get(s.agent) ?? Array<number>(DAYS).fill(0);
    arr[day]++;
    buckets.set(s.agent, arr);
  }
  const agents = perAgent
    .map((a) => ({ agent: a.agent, total: a._count, last: a._max.endedAt, days: buckets.get(a.agent) ?? Array<number>(DAYS).fill(0) }))
    .sort((a, b) => (b.last?.getTime() ?? 0) - (a.last?.getTime() ?? 0));
  const weekSessions = window.filter((s) => s.endedAt && s.endedAt >= weekAgo).length;
  const weekAgents = new Set(window.filter((s) => s.endedAt && s.endedAt >= weekAgo).map((s) => s.agent)).size;
  const isLive = (d: Date | null) => !!d && now - d.getTime() < 10 * 60_000;
  let syncAt: string | undefined;
  try {
    syncAt = (JSON.parse(lastSync?.value ?? '{}') as { at?: string }).at;
  } catch {
    syncAt = undefined;
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={t.dashboard}
        subtitle={<>{t.overviewSubtitle}{syncAt && <span className="text-slate-500"> · {t.lastImport} {ago(syncAt, lang)}</span>}</>}
        actions={<><LinkButton href="/agents"><Plug className="size-4" /> {t.connectMore}</LinkButton><LinkButton href="/handoff" variant="primary"><ArrowRightLeft className="size-4" /> {t.continueCta}</LinkButton></>}
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label={t.sessionsThisWeek} value={fmtNum(weekSessions)} hint={`${fmtNum(total)} ${t.sessionsWord} · ${fmtNum(events._sum.eventCount)} ${t.eventsWord}`} href="/sessions" />
        <Stat label={t.agentsActive} value={`${weekAgents} / ${agents.length}`} tone="cyan" href="/agents" />
        <Stat label={t.projectsActive} value={fmtNum(weekProjects.length)} href="/projects" />
        <Stat label={t.claimsToCheck} value={fmtNum(claims)} tone="primary" href="/tasks?status=requires_verification" />
      </div>

      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-200">{t.activeAgents}</h2>
          <Link href="/agents" className="text-xs text-primary hover:underline">{t.viewAll}</Link>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
          {agents.map((a) => (
            <Link key={a.agent} href={`/sessions?agent=${encodeURIComponent(a.agent)}`} className="group rounded-xl border border-border bg-card p-4 transition-colors hover:border-primary/40">
              <div className="flex items-center gap-2">
                <AgentBadge agent={a.agent} className="text-sm" />
                {isLive(a.last) && <span className="live-pulse rounded-full bg-success/15 px-1.5 py-0.5 text-[10px] font-medium text-success">● {t.liveNow}</span>}
                <ChevronRight className="ms-auto size-4 text-slate-600 transition-colors group-hover:text-primary rtl:rotate-180" />
              </div>
              <div className={`mt-3 ${AGENT_COLORS[a.agent] ?? 'text-slate-400'}`}><Sparkline values={a.days} /></div>
              <div className="mt-2 flex items-baseline justify-between gap-2 text-xs text-muted-foreground">
                <span><span className="text-base font-semibold tabular-nums text-white">{fmtNum(a.days.reduce((x, y) => x + y, 0))}</span> / {DAYS}d · {fmtNum(a.total)} {t.sessionsWord}</span>
                <span className="whitespace-nowrap">{ago(a.last, lang)}</span>
              </div>
            </Link>
          ))}
        </div>
      </section>

      <div className="grid gap-6 xl:grid-cols-[1.4fr_1fr]">
        <Panel title={t.activityFeed} actions={<Link href="/sessions" className="text-xs text-primary hover:underline">{t.viewAll}</Link>} bodyClass="p-0">
          <ul className="divide-y divide-border/60">
            {feed.map((s) => (
              <li key={s.id} className="flex items-start gap-3 px-4 py-3 hover:bg-secondary/25">
                <div className="min-w-0 flex-1">
                  <Link href={`/sessions/${s.id}`} className="line-clamp-2 text-sm font-medium text-slate-100 hover:text-primary">{s.title ?? s.externalId}</Link>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                    <AgentBadge agent={s.agent} className="text-[11px]" />
                    {s.project && <Link href={`/projects/${s.project.id}`} className="max-w-48 truncate hover:text-slate-200">{s.project.name}</Link>}
                    <span>{s.userMessageCount} {t.promptsWord} · {s.toolCallCount} {t.toolCalls}</span>
                    <span className="whitespace-nowrap">{ago(s.endedAt, lang)}</span>
                  </div>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1.5">
                  <EndStatePill state={s.endState} />
                  <Link href={`/sessions/${s.id}?tab=continue`} className="text-[11px] font-medium text-cyan hover:underline">{t.continueShort}</Link>
                </div>
              </li>
            ))}
          </ul>
        </Panel>

        <div className="space-y-6">
          <Panel title={t.needsAttention} bodyClass="p-0">
            {attention.length === 0 ? (
              <div className="p-4 text-sm text-muted-foreground">{t.noRecentProblems}</div>
            ) : (
              <ul className="divide-y divide-border/60">
                {attention.map((s) => (
                  <li key={s.id} className="px-4 py-3">
                    <div className="flex items-start gap-2">
                      <Link href={`/sessions/${s.id}`} className="line-clamp-2 min-w-0 flex-1 text-sm text-slate-100 hover:text-primary">{s.title ?? s.externalId}</Link>
                      <EndStatePill state={s.endState} />
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                      <AgentBadge agent={s.agent} className="text-[11px]" />
                      {s.project && <span className="max-w-40 truncate">{s.project.name}</span>}
                      <span>{ago(s.endedAt, lang)}</span>
                      <Link href={`/sessions/${s.id}?tab=continue`} className="ms-auto font-medium text-cyan hover:underline">{t.continueShort}</Link>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel title={t.projects} actions={<Link href="/projects" className="text-xs text-primary hover:underline">{t.viewAll}</Link>} bodyClass="p-0">
            <ul className="divide-y divide-border/60">
              {projects.map((p) => (
                <li key={p.id} className="flex items-start gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <Link href={`/projects/${p.id}`} className="text-sm font-medium text-slate-100 hover:text-primary">{p.name}</Link>
                    <div className="mt-0.5 line-clamp-1 font-mono text-[11px] text-slate-500" title={p.rootPath} dir="ltr">{p.rootPath}</div>
                    <div className="mt-1 flex flex-wrap gap-x-3 text-[11px] text-muted-foreground">
                      <span>{p._count.sessions} {t.sessionsWord}</span>
                      {p.tasks.length > 0 && <span className="text-warning">{p.tasks.length} {t.unfinished}</span>}
                      {!p.pathExists && p.pathVerified && <span className="text-danger">{t.folderMissing}</span>}
                      <span>{ago(p.lastActivityAt, lang)}</span>
                    </div>
                  </div>
                  <Link href={`/projects/${p.id}?tab=continue`} className="shrink-0 text-[11px] font-medium text-cyan hover:underline">{t.continueShort}</Link>
                </li>
              ))}
            </ul>
          </Panel>
        </div>
      </div>
    </div>
  );
}
