import Link from 'next/link';
import { FilterBar, Select, TextFilter } from '@/components/dc/actions';
import { Empty, PageHeader, Pager, Panel, Pill, Snippet, StatusPill, qs } from '@/components/dc/ui';
import { ensureDb, prisma } from '@/server/db';
import { globalSearch } from '@/server/search';
import { AGENT_COLORS, fmtDate, fmtNum, agentName } from '@/lib/format';
import { getT } from '@/lib/server-i18n';

export const dynamic = 'force-dynamic';
const LIMIT = 40;

export default async function SearchPage({ searchParams }: PageProps<'/search'>) {
  await ensureDb();
  const { t } = await getT();
  const sp = await searchParams;
  const s = (k: string) => (typeof sp[k] === 'string' && sp[k] ? (sp[k] as string) : undefined);
  const q = s('q') ?? '';
  const offset = Number(s('offset')) || 0;
  const projects = await prisma().project.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true } });
  const r = q ? await globalSearch(q, { projectId: s('projectId'), agent: s('agent'), kinds: s('kind') ? [s('kind')!] : undefined, limit: LIMIT, offset }) : null;
  return (
    <div>
      <PageHeader title={t.search} subtitle="Full-text search over every recovered message, tool call, tool output and error, plus projects, sessions, tasks and knowledge." />
      <FilterBar>
        <TextFilter name="q" value={q} label="Search" placeholder="e.g. migration, webhook, TypeError" />
        <Select name="projectId" value={s('projectId')} label="Project" options={projects.map((p) => [p.id, p.name])} />
        <Select name="agent" value={s('agent')} label="Agent" options={(await prisma().session.groupBy({ by: ['agent'] })).map((a) => [a.agent, agentName(a.agent)])} />
        <Select name="kind" value={s('kind')} label="Type" options={[['user_message', 'User messages'], ['assistant_message', 'Assistant messages'], ['tool_call', 'Tool calls / commands'], ['tool_result', 'Tool output'], ['error', 'Errors'], ['thinking', 'Thinking']]} />
      </FilterBar>
      {!r ? <Empty>Type a query to search all sessions.</Empty> : (
        <div className="grid gap-4 xl:grid-cols-[1fr_320px]">
          <div>
            <div className="mb-2 text-sm text-muted-foreground">{fmtNum(r.events.total)}{r.events.total >= 5000 ? '+' : ''} transcript matches</div>
            <div className="space-y-2">
              {r.events.hits.map((h) => (
                <Link key={h.eventId} href={`/sessions/${h.sessionId}?seq=${h.seq}`} className="block rounded-xl border border-border bg-card p-3 hover:border-primary/50">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <Pill className="border-border text-slate-400">{h.kind.replace(/_/g, ' ')}{h.toolName ? ` · ${h.toolName}` : ''}</Pill>
                    <span className="text-slate-200">{h.sessionTitle ?? h.sessionId}</span>
                    <span className={AGENT_COLORS[h.agent]}>{agentName(h.agent)}</span>
                    <span className="text-muted-foreground">{h.projectName}</span>
                    <span className="ms-auto text-slate-500">{fmtDate(h.timestamp)}</span>
                  </div>
                  <div className="mt-1.5 line-clamp-4 whitespace-pre-wrap break-words text-sm text-slate-300"><Snippet text={h.snippet} /></div>
                </Link>
              ))}
            </div>
            <Pager total={Math.min(r.events.total, 5000)} offset={offset} limit={LIMIT} base={`/search${qs({ q, projectId: s('projectId'), agent: s('agent'), kind: s('kind') })}`} />
          </div>
          <div className="space-y-3">
            <Panel title={`Projects (${r.projects.length})`}>{r.projects.map((p) => <Link key={p.id} href={`/projects/${p.id}`} className="block truncate text-sm text-slate-200 hover:text-primary">{p.name}</Link>)}{r.projects.length === 0 && <span className="text-xs text-muted-foreground">none</span>}</Panel>
            <Panel title={`Sessions (${r.sessions.length})`}>{r.sessions.map((x) => <Link key={x.id} href={`/sessions/${x.id}`} className="block truncate text-sm text-slate-200 hover:text-primary">{x.title ?? x.id}</Link>)}{r.sessions.length === 0 && <span className="text-xs text-muted-foreground">none</span>}</Panel>
            <Panel title={`Tasks (${r.tasks.length})`}>{r.tasks.map((x) => <div key={x.id} className="flex items-center gap-2 py-0.5"><StatusPill status={x.status} /><span className="truncate text-sm text-slate-300">{x.title}</span></div>)}{r.tasks.length === 0 && <span className="text-xs text-muted-foreground">none</span>}</Panel>
            <Panel title={`Knowledge (${r.knowledge.length})`}>{r.knowledge.map((x) => <Link key={x.id} href={`/knowledge?projectId=${x.projectId}`} className="block truncate text-sm text-slate-300 hover:text-primary">{x.kind}: {x.title}</Link>)}{r.knowledge.length === 0 && <span className="text-xs text-muted-foreground">none</span>}</Panel>
          </div>
        </div>
      )}
    </div>
  );
}
