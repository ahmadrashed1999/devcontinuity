'use client';

import { useCallback, useEffect, useState } from 'react';
import { Check, Copy, Download, FileArchive, FolderInput, Loader2, Sparkles } from 'lucide-react';
import { api, download } from '@/lib/api';
import { cn } from '@/lib/utils';

const AGENTS = [
  { id: 'claude-code', label: 'Claude Code' },
  { id: 'opencode', label: 'OpenCode' },
  { id: 'codex', label: 'Codex CLI' },
  { id: 'cursor', label: 'Cursor' },
  { id: 'generic', label: 'Any AI / chat model' },
];

interface ResumeResponse {
  prompt: string;
  context: { project: { name: string; rootPath: string } | null; focus: { title: string | null; endState: string; agentLabel: string } | null; nextSteps: string[]; taskCounts: Record<string, number> };
}

/**
 * The one-click "continue anywhere" flow: pick an agent, get a ready-to-paste briefing for the
 * whole project or one session, then copy it, download it, build the ZIP package, or drop it
 * into the repository so any agent started there can find it.
 */
export function ContinuePanel({ projectId, sessionId, compact = false }: { projectId?: string; sessionId?: string; compact?: boolean }) {
  const [agent, setAgent] = useState('opencode');
  const [data, setData] = useState<ResumeResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [handoffId, setHandoffId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!projectId && !sessionId) return;
    setLoading(true);
    setError(null);
    try {
      const p = new URLSearchParams({ agent });
      if (projectId) p.set('projectId', projectId);
      if (sessionId) p.set('sessionId', sessionId);
      setData(await api<ResumeResponse>(`resume?${p}`));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [agent, projectId, sessionId]);

  useEffect(() => {
    // Fetch on mount / when the target changes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    setHandoffId(null);
  }, [load]);

  const copy = async () => {
    if (!data) return;
    await navigator.clipboard.writeText(data.prompt);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  const saveMd = () => {
    if (!data) return;
    const blob = new Blob([data.prompt], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `RESUME-${agent}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const makeHandoff = async (andDropIn = false) => {
    setBusy(andDropIn ? 'dropin' : 'zip');
    setResult(null);
    try {
      let id = handoffId;
      if (!id) {
        const h = await api<{ id: string; zipPath: string }>('handoffs', { method: 'POST', json: { projectId, sessionId, targetAgent: agent } });
        id = h.id;
        setHandoffId(id);
      }
      if (andDropIn) {
        const r = await api<{ targetDir: string; note: string }>(`handoffs/${id}/dropin`, { method: 'POST' });
        setResult({ kind: 'ok', text: `Placed in ${r.targetDir}. Tell any agent started in the repository: "Read .devcontinuity/RESUME.md and continue." ${r.note}` });
      } else {
        download(`/api/handoffs/${id}/download`);
        setResult({ kind: 'ok', text: 'Handoff package built. The ZIP download has started.' });
      }
    } catch (e) {
      setResult({ kind: 'err', text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-1.5">
        {AGENTS.map((a) => (
          <button key={a.id} onClick={() => setAgent(a.id)} className={cn('rounded-lg border px-3 py-1.5 text-sm transition-colors', agent === a.id ? 'border-primary bg-primary/20 text-white' : 'border-border text-slate-300 hover:bg-secondary')}>
            {a.label}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap gap-2">
        <button onClick={copy} disabled={!data} className="inline-flex h-9 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-white hover:bg-primary/85 disabled:opacity-50">
          {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
          {copied ? 'Copied: paste it into the agent' : 'Copy continuation prompt'}
        </button>
        <button onClick={saveMd} disabled={!data} className="inline-flex h-9 items-center gap-2 rounded-lg border border-border px-3 text-sm text-slate-200 hover:bg-secondary disabled:opacity-50">
          <Download className="size-4" /> Save as .md
        </button>
        <button onClick={() => makeHandoff(false)} disabled={!!busy || (!projectId && !sessionId)} className="inline-flex h-9 items-center gap-2 rounded-lg border border-border px-3 text-sm text-slate-200 hover:bg-secondary disabled:opacity-50">
          {busy === 'zip' ? <Loader2 className="size-4 animate-spin" /> : <FileArchive className="size-4" />} Download handoff ZIP
        </button>
        <button onClick={() => makeHandoff(true)} disabled={!!busy} title="Writes only into <repo>/.devcontinuity/. Never overwrites files." className="inline-flex h-9 items-center gap-2 rounded-lg border border-cyan/40 px-3 text-sm text-cyan hover:bg-cyan/10 disabled:opacity-50">
          {busy === 'dropin' ? <Loader2 className="size-4 animate-spin" /> : <FolderInput className="size-4" />} Put in project folder
        </button>
      </div>

      {result && <div className={cn('rounded-lg border px-3 py-2 text-sm', result.kind === 'ok' ? 'border-success/30 bg-success/10 text-green-200' : 'border-danger/30 bg-danger/10 text-red-200')}>{result.text}</div>}
      {error && <div className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-red-200">{error}</div>}

      {loading && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Reconstructing context from transcripts, files and Git…
        </div>
      )}
      {data && !loading && (
        <>
          {!compact && data.context.nextSteps.length > 0 && (
            <div className="rounded-lg border border-border bg-background/50 p-3">
              <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <Sparkles className="size-3.5 text-cyan" /> Recommended next steps (derived from recorded facts)
              </div>
              <ol className="list-decimal space-y-1 ps-5 text-sm text-slate-300">
                {data.context.nextSteps.slice(0, 6).map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ol>
            </div>
          )}
          <details className="rounded-lg border border-border bg-background/50" open={!compact}>
            <summary className="cursor-pointer px-3 py-2 text-sm text-slate-300">Preview the prompt ({data.prompt.length.toLocaleString()} characters)</summary>
            <pre className="max-h-[480px] overflow-auto whitespace-pre-wrap border-t border-border p-3 font-mono text-xs leading-relaxed text-slate-300">{data.prompt}</pre>
          </details>
        </>
      )}
    </div>
  );
}
