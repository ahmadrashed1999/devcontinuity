import Link from 'next/link';
import { DecisionCard, type Decision } from '@/components/dc/org-ui';
import { Empty, PageHeader } from '@/components/dc/ui';
import { ensureDb, prisma } from '@/server/db';
import { getT } from '@/lib/server-i18n';

export const dynamic = 'force-dynamic';

export default async function DecisionsPage({ searchParams }: PageProps<'/owner/decisions'>) {
  await ensureDb();
  const { t } = await getT();
  const sp = await searchParams;
  const status = sp.status === 'answered' ? 'answered' : 'pending';
  const rows = await prisma().decisionRequest.findMany({ where: { status }, orderBy: { createdAt: 'desc' }, take: 100 });
  return (
    <div className="space-y-4">
      <PageHeader title={t.decisions} subtitle="Plans, merges, deliverables and anything that needs the owner. Nothing important happens until you answer." actions={<><Link href="/owner/decisions" className={`rounded-lg border px-3 py-1.5 text-sm ${status === 'pending' ? 'border-primary bg-primary/15' : 'border-border'}`}>Pending</Link><Link href="/owner/decisions?status=answered" className={`rounded-lg border px-3 py-1.5 text-sm ${status === 'answered' ? 'border-primary bg-primary/15' : 'border-border'}`}>History</Link></>} />
      {rows.length === 0 && <Empty>{status === 'pending' ? 'Nothing is waiting for your decision.' : 'No answered decisions yet.'}</Empty>}
      {rows.map((d) => <DecisionCard key={d.id} d={{ ...d, createdAt: d.createdAt.toISOString() } as unknown as Decision} />)}
    </div>
  );
}
