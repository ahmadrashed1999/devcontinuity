import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ActionButton, NewItemForm, TaskStatusControl } from '@/components/dc/actions';
import { ContinuePanel } from '@/components/dc/continue-panel';
import { AiAnalyzeButton, ChangedFiles, DocViewer } from '@/components/dc/panels';
import { LaunchButtons } from '@/components/dc/common';
import { GithubPanel, RulesEditor, VerifyPanel, WorktreeList } from '@/components/dc/tools-ui';
import { EndStatePill, Empty, KV, PageHeader, Panel, Pill, StatusPill, Tabs, VerifyTag } from '@/components/dc/ui';
import { ensureDb, prisma } from '@/server/db';
import { getGitState } from '@/server/git/git';
import { inspectRepository } from '@/server/intelligence/repo';
import { AGENT_COLORS, ago, fmtDate, label, agentName } from '@/lib/format';

export const dynamic = 'force-dynamic';

export default async function ProjectPage({ params, searchParams }: PageProps<'/projects/[id]'>) {
  await ensureDb();
  const { id } = await params;
  const sp = await searchParams;
  const tab = typeof sp.tab === 'string' ? sp.tab : 'overview';
  const db = prisma();
  const p = await db.project.findUnique({ where: { id }, include: { _count: { select: { sessions: true, tasks: true, items: true, handoffs: true } } } });
  if (!p) notFound();
  const base = `/projects/${id}`;
  const taskGroups = await db.task.groupBy({ by: ['status'], where: { projectId: id }, _count: true });
  const tc = Object.fromEntries(taskGroups.map((g) => [g.status, g._count]));

  return (
    <div>
      <PageHeader
        title={p.name}
        subtitle={<span className="font-mono text-xs">{p.rootPath}{p.pathVerified ? (p.pathExists ? '' : ' · folder missing on this machine') : ' · path not verified'}</span>}
        actions={<><AiAnalyzeButton kind="project" id={id} label="AI project analysis" /><ActionButton path={`projects/${id}/docs`}>Regenerate knowledge docs</ActionButton><Link href={`${base}?tab=continue`} className="inline-flex h-8 items-center rounded-lg bg-gradient-to-r from-primary to-cyan px-3 text-sm font-semibold text-white">Continue with another agent</Link></>}
      />
      <Tabs base={base} active={tab} tabs={[{ id: 'overview', label: 'Overview' }, { id: 'continue', label: 'Continue' }, { id: 'sessions', label: 'Sessions', count: p._count.sessions }, { id: 'tasks', label: 'Tasks', count: p._count.tasks }, { id: 'docs', label: 'Knowledge docs' }, { id: 'git', label: 'Git' }, { id: 'worktrees', label: 'Worktrees' }, { id: 'verify', label: 'Verify' }, { id: 'rules', label: 'Agent rules' }, { id: 'github', label: 'GitHub' }]} />
      <div className="mb-4"><LaunchButtons projectId={id} /></div>

      {tab === 'overview' && <Overview id={id} tc={tc} />}
      {tab === 'continue' && (
        <Panel title="Continue this project with any AI agent">
          <p className="mb-4 text-sm text-muted-foreground">Pick the agent you will use next. DevContinuity rebuilds the working context (last request, unfinished tasks, changed files, errors, Git state) from the transcripts and the repository. Paste the prompt into the agent, download the full package, or drop it into the project folder.</p>
          <ContinuePanel projectId={id} />
        </Panel>
      )}
      {tab === 'sessions' && <SessionsTab id={id} />}
      {tab === 'tasks' && <TasksTab id={id} name={p.name} />}
      {tab === 'docs' && <DocsTab id={id} />}
      {tab === 'git' && <GitTab id={id} root={p.pathVerified ? p.rootPath : null} />}
      {tab === 'worktrees' && <WorktreeList projectId={id} />}
      {tab === 'verify' && <VerifyPanel projectId={id} tasks={await prisma().task.findMany({ where: { projectId: id, status: 'requires_verification' }, orderBy: [{ triage: 'asc' }, { occurredAt: 'desc' }], take: 400, select: { id: true, title: true, triage: true, triageReason: true } })} />}
      {tab === 'rules' && <RulesEditor projectId={id} />}
      {tab === 'github' && <GithubPanel projectId={id} />}
    </div>
  );
}

