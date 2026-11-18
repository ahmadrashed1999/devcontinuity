import { ensureDb, prisma } from './db';

export interface SearchHit {
  eventId: number;
  sessionId: string;
  seq: number;
  kind: string;
  toolName: string | null;
  timestamp: string | null;
  snippet: string;
  sessionTitle: string | null;
  agent: string;
  projectId: string | null;
  projectName: string | null;
}

/** Turns free text into a safe FTS5 query: each term is quoted (so user input can never be parsed as FTS syntax) and prefix-matched. */
export function toFtsQuery(input: string): string {
  const terms = input
    .replace(/["'`*^():{}[\]<>]/g, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .slice(0, 12);
  return terms.map((t) => `"${t}"*`).join(' ');
}

export function asIso(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'bigint') return new Date(Number(v)).toISOString();
  if (typeof v === 'number') return new Date(v).toISOString();
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export async function searchEvents(q: string, opts: { projectId?: string; agent?: string; kinds?: string[]; sessionId?: string; limit?: number; offset?: number } = {}): Promise<{ hits: SearchHit[]; total: number; query: string }> {
  await ensureDb();
  const fts = toFtsQuery(q);
  if (!fts) return { hits: [], total: 0, query: fts };
  const where: string[] = ['event_fts MATCH ?'];
  const params: unknown[] = [fts];
  if (opts.projectId) {
    where.push('s.projectId = ?');
    params.push(opts.projectId);
  }
  if (opts.sessionId) {
    where.push('e.sessionId = ?');
    params.push(opts.sessionId);
  }
  if (opts.agent) {
    where.push('s.agent = ?');
    params.push(opts.agent);
  }
  const kinds = (opts.kinds ?? []).filter((k) => /^[a-z_]+$/.test(k));
  if (kinds.length) where.push(`e.kind IN (${kinds.map((k) => `'${k}'`).join(',')})`);
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  const from = 'FROM event_fts JOIN Event e ON e.id = event_fts.rowid JOIN Session s ON s.id = e.sessionId LEFT JOIN Project p ON p.id = s.projectId';
  const db = prisma();
  const rows = await db.$queryRawUnsafe<Record<string, unknown>[]>(
    `SELECT e.id AS eventId, e.sessionId, e.seq, e.kind, e.toolName, e.timestamp, snippet(event_fts, 0, '[[', ']]', ' … ', 28) AS snippet, s.title AS sessionTitle, s.agent, s.projectId, p.name AS projectName ${from} WHERE ${where.join(' AND ')} ORDER BY rank LIMIT ${limit} OFFSET ${offset}`,
    ...params,
  );
  const count = await db.$queryRawUnsafe<{ c: bigint | number }[]>(`SELECT count(*) AS c FROM (SELECT 1 ${from} WHERE ${where.join(' AND ')} LIMIT 5000)`, ...params);
  return {
    query: fts,
    total: Number(count[0]?.c ?? 0),
    hits: rows.map((r) => ({
      eventId: Number(r.eventId),
      sessionId: String(r.sessionId),
      seq: Number(r.seq),
      kind: String(r.kind),
      toolName: (r.toolName as string) ?? null,
      timestamp: asIso(r.timestamp),
      snippet: String(r.snippet ?? ''),
      sessionTitle: (r.sessionTitle as string) ?? null,
      agent: String(r.agent),
      projectId: (r.projectId as string) ?? null,
      projectName: (r.projectName as string) ?? null,
    })),
  };
}

/** Global search: transcript content (FTS) plus projects, sessions and tasks by name. */
export async function globalSearch(q: string, opts: { projectId?: string; agent?: string; kinds?: string[]; limit?: number; offset?: number } = {}) {
  const term = q.trim();
  if (!term) return { events: { hits: [], total: 0, query: '' }, projects: [], sessions: [], tasks: [], knowledge: [] };
  const db = prisma();
  const [events, projects, sessions, tasks, knowledge] = await Promise.all([
    searchEvents(term, opts),
    db.project.findMany({ where: { OR: [{ name: { contains: term } }, { rootPath: { contains: term } }] }, take: 10, select: { id: true, name: true, rootPath: true, slug: true } }),
    db.session.findMany({ where: { projectId: opts.projectId, OR: [{ title: { contains: term } }, { externalId: { contains: term } }] }, take: 15, orderBy: { endedAt: 'desc' }, select: { id: true, title: true, agent: true, endedAt: true, projectId: true } }),
    db.task.findMany({ where: { projectId: opts.projectId, OR: [{ title: { contains: term } }, { description: { contains: term } }] }, take: 15, orderBy: { occurredAt: 'desc' }, select: { id: true, title: true, status: true, projectId: true, sessionId: true } }),
    db.knowledgeItem.findMany({ where: { projectId: opts.projectId, OR: [{ title: { contains: term } }, { body: { contains: term } }] }, take: 10, select: { id: true, title: true, kind: true, projectId: true } }),
  ]);
  return { events, projects, sessions, tasks, knowledge };
}
