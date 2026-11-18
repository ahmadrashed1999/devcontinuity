import { PrismaClient } from '@prisma/client';
import { dataDir, dbUrl, ensureDir } from './config';

const g = globalThis as unknown as { __dcPrisma?: PrismaClient; __dcReady?: Promise<void> };

export const FTS_KINDS = ['user_message', 'assistant_message', 'thinking', 'tool_call', 'tool_result', 'summary', 'error'] as const;
export const FTS_KINDS_SQL = FTS_KINDS.map((k) => `'${k}'`).join(',');

export function prisma(): PrismaClient {
  if (!g.__dcPrisma) {
    ensureDir(dataDir());
    g.__dcPrisma = new PrismaClient({ datasources: { db: { url: dbUrl() } }, log: ['error'] });
  }
  return g.__dcPrisma;
}

/** Idempotent runtime setup: WAL mode, the FTS5 index, and cleanup of jobs orphaned by a restart. */
export function ensureDb(): Promise<void> {
  if (!g.__dcReady) {
    g.__dcReady = (async () => {
      const db = prisma();
      await db.$queryRawUnsafe('PRAGMA journal_mode=WAL');
      // Web server and orchestrator share the database: wait for locks instead of failing.
      await db.$queryRawUnsafe('PRAGMA busy_timeout=15000');
      const tables = await db.$queryRawUnsafe<{ name: string }[]>("SELECT name FROM sqlite_master WHERE type='table' AND name='Session'");
      if (tables.length === 0) {
        throw new Error('Database schema is missing. Run "npm run setup" (prisma migrate deploy) first.');
      }
      await db.$executeRawUnsafe(
        "CREATE VIRTUAL TABLE IF NOT EXISTS event_fts USING fts5(text, content='Event', content_rowid='id', tokenize='unicode61 remove_diacritics 2')",
      );
      await db.job.updateMany({
        where: { status: { in: ['running', 'queued'] } },
        data: { status: 'failed', error: 'Interrupted: the server process restarted while this job was running.', finishedAt: new Date() },
      });
    })().catch((e) => {
      g.__dcReady = undefined;
      throw e;
    });
  }
  return g.__dcReady;
}

export async function disconnectDb(): Promise<void> {
  if (g.__dcPrisma) await g.__dcPrisma.$disconnect();
  g.__dcPrisma = undefined;
  g.__dcReady = undefined;
}

/** Index a session's searchable events. Call after its events are inserted. */
export async function ftsIndexSession(sessionId: string): Promise<void> {
  await prisma().$executeRawUnsafe(
    `INSERT INTO event_fts(rowid, text) SELECT id, text FROM Event WHERE sessionId = ? AND text IS NOT NULL AND kind IN (${FTS_KINDS_SQL})`,
    sessionId,
  );
}

/** Remove a session's rows from the external-content FTS index. Must run before the events are deleted. */
export async function ftsRemoveSession(sessionId: string): Promise<void> {
  await prisma().$executeRawUnsafe(
    `INSERT INTO event_fts(event_fts, rowid, text) SELECT 'delete', id, text FROM Event WHERE sessionId = ? AND text IS NOT NULL AND kind IN (${FTS_KINDS_SQL})`,
    sessionId,
  );
}

export function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const row = await prisma().setting.findUnique({ where: { key } });
  return parseJson(row?.value, fallback);
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  const v = JSON.stringify(value);
  await prisma().setting.upsert({ where: { key }, create: { key, value: v }, update: { value: v } });
}
