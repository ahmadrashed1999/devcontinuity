'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, FolderSearch, Loader2, ShieldCheck, Upload, XCircle } from 'lucide-react';
import { api, followJob, type JobState } from '@/lib/api';
import { fmtBytes, fmtDate } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useT } from './lang';

interface Inv {
  agent: string;
  label: string;
  root: string;
  exists: boolean;
  assets: { kind: string; label: string; count: number; bytes: number; archived: boolean; note?: string }[];
  notes: string[];
  unrecoverable: string[];
  errors: string[];
  validation: { readable: number; unreadable: number; empty: number };
  sessionCount: number;
  subagentCount: number;
  totalBytes: number;
  alreadyImported: number;
  changedSinceImport: number;
  newSessions: number;
  projectDirs: { name: string; sessions: number; subagents: number; bytes: number; lastWrite?: string }[];
}

export function JobProgress({ job }: { job: JobState }) {
  const pct = job.total ? Math.round((job.progress / job.total) * 100) : job.status === 'running' ? 5 : 100;
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-center gap-2 text-sm">
        {job.status === 'running' ? <Loader2 className="size-4 animate-spin text-primary" /> : job.status === 'completed' ? <CheckCircle2 className="size-4 text-success" /> : <XCircle className="size-4 text-danger" />}
        <span className="font-medium capitalize text-slate-200">{job.type} {job.status}</span>
        <span className="ms-auto tabular-nums text-muted-foreground">{job.total ? `${job.progress}/${job.total}` : ''}</span>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-secondary">
        <div className={cn('h-full transition-all', job.status === 'failed' ? 'bg-danger' : 'bg-gradient-to-r from-primary to-cyan')} style={{ width: `${pct}%` }} />
      </div>
      <div className="mt-2 truncate text-xs text-muted-foreground">{job.message}</div>
      {job.error && <div className="mt-2 text-sm text-danger">{job.error}</div>}
      {job.log.length > 0 && <pre className="mt-3 max-h-48 overflow-auto rounded-md bg-black/40 p-2 font-mono text-[11px] text-slate-400">{job.log.slice(-40).join('\n')}</pre>}
    </div>
  );
}

