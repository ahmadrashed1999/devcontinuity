import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ContinuePanel } from '@/components/dc/continue-panel';
import { AiAnalyzeButton } from '@/components/dc/panels';
import { LaunchButtons } from '@/components/dc/common';
import { SessionTimeline } from '@/components/dc/session-timeline';
import { AgentBadge, EndStatePill, KV, PageHeader, Panel, StatusPill, Tabs, VerifyTag } from '@/components/dc/ui';
import { ensureDb, parseJson, prisma } from '@/server/db';
import { fmtDate, fmtNum } from '@/lib/format';

export const dynamic = 'force-dynamic';

export default async function SessionPage({ params, searchParams }: PageProps<'/sessions/[id]'>) {
  await ensureDb();
  const { id } = await params;
  const sp = await searchParams;
  const tab = typeof sp.tab === 'string' ? sp.tab : 'timeline';
  const seq = typeof sp.seq === 'string' ? Number(sp.seq) : undefined;
  const db = prisma();
  const s = await db.session.findUnique({ where: { id }, include: { project: { select: { id: true, name: true } } } });
  if (!s) notFound();
  const meta = parseJson<Record<string, unknown>>(s.providerMeta, {});
  const [subagents, parent, tasks, files] = await Promise.all([
    db.session.findMany({ where: { agent: s.agent, parentExternalId: s.externalId, isSubagent: true }, select: { id: true, title: true, endState: true, eventCount: true } }),
    s.parentExternalId ? db.session.findFirst({ where: { agent: s.agent, externalId: s.parentExternalId, isSubagent: false }, select: { id: true, title: true } }) : null,
    db.task.findMany({ where: { sessionId: id }, orderBy: { sourceEventSeq: 'asc' } }),
    db.fileOp.groupBy({ by: ['path', 'op'], where: { sessionId: id }, _count: true, _max: { timestamp: true } }),
  ]);
  const base = `/sessions/${id}`;
  const exp = (f: string) => `/api/sessions/${id}/export?format=${f}`;
  return (
    <div>
      <PageHeader
        title={s.title ?? s.externalId}
        subtitle={<span className="flex flex-wrap items-center gap-x-3 gap-y-1.5"><AgentBadge agent={s.agent} href={`/sessions?agent=${encodeURIComponent(s.agent)}`} />{s.project && <Link href={`/projects/${s.project.id}`} className="text-slate-300 hover:text-primary">{s.project.name}</Link>}<EndStatePill state={s.endState} /><span className="tabular-nums">{fmtDate(s.startedAt)} → {fmtDate(s.endedAt)}</span></span>}
        actions={<>
          <Link href={`${base}?tab=continue`} className="inline-flex h-8 items-center rounded-lg bg-gradient-to-r from-primary to-cyan px-3 text-sm font-semibold text-white">Continue this session</Link>
          <AiAnalyzeButton kind="session" id={id} label="Summarize" />
          <span className="inline-flex h-8 items-center overflow-hidden rounded-lg border border-border text-xs text-slate-300" aria-label="Export">
            <span className="px-2 text-muted-foreground">Export</span>
            {(['markdown', 'json', 'jsonl'] as const).map((f) => <a key={f} href={exp(f)} className="flex h-full items-center border-s border-border px-2 hover:bg-secondary">{f === 'markdown' ? 'MD' : f.toUpperCase()}</a>)}
          </span>
        </>}
      />
      <div className="mb-4"><LaunchButtons sessionId={id} projectId={s.projectId ?? undefined} resumeClaude={s.agent === 'claude-code' && !s.isSubagent} /></div>
      <Tabs base={base} active={tab} tabs={[{ id: 'timeline', label: 'Timeline', count: s.eventCount }, { id: 'continue', label: 'Continue' }, { id: 'details', label: 'Details' }, { id: 'tasks', label: 'Tasks', count: tasks.length }, { id: 'files', label: 'Files', count: files.length }]} />
      {tab === 'timeline' && (
        <div className="grid gap-4 xl:grid-cols-[1fr_300px]">
          <SessionTimeline sessionId={id} initialSeq={seq} />
          <div className="space-y-3">
            <Panel title="How it ended"><div className="text-sm text-slate-300">{s.endStateDetail}</div></Panel>
            {s.summary && <Panel title="AI summary (AI-reported)"><div className="whitespace-pre-wrap text-sm text-slate-300">{s.summary}</div></Panel>}
            {parent && <Panel title="Parent session"><Link href={`/sessions/${parent.id}`} className="text-sm text-primary">{parent.title ?? parent.id}</Link></Panel>}
            {subagents.length > 0 && <Panel title={`Subagents (${subagents.length})`}><ul className="space-y-1 text-sm">{subagents.map((x) => <li key={x.id}><Link href={`/sessions/${x.id}`} className="text-slate-300 hover:text-primary">{x.title ?? x.id}</Link> <span className="text-[11px] text-muted-foreground">{x.eventCount} events</span></li>)}</ul></Panel>}
          </div>
        </div>
      )}
      {tab === 'continue' && <Panel title="Continue exactly where this session stopped"><p className="mb-4 text-sm text-muted-foreground">The briefing focuses on this session: its last request, last response, files it changed and errors after the last request, plus the project&apos;s current Git state.</p><ContinuePanel sessionId={id} projectId={s.projectId ?? undefined} initialAgent={typeof sp.agent === 'string' ? sp.agent : undefined} /></Panel>}
      {tab === 'details' && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Panel title="Session"><KV items={[['Session id', <span key="a" className="font-mono text-xs">{s.externalId}</span>], ['Working directory', s.cwd], ['Worktree', s.worktree], ['Branch', s.gitBranch], ['Models', parseJson<string[]>(s.models, []).join(', ')], ['Agent version', s.agentVersion], ['Events', fmtNum(s.eventCount)], ['User prompts', s.userMessageCount], ['Assistant messages', s.assistantMessageCount], ['Tool calls', `${s.toolCallCount} (${s.toolErrorCount} errors)`], ['Commands', s.commandCount], ['File operations', s.fileOpCount], ['Malformed lines', s.malformedLines], ['Unknown records', s.unknownRecordCount]]} /></Panel>
          <Panel title="Source & integrity"><KV items={[['Original file (read-only)', <span key="b" className="break-all font-mono text-xs">{s.sourcePath}</span>], ['Archive copy', <span key="c" className="break-all font-mono text-xs">{s.archivePath}</span>], ['SHA-256', <span key="d" className="break-all font-mono text-xs">{s.sha256 ?? '—'}</span>], ['Size', fmtNum(s.sourceSize)], ['Imported', fmtDate(s.importedAt)]]} /></Panel>
          <Panel title="Provider metadata" className="lg:col-span-2"><pre className="max-h-96 overflow-auto font-mono text-[11px] text-slate-400">{JSON.stringify(meta, null, 2)}</pre></Panel>
        </div>
      )}
      {tab === 'tasks' && (
        <div className="space-y-2">
          {tasks.map((t) => (
            <div key={t.id} className="rounded-lg border border-border bg-card p-3">
              <div className="flex items-center gap-2"><StatusPill status={t.status} /><span className="text-sm text-slate-200">{t.title}</span><span className="ms-auto"><VerifyTag v={t.verification} /></span></div>
              <ul className="mt-2 space-y-0.5 text-xs text-muted-foreground">{parseJson<{ type: string; detail: string }[]>(t.evidence, []).map((e, i) => <li key={i}>· <span className="text-slate-400">{e.type.replace(/_/g, ' ')}:</span> {e.detail}</li>)}</ul>
            </div>
          ))}
          {tasks.length === 0 && <div className="text-sm text-muted-foreground">No tasks derived from this session.</div>}
        </div>
      )}
      {tab === 'files' && (
        <div className="overflow-hidden rounded-xl border border-border">
          <table className="w-full text-sm"><tbody>{files.sort((a, b) => (b._max.timestamp?.getTime() ?? 0) - (a._max.timestamp?.getTime() ?? 0)).map((f) => <tr key={f.path + f.op} className="border-t border-border first:border-0"><td className="p-2 text-xs text-cyan">{f.op}</td><td className="p-2 font-mono text-xs text-slate-300">{f.path}</td><td className="p-2 text-end text-xs text-muted-foreground">{f._count}×</td><td className="p-2 text-end text-xs text-muted-foreground">{fmtDate(f._max.timestamp)}</td></tr>)}</tbody></table>
        </div>
      )}
    </div>
  );
}
