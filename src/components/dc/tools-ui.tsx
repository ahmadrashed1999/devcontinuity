'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Copy, GitBranch, Loader2, Play, Send } from 'lucide-react';
import { api, followJob, type JobState } from '@/lib/api';
import { ago, fmtDate } from '@/lib/format';
import { cn } from '@/lib/utils';
import { LaunchButtons, Md, VoiceButton } from './common';
import { JobProgress } from './import-center';

const btn = 'inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-sm font-medium disabled:opacity-50';
const btnP = `${btn} bg-primary text-white hover:bg-primary/85`;
const btnO = `${btn} border border-border text-slate-200 hover:bg-secondary`;
function Msg({ m }: { m: { ok: boolean; text: string } | null }) {
  return m ? <div className={cn('rounded-lg border px-3 py-2 text-sm', m.ok ? 'border-success/30 bg-success/10 text-green-200' : 'border-danger/30 bg-danger/10 text-red-200')}>{m.text}</div> : null;
}

// ---------------- Ask my projects ----------------
interface Source { n: number; kind: string; title: string; projectName: string | null; sessionId?: string; seq?: number; at: string | null; excerpt: string }
interface ChatMsg { role: 'user' | 'assistant'; content: string; sources?: Source[]; model?: string; method?: string[] }

export function AskChat({ projects, lang }: { projects: { id: string; name: string }[]; lang: 'en' | 'ar' }) {
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [q, setQ] = useState('');
  const [projectId, setProjectId] = useState('');
  const [threadId, setThreadId] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => end.current?.scrollIntoView({ behavior: 'smooth' }), [msgs]);
  const send = async () => {
    const question = q.trim();
    if (!question) return;
    setQ('');
    setErr(null);
    setMsgs((m) => [...m, { role: 'user', content: question }]);
    setBusy(true);
    try {
      const r = await api<{ threadId: string; answer: string; sources: Source[]; model?: string; method: string[] }>('ask', { method: 'POST', json: { question, threadId, projectId: projectId || undefined } });
      setThreadId(r.threadId);
      setMsgs((m) => [...m, { role: 'assistant', content: r.answer, sources: r.sources, model: r.model, method: r.method }]);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const examples = lang === 'ar' ? ['ماذا قررت بخصوص الدفع في مشروعي؟', 'أين أصلحت خطأ رفع الملفات؟', 'أي المشاريع تستخدم Firebase؟'] : ['What did I decide about payments in my-app?', 'Where did I fix the file upload error?', 'Which projects use Firebase?'];
  return (
    <div className="flex h-[calc(100vh-200px)] min-h-[500px] flex-col rounded-xl border border-border bg-card">
      <div className="flex-1 space-y-4 overflow-auto p-4">
        {msgs.length === 0 && (
          <div className="py-10 text-center">
            <p className="mb-4 text-sm text-muted-foreground">{lang === 'ar' ? 'اسأل عن أي شيء في تاريخ مشاريعك. كل إجابة تذكر مصدرها.' : 'Ask anything about your project history. Every answer cites where it came from.'}</p>
            <div className="flex flex-wrap justify-center gap-2">{examples.map((e) => <button key={e} onClick={() => setQ(e)} className="rounded-lg border border-border px-3 py-1.5 text-sm text-slate-300 hover:bg-secondary" dir="auto">{e}</button>)}</div>
          </div>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={cn('max-w-4xl', m.role === 'user' ? 'ms-auto' : '')}>
            <div className={cn('rounded-xl px-4 py-3', m.role === 'user' ? 'bg-primary/20 text-slate-100' : 'border border-border bg-background/60')} dir="auto">
              {m.role === 'assistant' ? <Md text={m.content} /> : m.content}
            </div>
            {m.sources && m.sources.length > 0 && (
              <details className="mt-1">
                <summary className="cursor-pointer text-xs text-slate-500">{m.sources.length} sources · {m.method?.join(' + ')}{m.model ? ` · ${m.model}` : ''}</summary>
                <div className="mt-1 grid gap-1 md:grid-cols-2">
                  {m.sources.map((s) => (
                    <Link id={`src-${s.n}`} key={s.n} href={s.sessionId ? `/sessions/${s.sessionId}${s.seq != null ? `?seq=${s.seq}` : ''}` : '/knowledge'} className="block rounded-lg border border-border bg-background/40 p-2 text-xs hover:border-primary/50">
                      <div className="text-slate-300"><b className="text-indigo-300">S{s.n}</b> {s.projectName ?? ''} · {s.title} · {s.at?.slice(0, 10)}</div>
                      <div className="line-clamp-2 text-slate-500">{s.excerpt}</div>
                    </Link>
                  ))}
                </div>
              </details>
            )}
          </div>
        ))}
        {busy && <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Searching your history…</div>}
        {err && <div className="text-sm text-danger">{err}</div>}
        <div ref={end} />
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-border p-3">
        <select value={projectId} onChange={(e) => setProjectId(e.target.value)} className="h-9 max-w-48 rounded-lg border border-border bg-background px-2 text-sm">
          <option value="">All projects</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && send()} dir="auto" placeholder={lang === 'ar' ? 'اكتب سؤالك…' : 'Ask about your projects…'} className="h-9 min-w-64 flex-1 rounded-lg border border-border bg-background px-3 text-sm" />
        <VoiceButton lang={lang} onText={(t) => setQ((c) => (c ? `${c} ${t}` : t))} />
        <button onClick={send} disabled={busy || !q.trim()} className={btnP}><Send className="size-4" /></button>
        {threadId && <button onClick={() => { setMsgs([]); setThreadId(undefined); }} className={btnO}>New chat</button>}
      </div>
    </div>
  );
}

