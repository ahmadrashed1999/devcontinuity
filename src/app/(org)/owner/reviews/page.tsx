import { DecisionCard, type Decision } from '@/modules/org/ui';
import { Empty, PageHeader } from '@/components/dc/ui';
import { ensureDb, prisma } from '@/server/db';
import { getT } from '@/lib/server-i18n';

export const dynamic = 'force-dynamic';

export default async function ReviewsPage() {
  await ensureDb();
  const { t } = await getT();
  const rows = await prisma().decisionRequest.findMany({ where: { status: 'pending', kind: { in: ['merge', 'artifact', 'compare'] } }, orderBy: { createdAt: 'asc' } });
  return (
    <div className="space-y-4">
      <PageHeader title={t.reviews} subtitle="Finished work that passed the department head (and QA / security where relevant). Approve to merge or accept; nothing reaches your branches without you." />
      {rows.length === 0 && <Empty>No finished work is waiting for review.</Empty>}
      {rows.map((d) => <DecisionCard key={d.id} d={{ ...d, createdAt: d.createdAt.toISOString() } as unknown as Decision} showWork />)}
    </div>
  );
}
