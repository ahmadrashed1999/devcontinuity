'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Loader2, Sparkles } from 'lucide-react';
import { api, download, followJob, type JobState } from '@/lib/api';
import { fmtDate } from '@/lib/format';
import { cn } from '@/lib/utils';
import { JobProgress } from './import-center';

/** Runs an optional Anthropic analysis. Explains clearly when AI is not configured instead of failing silently. */
export function AiAnalyzeButton({ kind, id, label = 'Analyze with Claude' }: { kind: 'session' | 'project'; id: string; label?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <span className="inline-flex flex-col gap-1">
      <button
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setOut(null);
          try {
            const r = await api<{ model: string; cached: boolean; inputTokens: number; outputTokens: number }>(`ai/${kind}/${id}`, { method: 'POST' });
            setOut({ ok: true, text: `Done with ${r.model}${r.cached ? ' (cached result, no tokens used)' : ` (${r.inputTokens.toLocaleString()} in / ${r.outputTokens.toLocaleString()} out tokens)`}. Results are labelled AI-reported.` });
            router.refresh();
          } catch (e) {
            setOut({ ok: false, text: (e as Error).message });
          } finally {
            setBusy(false);
          }
        }}
        className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-primary/40 px-3 text-sm text-indigo-200 hover:bg-primary/10 disabled:opacity-50"
      >
        {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />} {label}
      </button>
      {out && <span className={cn('max-w-md text-xs', out.ok ? 'text-success' : 'text-warning')}>{out.text}</span>}
    </span>
  );
}

export function DiffViewer({ projectId, file }: { projectId: string; file?: string }) {
  const [diff, setDiff] = useState<{ diff: string; truncated: boolean } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset when the selected file changes
    setDiff(null);
    setErr(null);
    api<{ diff: string; truncated: boolean }>(`projects/${projectId}/diff${file ? `?file=${encodeURIComponent(file)}` : ''}`).then(setDiff).catch((e) => setErr((e as Error).message));
  }, [projectId, file]);
  if (err) return <div className="text-sm text-danger">{err}</div>;
  if (!diff) return <Loader2 className="size-4 animate-spin text-muted-foreground" />;
  if (!diff.diff.trim()) return <div className="text-sm text-muted-foreground">No unstaged diff for {file ?? 'the working tree'} (untracked or staged-only files have no unstaged diff).</div>;
  return (
    <pre className="max-h-[600px] overflow-auto rounded-lg bg-black/40 p-3 font-mono text-[11px] leading-relaxed">
      {diff.diff.split('\n').map((l, i) => (
        <div key={i} className={l.startsWith('+') && !l.startsWith('+++') ? 'text-green-400' : l.startsWith('-') && !l.startsWith('---') ? 'text-red-400' : l.startsWith('@@') ? 'text-cyan' : 'text-slate-400'}>
          {l || ' '}
        </div>
      ))}
      {diff.truncated && <div className="text-warning">Diff truncated.</div>}
    </pre>
  );
}

export function ChangedFiles({ projectId, changes }: { projectId: string; changes: { path: string; kind: string; staged: boolean }[] }) {
  const [file, setFile] = useState<string | undefined>(undefined);
  const [showAll, setShowAll] = useState(false);
  return (
    <div className="grid gap-4 lg:grid-cols-[340px_1fr]">
      <div className="max-h-[600px] overflow-auto rounded-lg border border-border">
        <button onClick={() => { setFile(undefined); setShowAll(true); }} className={cn('block w-full border-b border-border px-3 py-1.5 text-start text-xs', showAll && !file ? 'bg-primary/15 text-white' : 'text-slate-300 hover:bg-secondary')}>Whole working tree diff</button>
        {changes.map((c) => (
          <button key={c.path} onClick={() => { setFile(c.path); setShowAll(false); }} className={cn('flex w-full items-center gap-2 border-b border-border/50 px-3 py-1.5 text-start text-xs', file === c.path ? 'bg-primary/15 text-white' : 'text-slate-300 hover:bg-secondary')}>
            <span className={cn('w-16 shrink-0', c.kind === 'deleted' ? 'text-danger' : c.kind === 'untracked' || c.kind === 'added' ? 'text-success' : 'text-warning')}>{c.kind}</span>
            <span className="truncate font-mono">{c.path}</span>
          </button>
        ))}
      </div>
      <div>{file || showAll ? <DiffViewer projectId={projectId} file={file} /> : <div className="text-sm text-muted-foreground">Select a file to see its current diff (read-only `git diff`).</div>}</div>
    </div>
  );
}