async function Overview({ id, tc }: { id: string; tc: Record<string, number> }) {
  const db = prisma();
  const p = (await db.project.findUnique({ where: { id } }))!;
  const repo = p.pathVerified ? inspectRepository(p.rootPath) : null;
  const [latest, agents, items, plans] = await Promise.all([
    db.session.findFirst({ where: { projectId: id, isSubagent: false, endState: { not: 'empty' } }, orderBy: { endedAt: 'desc' } }),
    db.session.groupBy({ by: ['agent'], where: { projectId: id }, _count: true }),
    db.knowledgeItem.findMany({ where: { projectId: id, kind: { in: ['decision', 'issue', 'summary'] } }, orderBy: { createdAt: 'desc' }, take: 8 }),
    db.knowledgeItem.count({ where: { projectId: id, kind: 'plan' } }),
  ]);
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Panel title="Project">
        <KV items={[
          ['Repository', p.rootPath],
          ['Folder', p.pathVerified ? (repo?.exists ? 'exists (verified)' : 'missing on this machine') : 'unknown: only an encoded folder name was recorded'],
          ['Stack', repo?.stack.length ? repo.stack.map((s) => s.name).join(', ') : '—'],
          ['Agents', agents.map((a) => `${agentName(a.agent)} (${a._count})`).join(', ')],
          ['Active', `${fmtDate(p.firstActivityAt, false)} → ${fmtDate(p.lastActivityAt, false)}`],
          ['Database', repo?.database.join('; ') || '—'],
          ['API', repo?.api.join('; ') || '—'],
          ['Tests', repo?.tests.join('; ') || '—'],
          ['Agent plans', String(plans)],
        ]} />
        {p.description && <div className="mt-4 rounded-lg border border-primary/20 bg-primary/5 p-3 text-sm text-slate-300"><div className="mb-1 text-xs text-indigo-300">AI overview (AI-reported)</div>{p.description}</div>}
      </Panel>
      <Panel title="Tasks">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {['in_progress', 'blocked', 'pending', 'requires_verification', 'completed', 'failed', 'cancelled'].map((s) => (
            <Link key={s} href={`/projects/${id}?tab=tasks&status=${s}`} className="rounded-lg bg-background/60 p-2.5 hover:bg-secondary/50">
              <StatusPill status={s} />
              <div className="mt-1 text-lg font-semibold tabular-nums text-slate-100">{tc[s] ?? 0}</div>
            </Link>
          ))}
        </div>
        <p className="mt-3 text-xs text-muted-foreground">Agent claims never mark a task completed. Only you can, after you check it.</p>
      </Panel>
      {latest && (
        <Panel title="Latest known state" actions={<Link href={`/sessions/${latest.id}`} className="text-xs text-primary">Open session</Link>}>
          <div className="mb-2 flex items-center gap-2"><span className="font-medium text-slate-100">{latest.title}</span><EndStatePill state={latest.endState} /></div>
          <div className="mb-3 text-xs text-muted-foreground">{agentName(latest.agent)} · {fmtDate(latest.endedAt)} · {latest.worktree ? `worktree ${latest.worktree} · ` : ''}branch {latest.gitBranch ?? '—'}</div>
          <div className="text-xs text-muted-foreground">{latest.endStateDetail}</div>
          {latest.lastUserPrompt && <div className="mt-3"><div className="text-xs text-indigo-300">Last user request</div><div className="line-clamp-6 whitespace-pre-wrap text-sm text-slate-300">{latest.lastUserPrompt}</div></div>}
          {latest.lastAssistantText && <div className="mt-3"><div className="text-xs text-cyan">Last assistant response (AI-reported)</div><div className="line-clamp-6 whitespace-pre-wrap text-sm text-slate-300">{latest.lastAssistantText}</div></div>}
        </Panel>
      )}
      <Panel title="Decisions, issues & summaries" actions={<Link href={`/knowledge?projectId=${id}`} className="text-xs text-primary">Knowledge base</Link>}>
        {items.length === 0 ? <div className="text-sm text-muted-foreground">None yet. Run AI analysis or add entries in the Knowledge Base.</div> : (
          <ul className="space-y-2">{items.map((i) => <li key={i.id} className="text-sm"><Pill className="me-2 border-border text-slate-400">{i.kind}</Pill><span className="text-slate-200">{i.title}</span><span className="ms-2 text-[11px] text-muted-foreground">{i.source}</span></li>)}</ul>
        )}
      </Panel>
    </div>
  );
}

