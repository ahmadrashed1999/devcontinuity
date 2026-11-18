import { PromptLibrary } from '@/components/dc/tools-ui';
import { PageHeader } from '@/components/dc/ui';
import { ensureDb, prisma } from '@/server/db';
import { seedDefaults } from '@/server/defaults';
import { getT } from '@/lib/server-i18n';

export const dynamic = 'force-dynamic';

export default async function PromptsPage() {
  await ensureDb();
  await seedDefaults();
  const { t } = await getT();
  const projects = await prisma().project.findMany({ orderBy: { lastActivityAt: 'desc' }, select: { id: true, name: true } });
  return (
    <div>
      <PageHeader title={t.prompts} subtitle="Prompts that worked well, reusable with any agent. Fill in the project, copy, or open an agent with the prompt loaded." />
      <PromptLibrary projects={projects} />
    </div>
  );
}
