import { FilterBar, Select } from '@/components/dc/actions';
import { TriagePanel, VerifyPanel } from '@/components/dc/tools-ui';
import { PageHeader, Panel } from '@/components/dc/ui';
import { ensureDb, prisma } from '@/server/db';
import { getT } from '@/lib/server-i18n';

export const dynamic = 'force-dynamic';

export default async function VerifyPage({ searchParams }: PageProps<'/verify'>) {
  await ensureDb();
  const { t } = await getT();
  const sp = await searchParams;
  const projectId = typeof sp.projectId === 'string' && sp.projectId ? sp.projectId : undefined;
  const db = prisma();
  const groups = await db.task.groupBy({ by: ['projectId', 'triage'], where: { status: 'requires_verification' }, _count: true });
  const projects = await db.project.findMany({ where: { id: { in: [...new Set(groups.map((g) => g.projectId).filter((x): x is string => !!x))] } }, select: { id: true, name: true } });
  const summary = groups.map((g) => ({ projectId: g.projectId, projectName: projects.find((p) => p.id === g.projectId)?.name ?? '(no project)', triage: g.triage, count: g._count })).sort((a, b) => a.projectName.localeCompare(b.projectName));
  const tasks = projectId ? await db.task.findMany({ where: { projectId, status: 'requires_verification' }, orderBy: [{ triage: 'asc' }, { occurredAt: 'desc' }], take: 400, select: { id: true, title: true, triage: true, triageReason: true } }) : [];
  return (
    <div className="space-y-6">
      <PageHeader title={t.verify} subtitle={t.verifySubtitle} />
      <TriagePanel summary={summary} />
      <Panel title={t.verifyOne}>
        <FilterBar><Select name="projectId" value={projectId} label={t.fProject} options={projects.map((p) => [p.id, p.name])} /></FilterBar>
        {projectId ? <VerifyPanel projectId={projectId} tasks={tasks} /> : <div className="text-sm text-muted-foreground">{t.chooseProject}</div>}
      </Panel>
    </div>
  );
}
