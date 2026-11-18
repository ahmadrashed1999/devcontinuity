import { KillSwitch } from '@/components/dc/common';
import { ActivityLive } from '@/modules/org/ui';
import { PageHeader, Panel } from '@/components/dc/ui';
import { ensureDb, prisma } from '@/server/db';
import { fmtDate } from '@/lib/format';
import { getT } from '@/lib/server-i18n';

export const dynamic = 'force-dynamic';

export default async function ActivityPage() {
  await ensureDb();
  const { t } = await getT();
  const audit = await prisma().auditEvent.findMany({ orderBy: { at: 'desc' }, take: 150 });
  return (
    <div className="space-y-6">
      <PageHeader title={t.activity} subtitle="What every AI role is doing right now, updated live." actions={<KillSwitch big />} />
      <ActivityLive />
      <Panel title="Audit log (append-only)" bodyClass="p-0">
        <div className="max-h-[500px] overflow-auto">
          <table className="w-full text-xs">
            <tbody>
              {audit.map((a) => (
                <tr key={a.id} className="border-t border-border/60 first:border-0">
                  <td className="whitespace-nowrap p-2 text-muted-foreground">{fmtDate(a.at)}</td>
                  <td className="p-2 text-slate-300">{a.actor}</td>
                  <td className="p-2 font-mono text-cyan">{a.action}</td>
                  <td className="p-2 font-mono text-slate-500">{a.target}</td>
                  <td className="max-w-xl truncate p-2 text-slate-500" title={a.detail ?? ''}>{a.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}
