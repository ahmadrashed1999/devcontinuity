import { ImportCenter } from '@/components/dc/import-center';
import { PageHeader } from '@/components/dc/ui';
import { ensureDb, prisma } from '@/server/db';
import { fmtDate } from '@/lib/format';
import { getT } from '@/lib/server-i18n';

export const dynamic = 'force-dynamic';

export default async function ImportPage() {
  await ensureDb();
  const { t } = await getT();
  const [projects, jobs] = await Promise.all([
    prisma().project.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true } }),
    prisma().job.findMany({ where: { type: 'import' }, orderBy: { createdAt: 'desc' }, take: 8 }),
  ]);
  return (
    <div>
      <PageHeader title={t.import} subtitle="Recovery inventory of every agent data directory found on this machine. Review it, then import safe copies." />
      <ImportCenter projects={projects} />
      {jobs.length > 0 && (
        <div className="mt-8">
          <h2 className="mb-2 text-sm font-semibold text-slate-300">Import history</h2>
          <div className="overflow-hidden rounded-xl border border-border">
            <table className="w-full text-xs">
              <tbody>
                {jobs.map((j) => (
                  <tr key={j.id} className="border-t border-border first:border-0">
                    <td className="p-2 text-muted-foreground">{fmtDate(j.createdAt)}</td>
                    <td className={`p-2 ${j.status === 'completed' ? 'text-success' : j.status === 'failed' ? 'text-danger' : 'text-slate-300'}`}>{j.status}</td>
                    <td className="p-2 text-slate-400">{j.error ?? j.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
