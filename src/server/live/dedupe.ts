import { ftsRemoveSession, prisma } from '../db';

/**
 * An agent may be captured twice: from its own transcript file and from hooks/telemetry. The
 * transcript is richer, so once it is imported the live copy is dropped from the database. The
 * live original stays in data/live and its usage numbers are kept on the transcript session.
 * Returns how many live sessions were removed.
 */
export async function pruneLiveDuplicates(): Promise<number> {
  const db = prisma();
  const live = await db.session.findMany({ where: { sourceKey: { startsWith: 'live:' } }, select: { id: true, agent: true, externalId: true, providerMeta: true } });
  if (live.length === 0) return 0;
  let removed = 0;
  for (const l of live) {
    const twin = await db.session.findFirst({ where: { agent: l.agent, externalId: l.externalId, NOT: { sourceKey: { startsWith: 'live:' } } }, select: { id: true, providerMeta: true } });
    if (!twin) continue;
    try {
      const liveMeta = JSON.parse(l.providerMeta ?? '{}') as { usage?: unknown };
      if (liveMeta.usage) {
        const meta = JSON.parse(twin.providerMeta ?? '{}') as Record<string, unknown>;
        meta.liveUsage = liveMeta.usage;
        await db.session.update({ where: { id: twin.id }, data: { providerMeta: JSON.stringify(meta) } });
      }
    } catch {
      /* keep going: metadata is best effort */
    }
    await ftsRemoveSession(l.id);
    await db.task.deleteMany({ where: { sessionId: l.id } });
    await db.session.delete({ where: { id: l.id } });
    removed++;
  }
  return removed;
}
