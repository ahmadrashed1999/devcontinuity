import Link from 'next/link';
import { FilterBar, TextFilter } from '@/components/dc/actions';
import { Empty, PageHeader, Pill } from '@/components/dc/ui';
import { ensureDb, parseJson, prisma } from '@/server/db';
import { ago, fmtDate } from '@/lib/format';
import { getT } from '@/lib/server-i18n';

export const dynamic = 'force-dynamic';

export default async function ProjectsPage({ searchParams }: PageProps<'/projects'>) {
  await ensureDb();
  const { t } = await getT();
  const sp = await searchParams;
  const q = typeof sp.q === 'string' ? sp.q : undefined;
  const projects = await prisma().project.findMany({
    where: q ? { OR: [{ name: { contains: q } }, { rootPath: { contains: q } }] } : {},
    orderBy: { lastActivityAt: 'desc' },
    include: { _count: { select: { sessions: true, tasks: true, handoffs: true } }, tasks: { where: { status: { in: ['in_progress', 'blocked', 'requires_verification'] } }, select: { status: true } } },
  });
  return (
    <div>
      <PageHeader title={t.projects} subtitle={`${projects.length} projects, grouped automatically from session working directories (worktrees fold into their repository).`} />
      <FilterBar><TextFilter name="q" value={q} label="Name or path" /></FilterBar>
      {projects.length === 0 ? <Empty>{t.importFirst}</Empty> : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {projects.map((p) => {
            const stack = parseJson<{ name: string }[]>(p.techStack, []);
            const wip = p.tasks.filter((x) => x.status !== 'requires_verification').length;
            const rv = p.tasks.length - wip;
            return (
              <Link key={p.id} href={`/projects/${p.id}`} className="group rounded-xl border border-border bg-card p-4 transition-colors hover:border-primary/50">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate font-semibold text-white group-hover:text-primary">{p.name}</div>
                    <div className="truncate font-mono text-[11px] text-muted-foreground">{p.rootPath}</div>
                  </div>
                  <div className="shrink-0 text-xs text-muted-foreground">{ago(p.lastActivityAt)}</div>
                </div>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {!p.pathVerified && <Pill className="border-warning/30 text-warning">path unverified</Pill>}
                  {p.pathVerified && !p.pathExists && <Pill className="border-danger/30 text-danger">folder missing</Pill>}
                  {p.isGitRepo && <Pill className="border-border text-slate-300">git</Pill>}
                  {stack.slice(0, 4).map((s) => <Pill key={s.name} className="border-cyan/25 text-cyan">{s.name}</Pill>)}
                </div>
                <div className="mt-3 flex gap-4 text-xs text-muted-foreground">
                  <span>{p._count.sessions} sessions</span>
                  <span>{p._count.tasks} tasks</span>
                  {wip > 0 && <span className="text-warning">{wip} unfinished</span>}
                  {rv > 0 && <span className="text-indigo-300">{rv} to verify</span>}
                </div>
                <div className="mt-1 text-[11px] text-slate-500">{fmtDate(p.firstActivityAt, false)} → {fmtDate(p.lastActivityAt, false)}</div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