// ---------------- Worktrees ----------------
interface Wt { path: string; name: string; branch: string | null; exists: boolean; dirty: number; ahead: number | null; merged: boolean | null; lastCommitAt: string | null; state: string; stale: boolean; reasons: string[]; sessions: { id: string; title: string | null; endState: string; endedAt: string | null }[] }
const WT_STYLE: Record<string, string> = { at_risk: 'border-danger/40 bg-danger/5', unmerged: 'border-warning/40 bg-warning/5', missing: 'border-border opacity-70', clean: 'border-border', merged: 'border-success/30', main: 'border-primary/30' };
const WT_LABEL: Record<string, string> = { at_risk: 'Uncommitted work (at risk)', unmerged: 'Unmerged commits', missing: 'Folder missing', clean: 'Clean, nothing new', merged: 'Merged', main: 'Main checkout' };

export function WorktreeList({ projectId }: { projectId: string }) {
  const [data, setData] = useState<{ repo: string; defaultBranch: string | null; worktrees: Wt[]; error?: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset when the project changes
    setData(null);
    api<typeof data>(`projects/${projectId}/worktrees`).then(setData).catch((e) => setErr((e as Error).message));
  }, [projectId]);
  if (err) return <div className="text-sm text-danger">{err}</div>;
  if (!data) return <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Inspecting worktrees (read-only)…</div>;
  if (data.error) return <div className="text-sm text-muted-foreground">{data.error}</div>;
  const counts = data.worktrees.reduce<Record<string, number>>((a, w) => ({ ...a, [w.state]: (a[w.state] ?? 0) + 1 }), {});
  const list = filter ? data.worktrees.filter((w) => w.state === filter) : data.worktrees;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2 text-xs">
        <button onClick={() => setFilter('')} className={cn('rounded-md border px-2 py-1', !filter ? 'border-primary bg-primary/15' : 'border-border')}>All {data.worktrees.length}</button>
        {Object.entries(counts).map(([k, v]) => <button key={k} onClick={() => setFilter(k)} className={cn('rounded-md border px-2 py-1', filter === k ? 'border-primary bg-primary/15' : 'border-border')}>{WT_LABEL[k]} {v}</button>)}
        <span className="ms-auto text-muted-foreground">compared with {data.defaultBranch}</span>
      </div>
      {list.map((w) => (
        <div key={w.path} className={cn('rounded-xl border bg-card p-3', WT_STYLE[w.state])}>
          <div className="flex flex-wrap items-center gap-2">
            <GitBranch className="size-4 text-muted-foreground" />
            <span className="font-medium text-white">{w.name}</span>
            <span className="font-mono text-xs text-slate-400">{w.branch ?? '(detached)'}</span>
            <span className={cn('rounded-md px-1.5 py-0.5 text-[11px]', w.state === 'at_risk' ? 'bg-danger/20 text-red-200' : w.state === 'unmerged' ? 'bg-warning/20 text-amber-200' : w.state === 'merged' ? 'bg-success/20 text-green-200' : 'bg-secondary text-slate-300')}>{WT_LABEL[w.state]}</span>
            {w.stale && <span className="text-[11px] text-slate-500">stale</span>}
            <span className="ms-auto text-xs text-muted-foreground">last commit {ago(w.lastCommitAt)}</span>
          </div>
          <div className="mt-1 font-mono text-[11px] text-slate-500">{w.path}</div>
          {w.reasons.length > 0 && <ul className="mt-1 text-xs text-slate-300">{w.reasons.map((r) => <li key={r}>• {r}</li>)}</ul>}
          {w.sessions.length > 0 && <div className="mt-1 text-xs text-muted-foreground">Sessions: {w.sessions.map((s) => <Link key={s.id} href={`/sessions/${s.id}`} className="me-2 text-primary">{s.title ?? s.id.slice(-6)} ({s.endState.replace(/_/g, ' ')})</Link>)}</div>}
          {w.exists && !w.state.startsWith('main') && <div className="mt-2"><LaunchButtons projectId={projectId} sessionId={w.sessions[0]?.id} dir={w.path} compact /></div>}
        </div>
      ))}
      <p className="text-xs text-muted-foreground">Read-only. DevContinuity never deletes or prunes worktrees; the &quot;Open in&quot; buttons open an agent inside the worktree folder.</p>
    </div>
  );
}

