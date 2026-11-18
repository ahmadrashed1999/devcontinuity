import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { dataPath, ensureDir } from '../config';

/**
 * Opens a private working copy of someone else's SQLite database. The original (and our
 * pristine archive copy) is never opened directly, so WAL recovery or locking can never
 * touch it. The copy includes the -wal/-shm companions so recent, un-checkpointed data is visible.
 */
export function openWorkingCopy(dbFile: string): { db: DatabaseSync; dispose: () => void } {
  const dir = fs.mkdtempSync(path.join(ensureDir(dataPath('tmp')), 'sqlite-'));
  const target = path.join(dir, path.basename(dbFile));
  fs.copyFileSync(dbFile, target);
  for (const suffix of ['-wal', '-shm']) {
    if (fs.existsSync(dbFile + suffix)) fs.copyFileSync(dbFile + suffix, target + suffix);
  }
  const db = new DatabaseSync(target);
  return {
    db,
    dispose: () => {
      try {
        db.close();
      } catch {
        /* already closed */
      }
      // Only ever removes the temp directory this function created inside data/tmp.
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function sqliteCompanions(dbFile: string): string[] {
  return ['-wal', '-shm'].map((s) => dbFile + s).filter((f) => fs.existsSync(f));
}

export function hasTable(db: DatabaseSync, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(name);
}

// Working copies cached per archive path for the duration of one import run.
const cached = new Map<string, { db: DatabaseSync; dispose: () => void }>();

export function cachedWorkingCopy(dbFile: string): DatabaseSync {
  let w = cached.get(dbFile);
  if (!w) {
    w = openWorkingCopy(dbFile);
    cached.set(dbFile, w);
  }
  return w.db;
}

export function disposeWorkingCopies(): void {
  for (const w of cached.values()) w.dispose();
  cached.clear();
}
