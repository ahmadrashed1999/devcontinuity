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
import { getT } from '@/lib/server-i18n';

export const dynamic = 'force-dynamic';

export default async function ProjectPage({ params, searchParams }: PageProps<'/projects/[id]'>) {
  await ensureDb();
  const { id } = await params;
  const { t } = await getT();
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
        subtitle={<span className="font-mono text-xs">{p.rootPath}{p.pathVerified ? (p.pathExists ? '' : ` · ${t.pFolderMissing}`) : ` · ${t.pPathUnverified}`}</span>}
        actions={<><AiAnalyzeButton kind="project" id={id} label={t.pAiAnalysis} /><ActionButton path={`projects/${id}/docs`}>{t.pRegenDocs}</ActionButton><Link href={`${base}?tab=continue`} className="inline-flex h-8 items-center rounded-lg bg-gradient-to-r from-primary to-cyan px-3 text-sm font-semibold text-white">{t.pContinueWith}</Link></>}
      />
      <Tabs base={base} active={tab} tabs={[{ id: 'overview', label: t.tabOverview }, { id: 'continue', label: t.tabContinue }, { id: 'sessions', label: t.tabSessions, count: p._count.sessions }, { id: 'tasks', label: t.tabTasks, count: p._count.tasks }, { id: 'docs', label: t.tabDocs }, { id: 'git', label: t.tabGit }, { id: 'worktrees', label: t.tabWorktrees }, { id: 'verify', label: t.tabVerify }, { id: 'rules', label: t.tabRules }, { id: 'github', label: t.tabGithub }]} />
      <div className="mb-4"><LaunchButtons projectId={id} /></div>

      {tab === 'overview' && <Overview id={id} tc={tc} />}
      {tab === 'continue' && (
        <Panel title={t.pContinueTitle}>
          <p className="mb-4 text-sm text-muted-foreground">{t.pContinueHelp}</p>
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
  const { t } = await getT();
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
      <Panel title={t.pProject}>
        <KV items={[
          [t.pRepository, p.rootPath],
          [t.pFolder, p.pathVerified ? (repo?.exists ? t.pFolderExists : t.pFolderGone) : t.pFolderUnknown],
          [t.pStack, repo?.stack.length ? repo.stack.map((s) => s.name).join(', ') : '—'],
          [t.pAgents, agents.map((a) => `${agentName(a.agent)} (${a._count})`).join(', ')],
          [t.pActive, `${fmtDate(p.firstActivityAt, false)} → ${fmtDate(p.lastActivityAt, false)}`],
          [t.pDatabase, repo?.database.join('; ') || '—'],
          [t.pApi, repo?.api.join('; ') || '—'],
          [t.pTests, repo?.tests.join('; ') || '—'],
          [t.pPlans, String(plans)],
        ]} />
        {p.description && <div className="mt-4 rounded-lg border border-primary/20 bg-primary/5 p-3 text-sm text-slate-300"><div className="mb-1 text-xs text-indigo-300">{t.pAiOverview}</div>{p.description}</div>}
      </Panel>
      <Panel title={t.tabTasks}>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {['in_progress', 'blocked', 'pending', 'requires_verification', 'completed', 'failed', 'cancelled'].map((s) => (
            <Link key={s} href={`/projects/${id}?tab=tasks&status=${s}`} className="rounded-lg bg-background/60 p-2.5 hover:bg-secondary/50">
              <StatusPill status={s} />
              <div className="mt-1 text-lg font-semibold tabular-nums text-slate-100">{tc[s] ?? 0}</div>
            </Link>
          ))}
        </div>
        <p className="mt-3 text-xs text-muted-foreground">{t.pTasksNote}</p>
      </Panel>
      {latest && (
        <Panel title={t.pLatest} actions={<Link href={`/sessions/${latest.id}`} className="text-xs text-primary">{t.pOpenSession}</Link>}>
          <div className="mb-2 flex items-center gap-2"><span className="font-medium text-slate-100">{latest.title}</span><EndStatePill state={latest.endState} /></div>
          <div className="mb-3 text-xs text-muted-foreground">{agentName(latest.agent)} · {fmtDate(latest.endedAt)} · {latest.worktree ? `worktree ${latest.worktree} · ` : ''}{t.pBranch} {latest.gitBranch ?? '—'}</div>
          <div className="text-xs text-muted-foreground">{latest.endStateDetail}</div>
          {latest.lastUserPrompt && <div className="mt-3"><div className="text-xs text-indigo-300">{t.pLastRequest}</div><div className="line-clamp-6 whitespace-pre-wrap text-sm text-slate-300">{latest.lastUserPrompt}</div></div>}
          {latest.lastAssistantText && <div className="mt-3"><div className="text-xs text-cyan">{t.pLastAnswer}</div><div className="line-clamp-6 whitespace-pre-wrap text-sm text-slate-300">{latest.lastAssistantText}</div></div>}
        </Panel>
      )}
      <Panel title={t.pDecisions} actions={<Link href={`/knowledge?projectId=${id}`} className="text-xs text-primary">{t.pKnowledgeLink}</Link>}>
        {items.length === 0 ? <div className="text-sm text-muted-foreground">{t.pNoDecisions}</div> : (
          <ul className="space-y-2">{items.map((i) => <li key={i.id} className="text-sm"><Pill className="me-2 border-border text-slate-400">{i.kind}</Pill><span className="text-slate-200">{i.title}</span><span className="ms-2 text-[11px] text-muted-foreground">{i.source}</span></li>)}</ul>
        )}
      </Panel>
    </div>
  );
}

async function SessionsTab({ id }: { id: string }) {
  const { t, lang } = await getT();
  const sessions = await prisma().session.findMany({ where: { projectId: id }, orderBy: { endedAt: 'desc' }, take: 300 });
  return (
    <div className="overflow-hidden rounded-xl border border-border">
      <table className="w-full text-sm">
        <thead className="bg-card text-xs text-muted-foreground"><tr><th className="p-2 text-start">{t.pColSession}</th><th className="p-2 text-start">{t.agent}</th><th className="p-2 text-start">{t.pColWorktree}</th><th className="p-2 text-start">{t.pColEnded}</th><th className="p-2 text-end">{t.pColPrompts}</th><th className="p-2 text-end">{t.when}</th></tr></thead>
        <tbody>
          {sessions.map((s) => (
            <tr key={s.id} className="border-t border-border hover:bg-secondary/30">
              <td className="p-2">{s.isSubagent && <span className="me-1 text-[10px] text-violet-300">{t.subagent}</span>}<Link href={`/sessions/${s.id}`} className="text-slate-100 hover:text-primary">{s.title ?? s.externalId}</Link></td>
              <td className={`p-2 text-xs ${AGENT_COLORS[s.agent]}`}>{agentName(s.agent)}</td>
              <td className="p-2 font-mono text-[11px] text-muted-foreground">{s.worktree ?? ''} {s.gitBranch ? `[${s.gitBranch}]` : ''}</td>
              <td className="p-2"><EndStatePill state={s.endState} /></td>
              <td className="p-2 text-end tabular-nums text-muted-foreground">{s.userMessageCount}</td>
              <td className="p-2 text-end text-xs text-muted-foreground">{ago(s.endedAt, lang)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

async function TasksTab({ id, name }: { id: string; name: string }) {
  const { t: d } = await getT();
  const tasks = await prisma().task.findMany({ where: { projectId: id }, orderBy: [{ occurredAt: 'desc' }], take: 300 });
  const order = ['in_progress', 'blocked', 'failed', 'pending', 'requires_verification', 'completed', 'cancelled'];
  tasks.sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status));
  return (
    <div className="space-y-3">
      <NewItemForm kind="task" projects={[{ id, name }]} defaultProjectId={id} />
      {tasks.length === 0 ? <Empty>{d.pNoTasks}</Empty> : (
        <div className="overflow-hidden rounded-xl border border-border">
          <table className="w-full text-sm">
            <tbody>
              {tasks.map((t) => (
                <tr key={t.id} className="border-t border-border first:border-0 align-top">
                  <td className="p-2"><StatusPill status={t.status} /></td>
                  <td className="p-2"><div className="text-slate-200">{t.title}</div><div className="text-[11px] text-muted-foreground">{label(t.source)} · {t.agent ?? d.manualWord} · {fmtDate(t.occurredAt)} · <VerifyTag v={t.verification} /></div></td>
                  <td className="p-2 text-end">{t.sessionId && <Link href={`/sessions/${t.sessionId}${t.sourceEventSeq != null ? `?seq=${t.sourceEventSeq}` : ''}`} className="text-xs text-primary">{d.sourceWord}</Link>}</td>
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
  const { t } = await getT();
  const docs = await prisma().knowledgeDoc.findMany({ where: { projectId: id }, orderBy: { docType: 'asc' } });
  if (docs.length === 0) return <Empty action={<ActionButton path={`projects/${id}/docs`} variant="primary">{t.pGenDocs}</ActionButton>}>{t.pDocsHelp}</Empty>;
  return <DocViewer projectId={id} docs={docs.map((d) => ({ docType: d.docType, content: d.content, source: d.source, generatedAt: d.generatedAt.toISOString() }))} />;
}

async function GitTab({ id, root }: { id: string; root: string | null }) {
  const { t } = await getT();
  if (!root) return <Empty>{t.pNoFolder}</Empty>;
  const g = await getGitState(root);
  await prisma().project.update({ where: { id }, data: { gitState: JSON.stringify(g), gitCheckedAt: new Date(), isGitRepo: g.isRepo } });
  if (!g.isRepo) return <Empty>{g.error ?? t.pNotRepo}</Empty>;
  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-3">
        <Panel title={t.gBranch}><KV items={[[t.gBranch, g.branch ?? '(detached)'], [t.gUpstream, g.upstream ? `${g.upstream} (↑${g.ahead} ↓${g.behind})` : t.gNone], ['HEAD', g.head ? `${g.head.shortSha} ${g.head.subject}` : '—'], [t.gCaptured, fmtDate(g.capturedAt)]]} /></Panel>
        <Panel title={t.gWorkingTree}><KV items={[[t.gModified, g.counts.modified], [t.gAdded, g.counts.added], [t.gDeleted, g.counts.deleted], [t.gUntracked, g.counts.untracked], [t.gConflicted, g.counts.conflicted], [t.gStaged, g.counts.staged]]} /></Panel>
        <Panel title={t.gWorktreesRemotes}><div className="space-y-1 font-mono text-[11px] text-muted-foreground">{g.worktrees.map((w) => <div key={w.path}>{w.path} {w.branch && `[${w.branch}]`}</div>)}{g.remotes.map((r) => <div key={r.name} className="text-slate-400">{r.name}: {r.url}</div>)}</div></Panel>
      </div>
      <Panel title={t.gChangedFiles.replace('{n}', String(g.counts.total))}>{g.changes.length ? <ChangedFiles projectId={id} changes={g.changes} /> : <div className="text-sm text-muted-foreground">{t.gClean}</div>}</Panel>
      <Panel title={t.gRecentCommits} bodyClass="p-0">
        <table className="w-full text-sm"><tbody>{g.recentCommits.map((c) => <tr key={c.sha} className="border-t border-border first:border-0"><td className="p-2 font-mono text-xs text-cyan">{c.shortSha}</td><td className="p-2 text-slate-200">{c.subject}</td><td className="p-2 text-xs text-muted-foreground">{c.author}</td><td className="p-2 text-end text-xs text-muted-foreground">{fmtDate(c.date)}</td></tr>)}</tbody></table>
      </Panel>
      <p className="text-xs text-muted-foreground">{t.gReadOnly}</p>
    </div>
  );
}