async function SessionsTab({ id }: { id: string }) {
  const sessions = await prisma().session.findMany({ where: { projectId: id }, orderBy: { endedAt: 'desc' }, take: 300 });
  return (
    <div className="overflow-hidden rounded-xl border border-border">
      <table className="w-full text-sm">
        <thead className="bg-card text-xs text-muted-foreground"><tr><th className="p-2 text-start">Session</th><th className="p-2 text-start">Agent</th><th className="p-2 text-start">Worktree / branch</th><th className="p-2 text-start">Ended</th><th className="p-2 text-end">Prompts</th><th className="p-2 text-end">When</th></tr></thead>
        <tbody>
          {sessions.map((s) => (
            <tr key={s.id} className="border-t border-border hover:bg-secondary/30">
              <td className="p-2">{s.isSubagent && <span className="me-1 text-[10px] text-violet-300">subagent</span>}<Link href={`/sessions/${s.id}`} className="text-slate-100 hover:text-primary">{s.title ?? s.externalId}</Link></td>
              <td className={`p-2 text-xs ${AGENT_COLORS[s.agent]}`}>{agentName(s.agent)}</td>
              <td className="p-2 font-mono text-[11px] text-muted-foreground">{s.worktree ?? ''} {s.gitBranch ? `[${s.gitBranch}]` : ''}</td>
              <td className="p-2"><EndStatePill state={s.endState} /></td>
              <td className="p-2 text-end tabular-nums text-muted-foreground">{s.userMessageCount}</td>
              <td className="p-2 text-end text-xs text-muted-foreground">{ago(s.endedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

async function TasksTab({ id, name }: { id: string; name: string }) {
  const tasks = await prisma().task.findMany({ where: { projectId: id }, orderBy: [{ occurredAt: 'desc' }], take: 300 });
  const order = ['in_progress', 'blocked', 'failed', 'pending', 'requires_verification', 'completed', 'cancelled'];
  tasks.sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status));
  return (
    <div className="space-y-3">
      <NewItemForm kind="task" projects={[{ id, name }]} defaultProjectId={id} />
      {tasks.length === 0 ? <Empty>No tasks.</Empty> : (
        <div className="overflow-hidden rounded-xl border border-border">
          <table className="w-full text-sm">
            <tbody>
              {tasks.map((t) => (
                <tr key={t.id} className="border-t border-border first:border-0 align-top">
                  <td className="p-2"><StatusPill status={t.status} /></td>
                  <td className="p-2"><div className="text-slate-200">{t.title}</div><div className="text-[11px] text-muted-foreground">{label(t.source)} · {t.agent ?? 'manual'} · {fmtDate(t.occurredAt)} · <VerifyTag v={t.verification} /></div></td>
                  <td className="p-2 text-end">{t.sessionId && <Link href={`/sessions/${t.sessionId}${t.sourceEventSeq != null ? `?seq=${t.sourceEventSeq}` : ''}`} className="text-xs text-primary">source</Link>}</td>
                  <td className="p-2 text-end"><TaskStatusControl id={t.id} status={t.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

async function DocsTab({ id }: { id: string }) {
  const docs = await prisma().knowledgeDoc.findMany({ where: { projectId: id }, orderBy: { docType: 'asc' } });
  if (docs.length === 0) return <Empty action={<ActionButton path={`projects/${id}/docs`} variant="primary">Generate the 10 knowledge documents</ActionButton>}>PROJECT_OVERVIEW.md, ARCHITECTURE.md, CURRENT_STATE.md and the rest are generated from verified facts and labelled transcript evidence.</Empty>;
  return <DocViewer projectId={id} docs={docs.map((d) => ({ docType: d.docType, content: d.content, source: d.source, generatedAt: d.generatedAt.toISOString() }))} />;
}

async function GitTab({ id, root }: { id: string; root: string | null }) {
  if (!root) return <Empty>The project folder is not known, so Git cannot be inspected.</Empty>;
  const g = await getGitState(root);
  await prisma().project.update({ where: { id }, data: { gitState: JSON.stringify(g), gitCheckedAt: new Date(), isGitRepo: g.isRepo } });
  if (!g.isRepo) return <Empty>{g.error ?? 'Not a Git repository.'}</Empty>;
  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-3">
        <Panel title="Branch"><KV items={[['Branch', g.branch ?? '(detached)'], ['Upstream', g.upstream ? `${g.upstream} (↑${g.ahead} ↓${g.behind})` : 'none'], ['HEAD', g.head ? `${g.head.shortSha} ${g.head.subject}` : '—'], ['Captured', fmtDate(g.capturedAt)]]} /></Panel>
        <Panel title="Working tree"><KV items={[['Modified', g.counts.modified], ['Added', g.counts.added], ['Deleted', g.counts.deleted], ['Untracked', g.counts.untracked], ['Conflicted', g.counts.conflicted], ['Staged', g.counts.staged]]} /></Panel>
        <Panel title="Worktrees & remotes"><div className="space-y-1 font-mono text-[11px] text-muted-foreground">{g.worktrees.map((w) => <div key={w.path}>{w.path} {w.branch && `[${w.branch}]`}</div>)}{g.remotes.map((r) => <div key={r.name} className="text-slate-400">{r.name}: {r.url}</div>)}</div></Panel>
      </div>
      <Panel title={`Changed files (${g.counts.total})`}>{g.changes.length ? <ChangedFiles projectId={id} changes={g.changes} /> : <div className="text-sm text-muted-foreground">Working tree is clean.</div>}</Panel>
      <Panel title="Recent commits" bodyClass="p-0">
        <table className="w-full text-sm"><tbody>{g.recentCommits.map((c) => <tr key={c.sha} className="border-t border-border first:border-0"><td className="p-2 font-mono text-xs text-cyan">{c.shortSha}</td><td className="p-2 text-slate-200">{c.subject}</td><td className="p-2 text-xs text-muted-foreground">{c.author}</td><td className="p-2 text-end text-xs text-muted-foreground">{fmtDate(c.date)}</td></tr>)}</tbody></table>
      </Panel>
      <p className="text-xs text-muted-foreground">Read-only: DevContinuity only runs git status, log, diff, worktree list and remote -v. It never resets, cleans, checks out or pushes.</p>
    </div>
  );
}