export function ImportCenter({ projects }: { projects: { id: string; name: string }[] }) {
  const { t } = useT();
  const router = useRouter();
  const [inv, setInv] = useState<Inv[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [job, setJob] = useState<JobState | null>(null);
  const [selected, setSelected] = useState<string[]>(['claude-code', 'opencode', 'codex', 'antigravity', 'cline', 'copilot', 'continue', 'cursor', 'live']);
  const [force, setForce] = useState(false);
  const [root, setRoot] = useState('');
  const [rootAgent, setRootAgent] = useState('claude-code');
  const [upAgent, setUpAgent] = useState('generic');
  const [upProject, setUpProject] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const stop = useRef<() => void>(() => {});

  const scan = async () => {
    setScanning(true);
    setErr(null);
    try {
      setInv(await api<Inv[]>('inventory'));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setScanning(false);
    }
  };
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial read-only scan on mount
    void scan();
    return () => stop.current();
  }, []);

  const follow = (jobId: string) => {
    stop.current();
    stop.current = followJob(jobId, (j) => {
      setJob(j);
      if (j.status !== 'running') {
        void scan();
        router.refresh();
      }
    });
  };

  const start = async (extra: Record<string, unknown> = {}) => {
    setErr(null);
    try {
      const r = await api<{ jobId: string }>('import', { method: 'POST', json: { agents: selected, force, ...extra } });
      follow(r.jobId);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const upload = async () => {
    const f = fileRef.current?.files?.[0];
    if (!f) return;
    const fd = new FormData();
    fd.set('file', f);
    fd.set('agent', upAgent);
    if (upProject) fd.set('projectId', upProject);
    setErr(null);
    try {
      const res = await fetch('/api/upload', { method: 'POST', body: fd, credentials: 'same-origin' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      follow(data.jobId);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const running = job?.status === 'running';
  return (
    <div className="space-y-6">
      <div className="flex items-start gap-3 rounded-xl border border-success/25 bg-success/5 p-4 text-sm text-green-100/90">
        <ShieldCheck className="mt-0.5 size-5 shrink-0 text-success" />
        <div>
          <b>{t.icSafeTitle}</b> {t.icSafeBody}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button onClick={scan} disabled={scanning} className="inline-flex h-9 items-center gap-2 rounded-lg border border-border px-3 text-sm hover:bg-secondary disabled:opacity-50">
          {scanning ? <Loader2 className="size-4 animate-spin" /> : <FolderSearch className="size-4" />} {t.icRescan}
        </button>
        <button onClick={() => start()} disabled={running || !inv} className="inline-flex h-9 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-white hover:bg-primary/85 disabled:opacity-50">
          {running ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />} {t.icImportSelected}
        </button>
        <label className="flex items-center gap-1.5 text-sm text-slate-300">
          <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} /> Re-import unchanged sessions
        </label>
        {running && job && <button onClick={() => api(`jobs/${job.id}/cancel`, { method: 'POST' })} className="h-9 rounded-lg border border-danger/40 px-3 text-sm text-danger">Cancel</button>}
      </div>
      {err && <div className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-red-200">{err}</div>}
      {job && <JobProgress job={job} />}

      <div className="grid gap-4 xl:grid-cols-2">
        {inv?.map((i) => (
          <div key={`${i.agent}:${i.root}`} className={cn('rounded-xl border bg-card p-4', i.exists ? 'border-border' : 'border-dashed border-border opacity-70')}>
            <div className="flex items-start gap-3">
              <input type="checkbox" className="mt-1" disabled={!i.exists} checked={selected.includes(i.agent)} onChange={(e) => setSelected((s) => (e.target.checked ? [...new Set([...s, i.agent])] : s.filter((x) => x !== i.agent)))} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-white">{i.label}</span>
                  {!i.exists && <span className="text-xs text-muted-foreground">not found on this machine</span>}
                </div>
                <div className="truncate font-mono text-xs text-muted-foreground">{i.root}</div>
              </div>
            </div>
            {i.exists && (
              <>
                <div className="mt-3 grid grid-cols-2 gap-2 text-center sm:grid-cols-4">
                  {[
                    ['Sessions', `${i.sessionCount - i.subagentCount}${i.subagentCount ? ` + ${i.subagentCount} sub` : ''}`],
                    ['Size', fmtBytes(i.totalBytes)],
                    ['Imported', String(i.alreadyImported)],
                    ['New / changed', `${i.newSessions} / ${i.changedSinceImport}`],
                  ].map(([k, v]) => (
                    <div key={k} className="rounded-lg bg-background/60 p-2">
                      <div className="text-[10px] uppercase text-muted-foreground">{k}</div>
                      <div className="text-sm font-semibold tabular-nums text-slate-200">{v}</div>
                    </div>
                  ))}
                </div>
                <div className="mt-2 text-xs text-muted-foreground">Validation: {i.validation.readable} readable, {i.validation.unreadable} unreadable, {i.validation.empty} empty</div>
                <table className="mt-3 w-full text-xs">
                  <tbody>
                    {i.assets.map((a) => (
                      <tr key={a.kind} className="border-t border-border/60">
                        <td className="py-1 pe-2">{a.archived ? <span className="text-success">copy</span> : <span className="text-slate-500">skip</span>}</td>
                        <td className="py-1 text-slate-300">
                          {a.label}
                          {a.note && <div className="text-[11px] text-muted-foreground">{a.note}</div>}
                        </td>
                        <td className="py-1 text-end tabular-nums text-muted-foreground">{a.count} · {fmtBytes(a.bytes)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {i.unrecoverable.length > 0 && (
                  <div className="mt-3 rounded-lg border border-warning/25 bg-warning/5 p-2.5">
                    <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-warning"><AlertTriangle className="size-3.5" /> {t.icCannotRecover}</div>
                    <ul className="list-disc space-y-0.5 ps-4 text-xs text-amber-100/80">
                      {i.unrecoverable.map((u) => <li key={u}>{u}</li>)}
                    </ul>
                  </div>
                )}
                {i.errors.length > 0 && <div className="mt-2 text-xs text-danger">{i.errors.slice(0, 5).join(' · ')}</div>}
                {i.projectDirs.length > 0 && (
                  <details className="mt-3">
                    <summary className="cursor-pointer text-xs text-slate-400">{t.icDiscovered.replace('{n}', String(i.projectDirs.length))}</summary>
                    <div className="mt-2 max-h-64 overflow-auto">
                      <table className="w-full text-[11px]">
                        <tbody>
                          {i.projectDirs.map((d) => (
                            <tr key={d.name} className="border-t border-border/50">
                              <td className="py-0.5 pe-2 font-mono text-slate-400">{d.name}</td>
                              <td className="whitespace-nowrap py-0.5 text-end tabular-nums text-muted-foreground">{d.sessions}{d.subagents ? ` + ${d.subagents}` : ''} · {fmtBytes(d.bytes)} · {fmtDate(d.lastWrite, false)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </details>
                )}
              </>
            )}
          </div>
        ))}
        {!inv && scanning && <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> {t.icScanning}</div>}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="mb-1 font-semibold text-white">{t.icFolderTitle}</div>
          <p className="mb-3 text-xs text-muted-foreground">{t.icFolderHelp}</p>
          <div className="flex flex-wrap gap-2">
            <select value={rootAgent} onChange={(e) => setRootAgent(e.target.value)} className="h-8 rounded-md border border-border bg-background px-2 text-sm">
              {['claude-code', 'codex', 'opencode', 'antigravity', 'cline', 'copilot', 'continue', 'cursor', 'aider', 'zed', 'generic'].map((a) => <option key={a}>{a}</option>)}
            </select>
            <input value={root} onChange={(e) => setRoot(e.target.value)} placeholder="D:\\old-laptop\\.claude" className="h-8 min-w-64 flex-1 rounded-md border border-border bg-background px-2 font-mono text-sm" />
            <button disabled={!root.trim() || running} onClick={() => start({ root, rootAgent, onlyRoot: true, agents: [rootAgent] })} className="h-8 rounded-lg bg-secondary px-3 text-sm disabled:opacity-50">{t.icImportFolder}</button>
          </div>
        </div>
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="mb-1 font-semibold text-white">{t.icUploadTitle}</div>
          <p className="mb-3 text-xs text-muted-foreground">{t.icUploadHelp}</p>
          <div className="flex flex-wrap gap-2">
            <select value={upAgent} onChange={(e) => setUpAgent(e.target.value)} className="h-8 rounded-md border border-border bg-background px-2 text-sm">
              <option value="generic">{t.icGeneric}</option>
              <option value="claude-code">{t.icClaudeTranscript}</option>
              <option value="chatgpt">{t.icChatgpt}</option>
              <option value="claude-ai">{t.icClaudeAi}</option>
            </select>
            <select value={upProject} onChange={(e) => setUpProject(e.target.value)} className="h-8 max-w-48 rounded-md border border-border bg-background px-2 text-sm">
              <option value="">{t.icDetectProject}</option>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <input ref={fileRef} type="file" accept=".json,.jsonl,.ndjson,.zip" className="text-sm file:me-2 file:rounded-md file:border-0 file:bg-secondary file:px-2 file:py-1 file:text-slate-200" />
            <button disabled={running} onClick={upload} className="h-8 rounded-lg bg-secondary px-3 text-sm disabled:opacity-50">{t.icUpload}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
