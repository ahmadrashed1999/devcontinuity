import crypto from 'node:crypto';
import { prisma } from './db';

const owner = `${process.pid}-${crypto.randomBytes(4).toString('hex')}`;

/** Cross-process lease lock stored in SQLite (web server and orchestrator share the database). */
export async function withLock<T>(name: string, ttlMs: number, fn: () => Promise<T>): Promise<T | { locked: true; holder: string }> {
  const key = `lock:${name}`;
  const db = prisma();
  const now = Date.now();
  const acquired = await db.$transaction(async (tx) => {
    const row = await tx.setting.findUnique({ where: { key } });
    if (row) {
      const v = JSON.parse(row.value) as { owner: string; until: number };
      if (v.until > now && v.owner !== owner) return v.owner;
    }
    const value = JSON.stringify({ owner, until: now + ttlMs });
    await tx.setting.upsert({ where: { key }, create: { key, value }, update: { value } });
    return null;
  });
  if (acquired) return { locked: true, holder: acquired };
  try {
    return await fn();
  } finally {
    await db.setting.deleteMany({ where: { key, value: { contains: owner } } }).catch(() => undefined);
  }
}

export function isLocked(r: unknown): r is { locked: true; holder: string } {
  return !!r && typeof r === 'object' && (r as { locked?: boolean }).locked === true;
}
