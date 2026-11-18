import { AskChat } from '@/components/dc/tools-ui';
import { PageHeader } from '@/components/dc/ui';
import { ensureDb, prisma } from '@/server/db';
import { getT } from '@/lib/server-i18n';

export const dynamic = 'force-dynamic';

export default async function AskPage() {
  await ensureDb();
  const { t, lang } = await getT();
  const projects = await prisma().project.findMany({ orderBy: { lastActivityAt: 'desc' }, select: { id: true, name: true } });
  return (
    <div>
      <PageHeader title={t.ask} subtitle="Search finds the relevant parts of your history (full-text, plus local embeddings if you configure an embed route); the AI answers only from those sources and cites them. Without AI you still get the matching sources." />
      <AskChat projects={projects} lang={lang} />
    </div>
  );
}
