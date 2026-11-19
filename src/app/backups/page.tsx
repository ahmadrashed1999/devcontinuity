import fs from 'node:fs';
import path from 'node:path';
import { BackupPanel } from '@/components/dc/panels';
import { CloudBackupPanel } from '@/components/dc/tools-ui';
import { PageHeader } from '@/components/dc/ui';
import { dataDir } from '@/server/config';
import { ensureDb, prisma } from '@/server/db';
import { getT } from '@/lib/server-i18n';

export const dynamic = 'force-dynamic';

export default async function BackupsPage() {
  await ensureDb();
  const { t } = await getT();
  const rows = await prisma().backup.findMany({ orderBy: { createdAt: 'desc' } });
  return (
    <div>
      <PageHeader title={t.backups} subtitle={t.backupsSubtitle.replace('{dir}', path.join(dataDir(), 'backups'))} />
      <BackupPanel backups={rows.map((b) => ({ id: b.id, filePath: b.filePath, sizeMb: b.sizeMb, kind: b.kind, note: b.note, includesArchives: b.includesArchives, createdAt: b.createdAt.toISOString(), exists: fs.existsSync(b.filePath) }))} />
      <div className="mt-6"><CloudBackupPanel /></div>
    </div>
  );
}