// ---------------- Triage & verification ----------------
export function TriagePanel({ summary }: { summary: { projectId: string | null; projectName: string; triage: string | null; count: number }[] }) {
  const router = useRouter();
  const [job, setJob] = useState<JobState | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const run = async () => {
    const r = await api<{ jobId: string }>('triage/all', { method: 'POST' });
    followJob(r.jobId, (j) => {
      setJob(j);
      if (j.status !== 'running') router.refresh();
    });
  };
  const apply = async (projectId: string | null, triage: string, action: string, n: number) => {
    if (!window.confirm(`Mark ${n} task(s) as “${action}”? This records that you approved the evidence-based suggestion.`)) return;
    try {
      const r = await api<{ updated: number }>('triage/apply', { method: 'POST', json: { projectId: projectId ?? undefined, triage, action } });
      setMsg({ ok: true, text: `${r.updated} task(s) updated.` });
      router.refresh();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  };
  const byProject = new Map<string, { projectId: string | null; rows: Record<string, number> }>();
  for (const s of summary) {
    const v = byProject.get(s.projectName) ?? { projectId: s.projectId, rows: {} };
    v.rows[s.triage ?? 'not_checked'] = s.count;
    byProject.set(s.projectName, v);
  }
  const cols = [['likely_done', 'Likely done', 'completed', 'text-success'], ['likely_not_done', 'Likely NOT done', 'pending', 'text-danger'], ['no_code_changes', 'No code changes', 'cancelled', 'text-slate-300'], ['unknown', 'Unclear', '', 'text-warning'], ['not_checked', 'Not checked yet', '', 'text-slate-500']] as const;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <button onClick={run} disabled={job?.status === 'running'} className={btnP}><Play className="size-4" /> Check all unverified tasks against files & Git</button>
        <span className="text-xs text-muted-foreground">Reads files and runs read-only Git checks. No AI, no cost. Nothing changes until you approve a group.</span>
      </div>
      {job && <JobProgress job={job} />}
      <Msg m={msg} />
      <div className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full text-sm">
          <thead className="bg-card text-xs text-muted-foreground"><tr><th className="p-2 text-start">Project</th>{cols.map((c) => <th key={c[0]} className="p-2 text-end">{c[1]}</th>)}</tr></thead>
          <tbody>
            {[...byProject.entries()].map(([name, v]) => (
              <tr key={name} className="border-t border-border">
                <td className="p-2">{v.projectId ? <Link href={`/verify?projectId=${v.projectId}`} className="text-slate-200 hover:text-primary">{name}</Link> : name}</td>
                {cols.map(([k, , action, tone]) => (
                  <td key={k} className="p-2 text-end">
                    <span className={cn('tabular-nums', tone)}>{v.rows[k] ?? 0}</span>
                    {action && (v.rows[k] ?? 0) > 0 && <button onClick={() => apply(v.projectId, k, action, v.rows[k])} className="ms-2 rounded border border-border px-1.5 text-[10px] text-slate-300 hover:bg-secondary">→ {action}</button>}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

interface VRun { id: string; command: string; status: string; exitCode: number | null; output: string | null; durationMs: number | null; startedAt: string; cwd: string }

export function VerifyPanel({ projectId, tasks }: { projectId: string; tasks: { id: string; title: string; triage: string | null; triageReason: string | null }[] }) {
  const router = useRouter();
  const [data, setData] = useState<{ testCommand: string | null; detected: { command: string; reason: string }[]; runs: VRun[] } | null>(null);
  const [cmd, setCmd] = useState('');
  const [sel, setSel] = useState<string[]>([]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const load = useCallback(() => api<typeof data>(`projects/${projectId}/verify`).then((d) => { setData(d); setCmd((c) => c || d?.testCommand || d?.detected[0]?.command || ''); }), [projectId]);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 4000);
    return () => clearInterval(t);
  }, [load]);
  if (!data) return <Loader2 className="size-4 animate-spin" />;
  const lastPassed = data.runs.find((r) => r.status === 'passed');
  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-border bg-card p-4">
        <div className="mb-2 font-semibold text-white">Run tests / build (one click, with your confirmation)</div>
        <div className="flex flex-wrap gap-2">
          <input value={cmd} onChange={(e) => setCmd(e.target.value)} className="h-8 min-w-64 flex-1 rounded-md border border-border bg-background px-2 font-mono text-sm" />
          <button onClick={async () => { if (!window.confirm(`Run "${cmd}" in the project folder?`)) return; try { await api(`projects/${projectId}/verify`, { method: 'POST', json: { command: cmd } }); void load(); } catch (e) { setMsg({ ok: false, text: (e as Error).message }); } }} className={btnP}><Play className="size-4" /> Run</button>
          <button onClick={async () => { try { await api(`projects/${projectId}/test-command`, { method: 'PUT', json: { command: cmd } }); setMsg({ ok: true, text: 'Saved as the project test command (QA uses it for AI work too).' }); void load(); } catch (e) { setMsg({ ok: false, text: (e as Error).message }); } }} className={btnO}>Save as project test command</button>
        </div>
        <div className="mt-2 flex flex-wrap gap-1 text-xs">{data.detected.map((d) => <button key={d.command} onClick={() => setCmd(d.command)} className="rounded border border-border px-2 py-0.5 text-slate-400 hover:text-white" title={d.reason}>{d.command}</button>)}</div>
        <p className="mt-2 text-xs text-muted-foreground">Only known toolchain commands are accepted. Commands from old transcripts are never run.</p>
      </div>
      <Msg m={msg} />
      {data.runs.map((r) => (
        <details key={r.id} className={cn('rounded-xl border bg-card p-3', r.status === 'passed' ? 'border-success/30' : r.status === 'failed' ? 'border-danger/30' : 'border-cyan/30')} open={r.status === 'running'}>
          <summary className="cursor-pointer text-sm">
            {r.status === 'running' ? <Loader2 className="me-1 inline size-4 animate-spin text-cyan" /> : r.status === 'passed' ? <CheckCircle2 className="me-1 inline size-4 text-success" /> : <AlertTriangle className="me-1 inline size-4 text-danger" />}
            <span className="font-mono">{r.command}</span> <span className="text-xs text-muted-foreground">· {r.status}{r.exitCode != null ? ` (exit ${r.exitCode})` : ''} · {fmtDate(r.startedAt)}{r.durationMs ? ` · ${(r.durationMs / 1000).toFixed(0)}s` : ''}</span>
          </summary>
          <pre className="mt-2 max-h-80 overflow-auto rounded bg-black/40 p-2 font-mono text-[10px] text-slate-400">{r.output ?? '(running…)'}</pre>
        </details>
      ))}
      {tasks.length > 0 && (
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="font-semibold text-white">Tasks reported done ({tasks.length})</span>
            <button disabled={!sel.length || !lastPassed} onClick={async () => { try { const r = await api<{ updated: number }>('tasks/bulk-verify', { method: 'POST', json: { taskIds: sel, runId: lastPassed!.id } }); setMsg({ ok: true, text: `${r.updated} task(s) marked verified with run "${lastPassed!.command}".` }); setSel([]); router.refresh(); } catch (e) { setMsg({ ok: false, text: (e as Error).message }); } }} className={btnP}>Mark {sel.length} selected as verified{lastPassed ? ` (evidence: ${lastPassed.command} passed)` : ' — needs a passing run'}</button>
            <button onClick={() => setSel(sel.length ? [] : tasks.filter((t) => t.triage === 'likely_done').map((t) => t.id))} className={btnO}>{sel.length ? 'Clear' : 'Select "likely done"'}</button>
          </div>
          <div className="max-h-[500px] space-y-1 overflow-auto">
            {tasks.map((t) => (
              <label key={t.id} className="flex items-start gap-2 rounded-md px-2 py-1 text-sm hover:bg-secondary/40">
                <input type="checkbox" className="mt-1" checked={sel.includes(t.id)} onChange={(e) => setSel((s) => (e.target.checked ? [...s, t.id] : s.filter((x) => x !== t.id)))} />
                <span className="flex-1">
                  <span className="text-slate-200">{t.title}</span>
                  {t.triage && <span className={cn('ms-2 text-[11px]', t.triage === 'likely_done' ? 'text-success' : t.triage === 'likely_not_done' ? 'text-danger' : 'text-slate-400')}>{t.triage.replace(/_/g, ' ')}</span>}
                  {t.triageReason && <div className="text-[11px] text-slate-500">{t.triageReason}</div>}
                </span>
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------- Rules ----------------
export function RulesEditor({ projectId }: { projectId: string }) {
  const [data, setData] = useState<{ rules: string; preview: { id: string; label: string; file: string; exists: boolean; managed: boolean; action: string }[] } | null>(null);
  const [rules, setRules] = useState('');
  const [targets, setTargets] = useState<string[]>(['claude', 'agents', 'cursor']);
  const [sharedMemory, setSharedMemory] = useState(true);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const load = useCallback(() => api<typeof data>(`projects/${projectId}/rules`).then((d) => { setData(d); setRules(d?.rules ?? ''); }), [projectId]);
  useEffect(() => {
    void load();
  }, [load]);
  if (!data) return <Loader2 className="size-4 animate-spin" />;
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">Write the project rules once (coding style, architecture, do/don&apos;t, commands). DevContinuity keeps a marked block in each agent&apos;s rules file in sync. Text outside the block is never changed, and every file is backed up first.</p>
      <textarea value={rules} onChange={(e) => setRules(e.target.value)} rows={16} dir="auto" placeholder="# Project rules\n- Use Riverpod for state\n- Never edit generated files\n- Run flutter analyze before finishing" className="w-full rounded-lg border border-border bg-background p-3 font-mono text-xs" />
      <div className="flex flex-wrap gap-2">
        <button onClick={async () => { await api(`projects/${projectId}/rules`, { method: 'PUT', json: { rules } }); setMsg({ ok: true, text: 'Saved.' }); }} className={btnP}>Save rules</button>
        <button onClick={async () => { try { const r = await api<{ rules: string }>(`projects/${projectId}/rules/import`, { method: 'POST' }); setRules(r.rules || rules); setMsg({ ok: true, text: r.rules ? 'Imported existing CLAUDE.md / AGENTS.md / Cursor rules. Review and save.' : 'No existing rules files found.' }); } catch (e) { setMsg({ ok: false, text: (e as Error).message }); } }} className={btnO}>Import from existing files</button>
      </div>
      <div className="rounded-xl border border-border bg-card p-3">
        <div className="mb-2 text-sm font-semibold text-white">Sync to agents</div>
        {data.preview.map((p) => (
          <label key={p.id} className="flex items-center gap-2 py-0.5 text-sm">
            <input type="checkbox" checked={targets.includes(p.id)} onChange={(e) => setTargets((t) => (e.target.checked ? [...t, p.id] : t.filter((x) => x !== p.id)))} />
            <span className="text-slate-200">{p.label}</span> <span className="font-mono text-xs text-slate-500">{p.file}</span> <span className="text-xs text-cyan">{p.action}</span>
          </label>
        ))}
        <label className="mt-2 flex items-start gap-2 rounded-lg border border-cyan/30 bg-cyan/5 p-2 text-sm">
          <input type="checkbox" className="mt-1" checked={sharedMemory} onChange={(e) => setSharedMemory(e.target.checked)} />
          <span>
            <span className="text-slate-100">Shared memory: tell agents to call <code>project_context</code> at the start and <code>log_summary</code> at the end</span>
            <span className="block text-xs text-muted-foreground">Adds a short instruction to the block, so every connected agent sees what the others did here and leaves notes for the next one (needs the DevContinuity MCP server: Connected agents → Connect).</span>
          </span>
        </label>
        <button onClick={async () => { if (!window.confirm('Write the rules block into the selected files in the project folder? Originals are backed up first.')) return; try { await api(`projects/${projectId}/rules`, { method: 'PUT', json: { rules } }); const r = await api<{ file: string; action: string }[]>(`projects/${projectId}/rules/sync`, { method: 'POST', json: { targets, sharedMemory } }); setMsg({ ok: true, text: r.map((x) => `${x.action}: ${x.file}`).join(' · ') }); void load(); } catch (e) { setMsg({ ok: false, text: (e as Error).message }); } }} className={`${btnP} mt-2`}>Sync now</button>
      </div>
      <Msg m={msg} />
    </div>
  );
}

// ---------------- GitHub ----------------
export function GithubPanel({ projectId }: { projectId: string }) {
  const [d, setD] = useState<{ repo: string | null; error?: string; prs?: { number: number; title: string; state: string; url: string; headRefName: string; updatedAt: string; isDraft: boolean; sessions: { id: string; title: string | null }[] }[]; issues?: { number: number; title: string; url: string; updatedAt: string; labels: { name: string }[] }[]; runs?: { databaseId: number; name: string; status: string; conclusion: string; headBranch: string; url: string; createdAt: string }[] } | null>(null);
  useEffect(() => {
    api<typeof d>(`projects/${projectId}/github`).then(setD).catch((e) => setD({ repo: null, error: (e as Error).message }));
  }, [projectId]);
  if (!d) return <Loader2 className="size-4 animate-spin" />;
  if (!d.repo) return <div className="text-sm text-muted-foreground">{d.error}</div>;
  return (
    <div className="space-y-4">
      <div className="text-sm text-muted-foreground">github.com/{d.repo}{d.error && <span className="ms-2 text-warning">{d.error}</span>}</div>
      <div className="grid gap-4 xl:grid-cols-2">
        <div className="rounded-xl border border-border bg-card p-3">
          <div className="mb-2 font-semibold text-white">Pull requests</div>
          {d.prs?.map((p) => (
            <div key={p.number} className="border-t border-border/50 py-1.5 text-sm first:border-0">
              <a href={p.url} target="_blank" rel="noreferrer" className="text-slate-200 hover:text-primary">#{p.number} {p.title}</a>
              <div className="text-[11px] text-muted-foreground">{p.state.toLowerCase()}{p.isDraft ? ' · draft' : ''} · {p.headRefName} · {ago(p.updatedAt)}{p.sessions.length > 0 && <> · created in {p.sessions.map((s) => <Link key={s.id} href={`/sessions/${s.id}`} className="ms-1 text-primary">{s.title ?? 'session'}</Link>)}</>}</div>
            </div>
          ))}
        </div>
        <div className="space-y-4">
          <div className="rounded-xl border border-border bg-card p-3">
            <div className="mb-2 font-semibold text-white">CI runs</div>
            {d.runs?.map((r) => <div key={r.databaseId} className="flex gap-2 py-0.5 text-sm"><span className={r.conclusion === 'success' ? 'text-success' : r.conclusion === 'failure' ? 'text-danger' : 'text-warning'}>{r.conclusion || r.status}</span><a href={r.url} target="_blank" rel="noreferrer" className="truncate text-slate-300 hover:text-primary">{r.name}</a><span className="ms-auto text-xs text-muted-foreground">{r.headBranch} · {ago(r.createdAt)}</span></div>)}
          </div>
          <div className="rounded-xl border border-border bg-card p-3">
            <div className="mb-2 font-semibold text-white">Open issues</div>
            {d.issues?.map((i) => <a key={i.number} href={i.url} target="_blank" rel="noreferrer" className="block py-0.5 text-sm text-slate-300 hover:text-primary">#{i.number} {i.title}</a>)}
            {d.issues?.length === 0 && <div className="text-sm text-muted-foreground">None.</div>}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------- Schedules ----------------
interface Sched { id: string; name: string; action: string; timing: string; payload: string | null; enabled: boolean; lastRunAt: string | null; nextRunAt: string | null; lastResult: string | null }
export function SchedulesManager({ projects }: { projects: { id: string; name: string }[] }) {
  const [rows, setRows] = useState<Sched[]>([]);
  const [f, setF] = useState({ name: '', action: 'order', every: 'day', at: '08:00', weekday: 0, hours: 6, projectId: '', instruction: '', command: '' });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const load = useCallback(() => api<Sched[]>('schedules').then(setRows), []);
  useEffect(() => {
    void load();
  }, [load]);
  const describe = (t: string) => {
    const x = JSON.parse(t) as { every: string; at?: string; weekday?: number; hours?: number };
    return x.every === 'hours' ? `every ${x.hours} h` : x.every === 'week' ? `weekly, ${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][x.weekday ?? 0]} ${x.at}` : `daily ${x.at}`;
  };
  return (
    <div className="space-y-4">
      <div className="overflow-hidden rounded-xl border border-border">
        <table className="w-full text-sm">
          <tbody>
            {rows.map((s) => (
              <tr key={s.id} className="border-t border-border first:border-0">
                <td className="p-2"><input type="checkbox" checked={s.enabled} onChange={async (e) => { await api(`schedules/${s.id}`, { method: 'PATCH', json: { enabled: e.target.checked } }); void load(); }} /></td>
                <td className="p-2"><div className="text-slate-200">{s.name}</div><div className="text-[11px] text-muted-foreground">{s.action} · {describe(s.timing)}</div></td>
                <td className="p-2 text-xs text-muted-foreground">next {fmtDate(s.nextRunAt)}<div className="max-w-md truncate">{s.lastResult}</div></td>
                <td className="p-2 text-end whitespace-nowrap">
                  <button onClick={async () => { try { const r = await api<{ result: string }>(`schedules/${s.id}/run`, { method: 'POST' }); setMsg({ ok: true, text: r.result }); void load(); } catch (e) { setMsg({ ok: false, text: (e as Error).message }); } }} className="me-1 rounded border border-border px-2 py-0.5 text-xs">Run now</button>
                  <button onClick={async () => { if (window.confirm('Delete this schedule?')) { await api(`schedules/${s.id}`, { method: 'DELETE' }); void load(); } }} className="rounded border border-danger/30 px-2 py-0.5 text-xs text-red-300">Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Msg m={msg} />
      <div className="rounded-xl border border-border bg-card p-4">
        <div className="mb-2 font-semibold text-white">New scheduled job</div>
        <div className="grid gap-2 md:grid-cols-3">
          <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Name" className="h-8 rounded-md border border-border bg-background px-2 text-sm" />
          <select value={f.action} onChange={(e) => setF({ ...f, action: e.target.value })} className="h-8 rounded-md border border-border bg-background px-2 text-sm">
            <option value="order">Send an order to the AI organization</option><option value="verify_project">Run project tests/build</option><option value="security_scan">Dependency security audit</option><option value="digest_daily">Daily brief</option><option value="digest_weekly">Weekly brief</option><option value="worktree_scan">Worktree risk scan</option><option value="archive_assets">Archive agent assets</option>
          </select>
          <div className="flex gap-1">
            <select value={f.every} onChange={(e) => setF({ ...f, every: e.target.value })} className="h-8 rounded-md border border-border bg-background px-2 text-sm"><option value="day">Daily</option><option value="week">Weekly</option><option value="hours">Every N hours</option></select>
            {f.every === 'hours' ? <input type="number" value={f.hours} onChange={(e) => setF({ ...f, hours: Number(e.target.value) })} className="h-8 w-16 rounded-md border border-border bg-background px-2 text-sm" /> : <input type="time" value={f.at} onChange={(e) => setF({ ...f, at: e.target.value })} className="h-8 rounded-md border border-border bg-background px-2 text-sm" />}
            {f.every === 'week' && <select value={f.weekday} onChange={(e) => setF({ ...f, weekday: Number(e.target.value) })} className="h-8 rounded-md border border-border bg-background px-1 text-sm">{['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d, i) => <option key={d} value={i}>{d}</option>)}</select>}
          </div>
        </div>
        {['order', 'verify_project', 'security_scan'].includes(f.action) && (
          <div className="mt-2 grid gap-2 md:grid-cols-[220px_1fr]">
            <select value={f.projectId} onChange={(e) => setF({ ...f, projectId: e.target.value })} className="h-8 rounded-md border border-border bg-background px-2 text-sm"><option value="">Project…</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
            {f.action === 'order' ? <input value={f.instruction} onChange={(e) => setF({ ...f, instruction: e.target.value })} placeholder="Instruction, e.g. Triage yesterday's production errors and propose fixes" className="h-8 rounded-md border border-border bg-background px-2 text-sm" /> : <input value={f.command} onChange={(e) => setF({ ...f, command: e.target.value })} placeholder={f.action === 'security_scan' ? 'npm audit / composer audit' : 'flutter test'} className="h-8 rounded-md border border-border bg-background px-2 font-mono text-sm" />}
          </div>
        )}
        <button onClick={async () => { try { await api('schedules', { method: 'POST', json: { name: f.name, action: f.action, timing: { every: f.every, at: f.at, weekday: f.weekday, hours: f.hours }, payload: { projectId: f.projectId || undefined, instruction: f.instruction || undefined, command: f.command || undefined } } }); setMsg({ ok: true, text: 'Schedule created.' }); void load(); } catch (e) { setMsg({ ok: false, text: (e as Error).message }); } }} className={`${btnP} mt-3`}>Create schedule</button>
        <p className="mt-2 text-xs text-muted-foreground">Scheduled orders still send their plan to you for approval, and merges still need you. Schedules run while the background service is running.</p>
      </div>
    </div>
  );
}

// ---------------- Prompt library ----------------
interface Tpl { id: string; title: string; category: string; body: string; tags: string | null; lang: string; uses: number }
export function PromptLibrary({ projects }: { projects: { id: string; name: string }[] }) {
  const [rows, setRows] = useState<Tpl[]>([]);
  const [projectId, setProjectId] = useState('');
  const [edit, setEdit] = useState<Partial<Tpl> | null>(null);
  const [out, setOut] = useState<{ id: string; text: string } | null>(null);
  const [cat, setCat] = useState('');
  const load = useCallback(() => api<Tpl[]>('prompts').then(setRows), []);
  useEffect(() => {
    void load();
  }, [load]);
  const cats = [...new Set(rows.map((r) => r.category))];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <select value={projectId} onChange={(e) => setProjectId(e.target.value)} className="h-8 rounded-md border border-border bg-background px-2 text-sm"><option value="">Fill {'{{project}}'} with…</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
        <div className="flex gap-1">{['', ...cats].map((c) => <button key={c} onClick={() => setCat(c)} className={cn('rounded-md border px-2 py-1 text-xs', cat === c ? 'border-primary bg-primary/15' : 'border-border')}>{c || 'All'}</button>)}</div>
        <button onClick={() => setEdit({ title: '', body: '', category: 'general', lang: 'en' })} className={`${btnP} ms-auto`}>New template</button>
      </div>
      {edit && (
        <div className="rounded-xl border border-primary/30 bg-card p-3">
          <div className="grid gap-2 md:grid-cols-[1fr_160px_100px]">
            <input value={edit.title ?? ''} onChange={(e) => setEdit({ ...edit, title: e.target.value })} placeholder="Title" className="h-8 rounded-md border border-border bg-background px-2 text-sm" />
            <input value={edit.category ?? ''} onChange={(e) => setEdit({ ...edit, category: e.target.value })} placeholder="Category" className="h-8 rounded-md border border-border bg-background px-2 text-sm" />
            <select value={edit.lang ?? 'en'} onChange={(e) => setEdit({ ...edit, lang: e.target.value })} className="h-8 rounded-md border border-border bg-background px-2 text-sm"><option value="en">EN</option><option value="ar">AR</option></select>
          </div>
          <textarea value={edit.body ?? ''} onChange={(e) => setEdit({ ...edit, body: e.target.value })} rows={6} dir="auto" placeholder="Prompt text. Variables: {{project}}, {{projectPath}}, {{description}}" className="mt-2 w-full rounded-md border border-border bg-background p-2 text-sm" />
          <div className="mt-2 flex gap-2">
            <button onClick={async () => { if (edit.id) await api(`prompts/${edit.id}`, { method: 'PATCH', json: edit }); else await api('prompts', { method: 'POST', json: edit }); setEdit(null); void load(); }} className={btnP}>Save</button>
            <button onClick={() => setEdit(null)} className={btnO}>Cancel</button>
          </div>
        </div>
      )}
      <div className="grid gap-3 lg:grid-cols-2">
        {rows.filter((r) => !cat || r.category === cat).map((t) => (
          <div key={t.id} className="rounded-xl border border-border bg-card p-3">
            <div className="flex items-center gap-2"><span className="font-medium text-white" dir="auto">{t.title}</span><span className="text-[11px] text-muted-foreground">{t.category} · {t.lang} · used {t.uses}×</span></div>
            <p className="mt-1 line-clamp-3 text-xs text-slate-400" dir="auto">{t.body}</p>
            <div className="mt-2 flex flex-wrap gap-1">
              <button onClick={async () => { const r = await api<{ text: string }>(`prompts/${t.id}/use`, { method: 'POST', json: { projectId: projectId || undefined } }); await navigator.clipboard.writeText(r.text); setOut({ id: t.id, text: r.text }); void load(); }} className={btnO}><Copy className="size-3.5" /> Copy</button>
              <button onClick={() => setEdit(t)} className={btnO}>Edit</button>
              <button onClick={async () => { if (window.confirm('Delete template?')) { await api(`prompts/${t.id}`, { method: 'DELETE' }); void load(); } }} className="text-xs text-red-300">Delete</button>
            </div>
            {out?.id === t.id && (
              <div className="mt-2 space-y-2">
                <div className="text-xs text-success">Copied to the clipboard. Or open an agent with it:</div>
                {projectId && <LaunchWithPrompt projectId={projectId} text={out.text} />}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function LaunchWithPrompt({ projectId, text }: { projectId: string; text: string }) {
  const [m, setM] = useState<string | null>(null);
  return (
    <div className="flex flex-wrap gap-1">
      {['claude-code', 'codex', 'opencode', 'cursor'].map((a) => <button key={a} onClick={async () => { try { const r = await api<{ note: string }>('launch', { method: 'POST', json: { agent: a, projectId, promptText: text } }); setM(r.note); } catch (e) { setM((e as Error).message); } }} className="rounded border border-border px-2 py-0.5 text-xs text-slate-300 hover:bg-secondary">{a}</button>)}
      {m && <span className="text-xs text-muted-foreground">{m}</span>}
    </div>
  );
}

// ---------------- Cloud backup ----------------
export function CloudBackupPanel() {
  const router = useRouter();
  const [d, setD] = useState<{ settings: { folder?: string; r2?: { accountId: string; bucket: string; accessKeyId: string; prefix?: string } }; hasPassphrase: boolean; hasR2Secret: boolean; encrypted: { name: string; sizeMb: number }[] } | null>(null);
  const [f, setF] = useState({ folder: '', accountId: '', bucket: '', accessKeyId: '', prefix: 'devcontinuity' });
  const [pass, setPass] = useState('');
  const [r2s, setR2s] = useState('');
  const [job, setJob] = useState<JobState | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const load = useCallback(() => api<typeof d>('backup/cloud').then((x) => { setD(x); if (x) setF({ folder: x.settings.folder ?? '', accountId: x.settings.r2?.accountId ?? '', bucket: x.settings.r2?.bucket ?? '', accessKeyId: x.settings.r2?.accessKeyId ?? '', prefix: x.settings.r2?.prefix ?? 'devcontinuity' }); }), []);
  useEffect(() => {
    void load();
  }, [load]);
  if (!d) return null;
  const save = async () => {
    try {
      if (pass) await api('secrets/backupPassphrase', { method: 'PUT', json: { value: pass } });
      if (r2s) await api('secrets/r2SecretAccessKey', { method: 'PUT', json: { value: r2s } });
      await api('backup/cloud', { method: 'PUT', json: { folder: f.folder || undefined, r2: f.accountId ? { accountId: f.accountId, bucket: f.bucket, accessKeyId: f.accessKeyId, prefix: f.prefix } : undefined } });
      setPass('');
      setR2s('');
      setMsg({ ok: true, text: 'Saved. Secrets are stored encrypted (Windows DPAPI-protected key).' });
      void load();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  };
  return (
    <div className="space-y-3 rounded-xl border border-border bg-card p-4">
      <div className="font-semibold text-white">Encrypted cloud backup</div>
      <p className="text-xs text-muted-foreground">The backup is encrypted on this PC with your passphrase (AES-256-GCM) before it is copied anywhere. Keep the passphrase safe: without it the backup cannot be restored.</p>
      <div className="grid gap-2 md:grid-cols-2">
        <label className="text-xs text-muted-foreground">Passphrase {d.hasPassphrase ? <span className="text-success">(set)</span> : <span className="text-warning">(not set)</span>}<input type="password" value={pass} onChange={(e) => setPass(e.target.value)} placeholder={d.hasPassphrase ? 'leave empty to keep' : 'at least 12 characters'} className="mt-1 h-8 w-full rounded-md border border-border bg-background px-2 text-sm" /></label>
        <label className="text-xs text-muted-foreground">Copy to folder (e.g. Google Drive / OneDrive sync folder)<input value={f.folder} onChange={(e) => setF({ ...f, folder: e.target.value })} placeholder="G:\My Drive\DevContinuity" className="mt-1 h-8 w-full rounded-md border border-border bg-background px-2 font-mono text-sm" /></label>
      </div>
      <details>
        <summary className="cursor-pointer text-xs text-slate-400">Cloudflare R2 (optional)</summary>
        <div className="mt-2 grid gap-2 md:grid-cols-2">
          <input value={f.accountId} onChange={(e) => setF({ ...f, accountId: e.target.value })} placeholder="Account ID" className="h-8 rounded-md border border-border bg-background px-2 font-mono text-xs" />
          <input value={f.bucket} onChange={(e) => setF({ ...f, bucket: e.target.value })} placeholder="Bucket" className="h-8 rounded-md border border-border bg-background px-2 font-mono text-xs" />
          <input value={f.accessKeyId} onChange={(e) => setF({ ...f, accessKeyId: e.target.value })} placeholder="Access key ID" className="h-8 rounded-md border border-border bg-background px-2 font-mono text-xs" />
          <input type="password" value={r2s} onChange={(e) => setR2s(e.target.value)} placeholder={d.hasR2Secret ? 'Secret access key (set)' : 'Secret access key'} className="h-8 rounded-md border border-border bg-background px-2 font-mono text-xs" />
        </div>
      </details>
      <div className="flex flex-wrap gap-2">
        <button onClick={save} className={btnO}>Save settings</button>
        <button disabled={job?.status === 'running'} onClick={async () => { try { const r = await api<{ jobId: string }>('backup/cloud/run', { method: 'POST' }); followJob(r.jobId, (j) => { setJob(j); if (j.status !== 'running') { router.refresh(); void load(); } }); } catch (e) { setMsg({ ok: false, text: (e as Error).message }); } }} className={btnP}>Run encrypted backup now</button>
      </div>
      {job && <JobProgress job={job} />}
      <Msg m={msg} />
      {d.encrypted.length > 0 && (
        <div className="text-xs">
          <div className="mb-1 text-muted-foreground">Encrypted backups on this PC (restore: decrypt, then use Restore in the list above):</div>
          {d.encrypted.map((e) => (
            <div key={e.name} className="flex items-center gap-2 py-0.5"><span className="font-mono text-slate-400">{e.name}</span><span className="text-slate-500">{e.sizeMb.toFixed(1)} MB</span>
              <button onClick={async () => { const p = window.prompt('Passphrase for this backup:'); if (!p) return; try { await api('backup/decrypt', { method: 'POST', json: { name: e.name, passphrase: p } }); setMsg({ ok: true, text: 'Decrypted. It now appears in the backup list where you can restore it.' }); router.refresh(); } catch (er) { setMsg({ ok: false, text: (er as Error).message }); } }} className="rounded border border-border px-1.5">Decrypt</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------- MCP & skills ----------------
export function McpSkillsPanel() {
  const [d, setD] = useState<{ servers: { agent: string; name: string; command: string }[]; notes: string[]; skills: { agent: string; dir: string; skills: string[] }[]; devcontinuity: Record<string, string> } | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const load = useCallback(() => api<typeof d>('mcp').then(setD), []);
  useEffect(() => {
    void load();
  }, [load]);
  if (!d) return <Loader2 className="size-4 animate-spin" />;
  const names = [...new Set(d.servers.map((s) => s.name))];
  const agents = ['claude-code', 'codex', 'opencode'];
  const allSkills = [...new Set(d.skills.flatMap((s) => s.skills))].sort();
  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-border bg-card p-4">
        <div className="mb-2 font-semibold text-white">MCP servers across agents</div>
        <table className="w-full text-xs">
          <thead className="text-muted-foreground"><tr><th className="p-1 text-start">Server</th>{agents.map((a) => <th key={a} className="p-1">{a}</th>)}</tr></thead>
          <tbody>
            {names.map((n) => (
              <tr key={n} className="border-t border-border/50">
                <td className="p-1 font-mono text-slate-300">{n}</td>
                {agents.map((a) => <td key={a} className="p-1 text-center">{d.servers.some((s) => s.name === n && s.agent === a) ? <span className="text-success">✓</span> : <span className="text-slate-600">—</span>}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
        {d.notes.map((n) => <div key={n} className="mt-1 text-xs text-warning">{n}</div>)}
        <div className="mt-3 text-sm font-medium text-slate-200">Register DevContinuity&apos;s MCP server in each agent</div>
        <div className="mt-1 grid gap-2 md:grid-cols-2">
          {Object.entries(d.devcontinuity).map(([a, s]) => (
            <div key={a} className="rounded-lg bg-black/40 p-2"><div className="mb-1 flex items-center text-[11px] text-slate-500">{a}<button onClick={() => navigator.clipboard.writeText(s)} className="ms-auto text-primary">copy</button></div><pre className="whitespace-pre-wrap font-mono text-[11px] text-slate-300">{s}</pre></div>
          ))}
        </div>
      </div>
      <div className="rounded-xl border border-border bg-card p-4">
        <div className="mb-2 font-semibold text-white">Skills across agents</div>
        <table className="w-full text-xs">
          <thead className="text-muted-foreground"><tr><th className="p-1 text-start">Skill</th>{d.skills.map((s) => <th key={s.agent} className="p-1">{s.agent}</th>)}</tr></thead>
          <tbody>
            {allSkills.map((sk) => {
              const from = d.skills.find((s) => s.skills.includes(sk));
              return (
                <tr key={sk} className="border-t border-border/50">
                  <td className="p-1 font-mono text-slate-300">{sk}</td>
                  {d.skills.map((s) => (
                    <td key={s.agent} className="p-1 text-center">
                      {s.skills.includes(sk) ? <span className="text-success">✓</span> : <button onClick={async () => { try { const r = await api<{ copiedTo: string }>('skills/copy', { method: 'POST', json: { from: from!.agent, skill: sk, to: s.agent } }); setMsg({ ok: true, text: `Copied to ${r.copiedTo}` }); void load(); } catch (e) { setMsg({ ok: false, text: (e as Error).message }); } }} className="rounded border border-border px-1 text-[10px] text-slate-400 hover:text-white">copy here</button>}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
        <Msg m={msg} />
      </div>
    </div>
  );
}

// ---------------- Claude readiness ----------------
export function ClaudeReadiness() {
  const router = useRouter();
  const [d, setD] = useState<{ cli: { path: string | null }; credentialsFilePresent: boolean; lastLimit: { endedAt: string; endStateDetail: string } | null; lastOk: { endedAt: string } | null; workersOnClaude: number; resumable: number; mcp: Record<string, string> } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    api<typeof d>('claude/status').then(setD).catch(() => undefined);
  }, []);
  if (!d) return null;
  return (
    <div className="rounded-xl border border-orange-400/30 bg-orange-400/5 p-4">
      <div className="mb-2 font-semibold text-orange-100">Ready for when your Claude account is back</div>
      <ul className="space-y-1 text-sm text-slate-300">
        <li>• Claude Code CLI: {d.cli.path ? <span className="font-mono text-xs text-success">{d.cli.path}</span> : <span className="text-warning">not found</span>}</li>
        <li>• Sign-in file present: {d.credentialsFilePresent ? 'yes (content is never read)' : 'no'}</li>
        <li>• Last successful Claude session: {d.lastOk ? fmtDate(d.lastOk.endedAt) : '—'}{d.lastLimit && <> · last limit/billing stop: {fmtDate(d.lastLimit.endedAt)} <span className="text-xs text-muted-foreground">({d.lastLimit.endStateDetail?.slice(0, 90)})</span></>}</li>
        <li>• {d.resumable} interrupted Claude session(s) can be resumed with one click (“Resume in Claude” on each session).</li>
        <li>• AI-organization roles using Claude Code: {d.workersOnClaude}</li>
      </ul>
      <div className="mt-3 flex flex-wrap gap-2">
        <button onClick={async () => { const r = await api<{ updated: number }>('org/executors', { method: 'POST', json: { executor: 'claude-code' } }); setMsg(`${r.updated} coding role(s) switched to Claude Code.`); router.refresh(); }} className={btnO}>Switch coding workers to Claude Code</button>
        <button onClick={() => { void navigator.clipboard.writeText(d.mcp['claude-code']); setMsg('Command copied: run it in a terminal to give Claude Code access to DevContinuity.'); }} className={btnO}>Copy “claude mcp add devcontinuity” command</button>
        <Link href="/sessions?agent=claude-code&endState=api_error" className={btnO}>Sessions stopped by limits</Link>
      </div>
      {msg && <div className="mt-2 text-xs text-success">{msg}</div>}
    </div>
  );
}
