import { SchedulesManager } from '@/components/dc/tools-ui';
import { PageHeader } from '@/components/dc/ui';
import { ensureDb, prisma } from '@/server/db';
import { seedOrg } from '@/server/org/seed';
import { getT } from '@/lib/server-i18n';

export const dynamic = 'force-dynamic';

export default async function SchedulesPage() {
  await ensureDb();
  await seedOrg();
  const { t } = await getT();
  const projects = await prisma().project.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true } });
  return (
    <div>
      <PageHeader title={t.schedules} subtitle="Recurring work: briefs, worktree scans, test runs, security audits, or recurring orders to the AI organization." />
      <SchedulesManager projects={projects} />
    </div>
  );
}
