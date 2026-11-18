import fs from 'node:fs';
import path from 'node:path';
import { dataDir, dataPath, dbPath, ensureDir, timestampSlug } from '../config';
import { disconnectDb, ensureDb, prisma } from '../db';
import { PathError, assertInsideData, isInside } from '../security/paths';
import { createZip, extractZipSafely, type ZipSource } from '../zip';

/** Consistent snapshot of the live database (VACUUM INTO works while the app is running). */
async function snapshotDb(target: string) {
  assertInsideData(target);
  if (fs.existsSync(target)) throw new PathError(`${target} already exists.`);
  await prisma().$executeRawUnsafe(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
}

export async function createBackup(opts: { includeArchives?: boolean; note?: string; kind?: string } = {}) {
  await ensureDb();
  const stamp = timestampSlug();
  const dir = ensureDir(dataPath('backups'));
  const tmp = ensureDir(dataPath('tmp', `backup-${stamp}`));
  const snap = path.join(tmp, 'devcontinuity.db');
  await snapshotDb(snap);
  const sources: ZipSource[] = [
    { name: 'devcontinuity.db', file: snap },
    { name: 'BACKUP_INFO.json', content: JSON.stringify({ createdAt: new Date().toISOString(), note: opts.note ?? null, includesArchives: !!opts.includeArchives }, null, 2) },
  ];
  for (const sub of ['knowledge', 'handoffs'] as const) if (fs.existsSync(dataPath(sub))) sources.push({ name: sub, dir: dataPath(sub) });
  if (opts.includeArchives && fs.existsSync(dataPath('archives'))) sources.push({ name: 'archives', dir: dataPath('archives') });
  const file = path.join(dir, `devcontinuity-backup-${stamp}${opts.includeArchives ? '-full' : ''}.zip`);
  const { bytes } = await createZip(file, sources);
  fs.rmSync(tmp, { recursive: true, force: true });
  return prisma().backup.create({ data: { filePath: file, sizeMb: bytes / 1024 / 1024, kind: opts.kind ?? 'manual', note: opts.note, includesArchives: !!opts.includeArchives } });
}

/**
 * Restores a backup. Before anything is replaced, the current database is moved (not deleted)
 * into data/pre-restore/<timestamp>/, so a restore can always be undone. Knowledge, handoff and
 * archive files are merged in without overwriting existing files.
 */
export async function restoreBackup(file: string) {
  const resolved = path.resolve(file);
  if (!isInside(resolved, dataPath('backups')) && !isInside(resolved, dataPath('uploads'))) throw new PathError('Backups can only be restored from the DevContinuity backups or uploads folder.');
  const stamp = timestampSlug();
  const staging = ensureDir(dataPath('tmp', `restore-${stamp}`));
  await extractZipSafely(resolved, staging, { accept: (n) => n === 'devcontinuity.db' || n === 'BACKUP_INFO.json' || /^(knowledge|handoffs|archives)\//.test(n) });
  const restoredDb = path.join(staging, 'devcontinuity.db');
  if (!fs.existsSync(restoredDb)) throw new PathError('This archive does not contain a DevContinuity database.');

  const keep = ensureDir(dataPath('pre-restore', stamp));
  await disconnectDb();
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const f = dbPath() + suffix;
    if (fs.existsSync(f)) fs.renameSync(f, path.join(keep, path.basename(f)));
  }
  fs.copyFileSync(restoredDb, dbPath());
  for (const sub of ['knowledge', 'handoffs', 'archives']) {
    const from = path.join(staging, sub);
    if (fs.existsSync(from)) fs.cpSync(from, path.join(dataDir(), sub), { recursive: true, force: false, errorOnExist: false });
  }
  fs.rmSync(staging, { recursive: true, force: true });
  await ensureDb();
  // The restored database may not know about this backup file; re-register the existing ones.
  for (const name of fs.readdirSync(dataPath('backups'))) {
    const p = path.join(dataPath('backups'), name);
    if (name.endsWith('.zip') && !(await prisma().backup.findFirst({ where: { filePath: p } }))) await prisma().backup.create({ data: { filePath: p, sizeMb: fs.statSync(p).size / 1024 / 1024, kind: 'discovered', includesArchives: name.includes('-full') } });
  }
  return { restoredFrom: resolved, previousDatabaseKeptIn: keep };
}