interface SettingsData {
  aiConsent: boolean;
  aiModel: string;
  agentRoots: Record<string, string[]>;
  ai: { hasKey: boolean; envModel: string | null; detectedModel: string | null };
  adapters: { id: string; label: string; defaultRoots: string[] }[];
}

export function SettingsForm() {
  const [s, setS] = useState<SettingsData | null>(null);
  const [roots, setRoots] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [models, setModels] = useState<{ id: string; name: string }[] | null>(null);
  const [testing, setTesting] = useState(false);
  const load = async () => {
    const d = await api<SettingsData>('settings');
    setS(d);
    setRoots(Object.fromEntries(Object.entries(d.agentRoots).map(([k, v]) => [k, v.join('\n')])));
  };
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch
    void load();
  }, []);
  if (!s) return <Loader2 className="size-4 animate-spin" />;
  const save = async (patch: Record<string, unknown>) => {
    setMsg(null);
    try {
      await api('settings', { method: 'PUT', json: patch });
      setMsg({ ok: true, text: 'Saved.' });
      await load();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  };
  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-border bg-card p-5">
        <h2 className="mb-1 font-semibold text-white">Anthropic Claude API (optional)</h2>
        <p className="mb-4 text-sm text-muted-foreground">Used only for summaries, task/decision extraction and project analysis. Importing, browsing, search, handoffs and backups work without it. The API key is read from <code>ANTHROPIC_API_KEY</code> on the server and is never sent to the browser.</p>
        <div className="grid gap-3 text-sm md:grid-cols-3">
          <div className="rounded-lg bg-background/60 p-3"><div className="text-xs text-muted-foreground">API key</div><div className={s.ai.hasKey ? 'text-success' : 'text-warning'}>{s.ai.hasKey ? 'Configured (ANTHROPIC_API_KEY)' : 'Not set'}</div></div>
          <div className="rounded-lg bg-background/60 p-3"><div className="text-xs text-muted-foreground">ANTHROPIC_MODEL</div><div className="font-mono text-slate-200">{s.ai.envModel ?? '(not set)'}</div></div>
          <div className="rounded-lg bg-background/60 p-3"><div className="text-xs text-muted-foreground">Effective model</div><div className="font-mono text-slate-200">{s.aiModel || s.ai.envModel || s.ai.detectedModel || 'auto-detect on first use'}</div></div>
        </div>
        {!s.ai.hasKey && <div className="mt-3 rounded-lg border border-warning/25 bg-warning/5 p-3 text-sm text-amber-100/90">To enable AI features, create <code>.env.local</code> in the DevContinuity folder containing <code>ANTHROPIC_API_KEY=…</code> (and optionally <code>ANTHROPIC_MODEL=…</code>), then restart the app.</div>}
        <label className="mt-4 flex items-center gap-2 text-sm">
          <input type="checkbox" checked={s.aiConsent} onChange={(e) => save({ aiConsent: e.target.checked })} />
          Allow DevContinuity to send selected, secret-redacted transcript excerpts to the Anthropic API when I click an AI action
        </label>
        <div className="mt-4 flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            Model override (blank = ANTHROPIC_MODEL, then auto-detect)
            <input defaultValue={s.aiModel} id="aiModel" list="model-list" className="h-8 w-72 rounded-md border border-border bg-background px-2 font-mono text-sm text-slate-200" />
            <datalist id="model-list">{models?.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</datalist>
          </label>
          <button onClick={() => save({ aiModel: (document.getElementById('aiModel') as HTMLInputElement).value })} className="h-8 rounded-lg bg-secondary px-3 text-sm">Save model</button>
          <button disabled={!s.ai.hasKey} onClick={async () => { try { setModels(await api('ai/models')); } catch (e) { setMsg({ ok: false, text: (e as Error).message }); } }} className="h-8 rounded-lg border border-border px-3 text-sm disabled:opacity-50">List available models</button>
          <button
            disabled={!s.ai.hasKey || testing}
            onClick={async () => {
              setTesting(true);
              try {
                const r = await api<{ model: string; reply: string }>('ai/test', { method: 'POST' });
                setMsg({ ok: true, text: `Connection OK: ${r.model} replied "${r.reply}".` });
              } catch (e) {
                setMsg({ ok: false, text: (e as Error).message });
              } finally {
                setTesting(false);
              }
            }}
            className="h-8 rounded-lg border border-primary/40 px-3 text-sm text-indigo-200 disabled:opacity-50"
          >
            {testing ? 'Testing…' : 'Test connection'}
          </button>
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-5">
        <h2 className="mb-1 font-semibold text-white">Agent data directories</h2>
        <p className="mb-4 text-sm text-muted-foreground">Defaults are detected automatically (including <code>CLAUDE_CONFIG_DIR</code> and <code>CODEX_HOME</code>). Add extra folders, one per line, for example a .claude folder copied from another computer. These folders are only read.</p>
        <div className="space-y-3">
          {s.adapters.map((a) => (
            <div key={a.id} className="grid gap-2 md:grid-cols-[180px_1fr]">
              <div>
                <div className="text-sm font-medium text-slate-200">{a.label}</div>
                <div className="font-mono text-[11px] text-muted-foreground">{a.defaultRoots.join(', ')}</div>
              </div>
              <textarea rows={2} value={roots[a.id] ?? ''} onChange={(e) => setRoots({ ...roots, [a.id]: e.target.value })} placeholder="Additional folders (optional)" className="rounded-md border border-border bg-background p-2 font-mono text-xs" />
            </div>
          ))}
        </div>
        <button onClick={() => save({ agentRoots: Object.fromEntries(Object.entries(roots).map(([k, v]) => [k, v.split('\n').map((x) => x.trim()).filter(Boolean)])) })} className="mt-3 h-8 rounded-lg bg-primary px-3 text-sm text-white">Save directories</button>
      </section>
      {msg && <div className={cn('rounded-lg border px-3 py-2 text-sm', msg.ok ? 'border-success/30 bg-success/10 text-green-200' : 'border-danger/30 bg-danger/10 text-red-200')}>{msg.text}</div>}
    </div>
  );
}

