import Link from 'next/link';
import { FilterBar, NewItemForm, Select, TaskStatusControl, TextFilter } from '@/components/dc/actions';
import { PageHeader, Pager, StatusPill, VerifyTag, qs } from '@/components/dc/ui';
import { ensureDb, parseJson, prisma } from '@/server/db';
import { fmtDate, fmtNum, label } from '@/lib/format';
import { getT } from '@/lib/server-i18n';

export const dynamic = 'force-dynamic';
const LIMIT = 60;

export default async function TasksPage({ searchParams }: PageProps<'/tasks'>) {
  await ensureDb();
  const { t } = await getT();
  const sp = await searchParams;
  const s = (k: string) => (typeof sp[k] === 'string' && sp[k] ? (sp[k] as string) : undefined);
  const offset = Number(s('offset')) || 0;
  const where: Record<string, unknown> = {};
  for (const k of ['status', 'projectId', 'source', 'verification', 'priority', 'agent']) if (s(k)) where[k] = s(k);
  if (s('q')) where.OR = [{ title: { contains: s('q') } }, { description: { contains: s('q') } }];
  const db = prisma();
  const [rows, total, projects, groups] = await Promise.all([
    db.task.findMany({ where, orderBy: [{ occurredAt: 'desc' }, { createdAt: 'desc' }], take: LIMIT, skip: offset, include: { project: { select: { id: true, name: true } } } }),
    db.task.count({ where }),
    db.project.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true } }),
    db.task.groupBy({ by: ['status'], _count: true }),
  ]);
  const base = `/tasks${qs({ status: s('status'), projectId: s('projectId'), source: s('source'), verification: s('verification'), q: s('q') })}`;
  return (
    <div>
      <PageHeader title={t.tasks} subtitle={t.tasksSubtitle} actions={<NewItemForm kind="task" projects={projects} />} />
      <div className="mb-4 flex flex-wrap gap-2">
        {groups.map((g) => <Link key={g.status} href={`/tasks?status=${g.status}`} className="inline-flex items-center gap-1.5"><StatusPill status={g.status} /><span className="text-xs tabular-nums text-muted-foreground">{fmtNum(g._count)}</span></Link>)}
      </div>
      <FilterBar>
        <TextFilter name="q" value={s('q')} label={t.fSearch} />
        <Select name="status" value={s('status')} label={t.fStatus} options={['completed', 'in_progress', 'pending', 'blocked', 'failed', 'requires_verification', 'cancelled'].map((x) => [x, label(x)])} />
        <Select name="verification" value={s('verification')} label={t.fVerification} options={['verified', 'evidence_found', 'ai_reported', 'unverified', 'failed'].map((x) => [x, label(x)])} />
        <Select name="source" value={s('source')} label={t.fSource} options={[['user_request', t.srcUserRequest], ['agent_todo', t.srcAgentTodo], ['ai_extracted', t.srcAiExtracted], ['manual', t.srcManual]]} />
        <Select name="projectId" value={s('projectId')} label={t.fProject} options={projects.map((p) => [p.id, p.name])} />
      </FilterBar>
      <div className="space-y-2">
        {rows.map((task) => {
          const ev = parseJson<{ type: string; detail: string }[]>(task.evidence, []);
          const files = parseJson<string[]>(task.relatedFiles, []);
          return (
            <div key={task.id} className="rounded-xl border border-border bg-card p-3">
              <div className="flex flex-wrap items-start gap-2">
                <StatusPill status={task.status} />
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-slate-100">{task.title}</div>
                  <div className="mt-0.5 flex flex-wrap gap-x-3 text-[11px] text-muted-foreground">
                    {task.project && <Link href={`/projects/${task.project.id}`} className="hover:text-slate-200">{task.project.name}</Link>}
                    <span>{label(task.source)}</span><span>{task.agent ?? t.manualWord}</span><span>{t.priorityWord} {task.priority}</span><span>{fmtDate(task.occurredAt)}</span>
                    <VerifyTag v={task.verification} />
                    {task.aiReportedStatus && <span>{t.agentReported}: {task.aiReportedStatus}</span>}
                    {task.sessionId && <Link href={`/sessions/${task.sessionId}${task.sourceEventSeq != null ? `?seq=${task.sourceEventSeq}` : ''}`} className="text-primary">{t.sourceSession}</Link>}
                  </div>
                </div>
                <TaskStatusControl id={task.id} status={task.status} />
              </div>
              <details className="mt-2">
                <summary className="cursor-pointer text-[11px] text-slate-500">{t.evidenceWord} ({ev.length}){files.length ? ` · ${files.length} ${t.relatedFiles}` : ''}</summary>
                <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">{ev.map((e, i) => <li key={i}><span className="text-slate-400">{e.type.replace(/_/g, ' ')}:</span> {e.detail}</li>)}</ul>
                {files.length > 0 && <div className="mt-1 font-mono text-[11px] text-slate-500">{files.slice(0, 15).join(' · ')}</div>}
              </details>
            </div>
          );
        })}
      </div>
      <Pager total={total} offset={offset} limit={LIMIT} base={base} />
    </div>
  );
}
