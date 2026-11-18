import Link from 'next/link';
import { FilterBar, NewItemForm, Select } from '@/components/dc/actions';
import { Empty, PageHeader, Pill } from '@/components/dc/ui';
import { ensureDb, prisma } from '@/server/db';
import { fmtDate } from '@/lib/format';
import { getT } from '@/lib/server-i18n';

export const dynamic = 'force-dynamic';

const SOURCE_LABEL: Record<string, string> = { ai: 'AI-reported', manual: 'written by you', 'agent-memory': 'agent memory file', 'agent-plan': 'agent plan (intent)', transcript: 'transcript' };

export default async function KnowledgePage({ searchParams }: PageProps<'/knowledge'>) {
  await ensureDb();
  const { t } = await getT();
  const sp = await searchParams;
  const projectId = typeof sp.projectId === 'string' && sp.projectId ? sp.projectId : undefined;
  const kind = typeof sp.kind === 'string' && sp.kind ? sp.kind : undefined;
  const db = prisma();
  const [items, projects, docs] = await Promise.all([
    db.knowledgeItem.findMany({ where: { projectId, kind }, orderBy: [{ occurredAt: 'desc' }, { createdAt: 'desc' }], take: 200, include: { project: { select: { id: true, name: true } } } }),
    db.project.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true } }),
    db.knowledgeDoc.groupBy({ by: ['projectId'], _count: true }),
  ]);
  return (
    <div>
      <PageHeader title={t.knowledge} subtitle="Permanent project knowledge that is yours, independent of any AI subscription: decisions, issues, agent memory notes, plans, and the generated project documents." actions={<NewItemForm kind="knowledge" projects={projects} defaultProjectId={projectId} />} />
      <FilterBar>
        <Select name="projectId" value={projectId} label="Project" options={projects.map((p) => [p.id, p.name])} />
        <Select name="kind" value={kind} label="Kind" options={['decision', 'issue', 'memory', 'plan', 'summary', 'note'].map((k) => [k, k])} />
      </FilterBar>
      <div className="mb-6 flex flex-wrap gap-2 text-xs">
        <span className="text-muted-foreground">Generated documents:</span>
        {docs.map((d) => { const p = projects.find((x) => x.id === d.projectId); return p ? <Link key={d.projectId} href={`/projects/${p.id}?tab=docs`} className="rounded-md border border-border px-2 py-0.5 text-slate-300 hover:border-primary/50">{p.name} ({d._count})</Link> : null; })}
        {docs.length === 0 && <span className="text-muted-foreground">none yet. Open a project and choose “Regenerate knowledge docs”.</span>}
      </div>
      {items.length === 0 ? <Empty>No knowledge entries match.</Empty> : (
        <div className="grid gap-3 lg:grid-cols-2">
          {items.map((i) => (
            <details key={i.id} className="rounded-xl border border-border bg-card p-4">
              <summary className="cursor-pointer list-none">
                <div className="flex flex-wrap items-center gap-2">
                  <Pill className="border-border text-slate-300">{i.kind}</Pill>
                  <span className="font-medium text-slate-100">{i.title}</span>
                </div>
                <div className="mt-1 flex gap-3 text-[11px] text-muted-foreground">
                  <span>{SOURCE_LABEL[i.source] ?? i.source}</span>
                  <Link href={`/projects/${i.project.id}`} className="hover:text-slate-200">{i.project.name}</Link>
                  <span>{fmtDate(i.occurredAt ?? i.createdAt, false)}</span>
                  {i.sessionId && <Link href={`/sessions/${i.sessionId}`} className="text-primary">session</Link>}
                </div>
              </summary>
              <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap font-sans text-sm text-slate-300">{i.body}</pre>
            </details>
          ))}
        </div>
      )}
    </div>
  );
}
