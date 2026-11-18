import Link from 'next/link';
import { FilterBar, Select } from '@/components/dc/actions';
import { ChangedFiles } from '@/components/dc/panels';
import { Empty, PageHeader, Panel } from '@/components/dc/ui';
import { ensureDb, prisma } from '@/server/db';
import { getGitState } from '@/server/git/git';
import { fmtDate } from '@/lib/format';
import { getT } from '@/lib/server-i18n';

export const dynamic = 'force-dynamic';

export default async function ChangesPage({ searchParams }: PageProps<'/changes'>) {
  await ensureDb();
  const { t } = await getT();
  const sp = await searchParams;
  const db = prisma();
  const projects = await db.project.findMany({ where: { pathVerified: true }, orderBy: { lastActivityAt: 'desc' }, select: { id: true, name: true, rootPath: true } });
  const projectId = typeof sp.projectId === 'string' && sp.projectId ? sp.projectId : projects[0]?.id;
  const project = projects.find((p) => p.id === projectId);
  if (!project) return <div><PageHeader title={t.changes} /><Empty>{t.importFirst}</Empty></div>;
  const [git, ops] = await Promise.all([
    getGitState(project.rootPath),
    db.fileOp.groupBy({ by: ['path'], where: { projectId: project.id, op: { in: ['write', 'edit', 'notebook_edit', 'delete'] }, NOT: { succeeded: false } }, _count: true, _max: { timestamp: true }, _sum: { linesAdded: true, linesRemoved: true }, orderBy: { _max: { timestamp: 'desc' } }, take: 200 }),
  ]);
  const root = project.rootPath.replace(/\\/g, '/').toLowerCase();
  const rel = (p: string) => (p.replace(/\\/g, '/').toLowerCase().startsWith(`${root}/`) ? p.slice(root.length + 1) : p);
  return (
    <div className="space-y-4">
      <PageHeader title={t.changes} subtitle="Current uncommitted changes from Git (verified) and the file edits agents recorded in transcripts (tool-confirmed)." />
      <FilterBar><Select name="projectId" value={project.id} label="Project" options={projects.map((p) => [p.id, p.name])} /></FilterBar>
      <Panel title={`Uncommitted changes in ${project.name}${git.isRepo ? ` · ${git.branch ?? 'detached'}` : ''}`} actions={<Link href={`/projects/${project.id}?tab=git`} className="text-xs text-primary">Git details</Link>}>
        {!git.isRepo ? <div className="text-sm text-muted-foreground">{git.error}</div> : git.changes.length ? <ChangedFiles projectId={project.id} changes={git.changes} /> : <div className="text-sm text-muted-foreground">Working tree is clean.</div>}
      </Panel>
      <Panel title="Files changed by agents (from transcripts)" bodyClass="p-0">
        <table className="w-full text-sm">
          <thead className="text-xs text-muted-foreground"><tr><th className="p-2 text-start">File</th><th className="p-2 text-end">Changes</th><th className="p-2 text-end">Lines +/−</th><th className="p-2 text-end">Last change</th></tr></thead>
          <tbody>{ops.map((o) => <tr key={o.path} className="border-t border-border"><td className="p-2 font-mono text-xs text-slate-300">{rel(o.path)}</td><td className="p-2 text-end tabular-nums text-muted-foreground">{o._count}</td><td className="p-2 text-end text-xs tabular-nums"><span className="text-success">+{o._sum.linesAdded ?? 0}</span> <span className="text-danger">−{o._sum.linesRemoved ?? 0}</span></td><td className="p-2 text-end text-xs text-muted-foreground">{fmtDate(o._max.timestamp)}</td></tr>)}</tbody>
        </table>
        <p className="p-3 text-[11px] text-muted-foreground">Line counts come from edit patches recorded by tools. Historical diffs are not reconstructed beyond that evidence.</p>
      </Panel>
    </div>
  );
}