export function BackupPanel({ backups }: { backups: { id: string; filePath: string; sizeMb: number; kind: string; note: string | null; includesArchives: boolean; createdAt: string; exists: boolean }[] }) {
  const router = useRouter();
  const [job, setJob] = useState<JobState | null>(null);
  const [note, setNote] = useState('');
  const [full, setFull] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const stop = useRef<() => void>(() => {});
  useEffect(() => () => stop.current(), []);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card p-4">
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" className="h-8 w-64 rounded-md border border-border bg-background px-2 text-sm" />
        <label className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={full} onChange={(e) => setFull(e.target.checked)} /> Include archived transcripts (large)</label>
        <button
          disabled={job?.status === 'running'}
          onClick={async () => {
            setMsg(null);
            try {
              const r = await api<{ jobId: string }>('backups', { method: 'POST', json: { note, includeArchives: full } });
              stop.current = followJob(r.jobId, (j) => {
                setJob(j);
                if (j.status !== 'running') router.refresh();
              });
            } catch (e) {
              setMsg({ ok: false, text: (e as Error).message });
            }
          }}
          className="h-8 rounded-lg bg-primary px-3 text-sm font-medium text-white disabled:opacity-50"
        >
          Create backup now
        </button>
      </div>
      {job && <JobProgress job={job} />}
      {msg && <div className={cn('rounded-lg border px-3 py-2 text-sm', msg.ok ? 'border-success/30 bg-success/10 text-green-200' : 'border-danger/30 bg-danger/10 text-red-200')}>{msg.text}</div>}
      <div className="overflow-hidden rounded-xl border border-border">
        <table className="w-full text-sm">
          <thead className="bg-card text-xs text-muted-foreground">
            <tr><th className="p-2 text-start">Created</th><th className="p-2 text-start">File</th><th className="p-2 text-end">Size</th><th className="p-2 text-start">Contents</th><th className="p-2" /></tr>
          </thead>
          <tbody>
            {backups.map((b) => (
              <tr key={b.id} className="border-t border-border">
                <td className="p-2 whitespace-nowrap">{fmtDate(b.createdAt)}</td>
                <td className="p-2 font-mono text-xs text-slate-400">{b.filePath.split(/[\\/]/).pop()}{b.note && <div className="font-sans text-slate-300">{b.note}</div>}{!b.exists && <div className="text-danger">file missing</div>}</td>
                <td className="p-2 text-end tabular-nums">{b.sizeMb.toFixed(1)} MB</td>
                <td className="p-2 text-xs">{b.includesArchives ? 'database + knowledge + handoffs + transcript archive' : 'database + knowledge + handoffs'}</td>
                <td className="p-2 text-end whitespace-nowrap">
                  <button disabled={!b.exists} onClick={() => download(`/api/backups/${b.id}/download`)} className="me-2 h-7 rounded-md border border-border px-2 text-xs disabled:opacity-40">Download</button>
                  <button
                    disabled={!b.exists}
                    onClick={async () => {
                      if (window.prompt('Restoring replaces the current DevContinuity database (the current one is kept in data/pre-restore). Type RESTORE to continue.') !== 'RESTORE') return;
                      try {
                        const r = await api<{ previousDatabaseKeptIn: string }>(`backups/${b.id}/restore`, { method: 'POST', json: { confirm: 'RESTORE' } });
                        setMsg({ ok: true, text: `Restored. Previous database kept in ${r.previousDatabaseKeptIn}.` });
                        router.refresh();
                      } catch (e) {
                        setMsg({ ok: false, text: (e as Error).message });
                      }
                    }}
                    className="h-7 rounded-md border border-warning/40 px-2 text-xs text-warning disabled:opacity-40"
                  >
                    Restore
                  </button>
                </td>
              </tr>
            ))}
            {backups.length === 0 && <tr><td colSpan={5} className="p-6 text-center text-muted-foreground">No backups yet.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function DocViewer({ projectId, docs }: { projectId: string; docs: { docType: string; content: string; source: string; generatedAt: string }[] }) {
  const router = useRouter();
  const [active, setActive] = useState(docs[0]?.docType ?? '');
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const doc = docs.find((d) => d.docType === active);
  return (
    <div className="grid gap-4 lg:grid-cols-[220px_1fr]">
      <div className="space-y-1">
        {docs.map((d) => (
          <button key={d.docType} onClick={() => { setActive(d.docType); setEditing(false); }} className={cn('block w-full rounded-md px-2 py-1.5 text-start font-mono text-xs', active === d.docType ? 'bg-primary/15 text-white' : 'text-slate-400 hover:bg-secondary')}>
            {d.docType}.md{d.source === 'manual' && <span className="ms-1 text-warning">edited</span>}
          </button>
        ))}
      </div>
      {doc && (
        <div>
          <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
            {doc.source === 'manual' ? 'Edited by you; regeneration keeps your version' : 'Generated'} · {fmtDate(doc.generatedAt)}
            <button onClick={() => { setText(doc.content); setEditing(!editing); }} className="ms-auto h-7 rounded-md border border-border px-2 text-xs text-slate-200">{editing ? 'Cancel' : 'Edit'}</button>
            {editing && <button onClick={async () => { await api(`projects/${projectId}/docs/${doc.docType}`, { method: 'PUT', json: { content: text } }); setEditing(false); router.refresh(); }} className="h-7 rounded-md bg-primary px-2 text-xs text-white">Save</button>}
          </div>
          {editing ? <textarea value={text} onChange={(e) => setText(e.target.value)} rows={30} className="w-full rounded-lg border border-border bg-background p-3 font-mono text-xs" /> : <pre className="max-h-[700px] overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-background/60 p-4 font-mono text-xs leading-relaxed text-slate-300">{doc.content}</pre>}
        </div>
      )}
    </div>
  );
}
