import { FilterBar, Select } from '@/components/dc/actions';
import { WorktreeList } from '@/components/dc/tools-ui';
import { Empty, PageHeader } from '@/components/dc/ui';
import { ensureDb, prisma } from '@/server/db';
import { getT } from '@/lib/server-i18n';

export const dynamic = 'force-dynamic';

export default async function WorktreesPage({ searchParams }: PageProps<'/worktrees'>) {
  await ensureDb();
  const { t } = await getT();
  const sp = await searchParams;
  const projects = await prisma().project.findMany({ where: { isGitRepo: true, pathExists: true }, orderBy: { lastActivityAt: 'desc' }, include: { _count: { select: { sessions: { where: { worktree: { not: null } } } } } } });
  const sorted = [...projects].sort((a, b) => b._count.sessions - a._count.sessions);
  const projectId = typeof sp.projectId === 'string' && sp.projectId ? sp.projectId : sorted[0]?.id;
  return (
    <div>
      <PageHeader title={t.worktrees} subtitle="Every worktree of a project: uncommitted work at risk, unmerged commits, merged and stale ones. This is where hidden unfinished work usually lives." />
      {!projectId ? <Empty>No Git projects found on this machine.</Empty> : (
        <>
          <FilterBar><Select name="projectId" value={projectId} label="Project" options={sorted.map((p) => [p.id, `${p.name}${p._count.sessions ? ` (${p._count.sessions} worktree sessions)` : ''}`])} /></FilterBar>
          <WorktreeList projectId={projectId} />
        </>
      )}
    </div>
  );
}
