'use client';

import { useCallback, useEffect, useState } from 'react';
import { Copy, Download, FileArchive, FolderInput, Loader2, ShieldCheck, Sparkles } from 'lucide-react';
import { api, download } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useT } from './lang';
import { CopyReviewed, ReviewDialog, type ReviewFile, type ReviewResult } from './review';

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

function saveText(text: string, name: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * The one-click "continue anywhere" flow: pick an agent, get a ready-to-paste briefing for the
 * whole project or one session, then copy it, download it, build the ZIP package, or drop it
 * into the repository so any agent started there can find it. Every one of these first shows the
 * exact text in the "review before sharing" step.
 */
export function ContinuePanel({ projectId, sessionId, compact = false, initialAgent }: { projectId?: string; sessionId?: string; compact?: boolean; initialAgent?: string }) {
  const { t } = useT();
  const [agent, setAgent] = useState(AGENTS.some((a) => a.id === initialAgent) ? (initialAgent as string) : 'opencode');
  const [data, setData] = useState<ResumeResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [review, setReview] = useState<{ mode: 'prompt' | 'package'; files: ReviewFile[] } | null>(null);

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
  }, [load]);

  const reviewPackage = async () => {
    setBusy('preview');
    setResult(null);
    try {
      const r = await api<{ files: ReviewFile[] }>('handoffs/preview', { method: 'POST', json: { projectId, sessionId, targetAgent: agent } });
      // The target agent's briefing first: it is what gets pasted.
      const first = `prompts/${agent}.md`;
      setReview({ mode: 'package', files: [...r.files.filter((f) => f.name === first), ...r.files.filter((f) => f.name !== first)] });
    } catch (e) {
      setResult({ kind: 'err', text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const buildPackage = async (r: ReviewResult, andDropIn: boolean) => {
    setBusy(andDropIn ? 'dropin' : 'zip');
    setResult(null);
    const original = new Map(review?.files.map((f) => [f.name, f.text]));
    const overrides = Object.fromEntries(r.files.filter((f) => f.text !== original.get(f.name)).map((f) => [f.name, f.text]));
    setReview(null);
    try {
      const h = await api<{ id: string }>('handoffs', { method: 'POST', json: { projectId, sessionId, targetAgent: agent, overrides } });
      if (andDropIn) {
        const d = await api<{ targetDir: string; note: string }>(`handoffs/${h.id}/dropin`, { method: 'POST' });
        setResult({ kind: 'ok', text: `Placed in ${d.targetDir}. Tell any agent started in the repository: "Read .devcontinuity/RESUME.md and continue." ${d.note}` });
      } else {
        download(`/api/handoffs/${h.id}/download`);
        setResult({ kind: 'ok', text: 'Handoff package built from the reviewed files. The ZIP download has started.' });
      }
    } catch (e) {
      setResult({ kind: 'err', text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const btn = 'inline-flex h-9 items-center gap-2 rounded-lg border border-border px-3 text-sm text-slate-200 hover:bg-secondary disabled:opacity-50';

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
        <button onClick={() => data && setReview({ mode: 'prompt', files: [{ name: `RESUME-${agent}.md`, text: data.prompt }] })} disabled={!data} className="inline-flex h-9 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-white hover:bg-primary/85 disabled:opacity-50">
          <Copy className="size-4" /> {t.continueReviewCopy}
        </button>
        <button onClick={reviewPackage} disabled={!!busy || (!projectId && !sessionId)} className={btn}>
          {busy === 'preview' || busy === 'zip' || busy === 'dropin' ? <Loader2 className="size-4 animate-spin" /> : <FileArchive className="size-4" />} {t.continueReviewPackage}
        </button>
        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground"><ShieldCheck className="size-3.5 text-cyan" /> {t.continueReviewHint}</span>
      </div>

      {result && <div className={cn('rounded-lg border px-3 py-2 text-sm', result.kind === 'ok' ? 'border-success/30 bg-success/10 text-green-200' : 'border-danger/30 bg-danger/10 text-red-200')}>{result.text}</div>}
      {error && <div className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-red-200">{error}</div>}

      {loading && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> {t.continueLoading}
        </div>
      )}
      {data && !loading && (
        <>
          {!compact && data.context.nextSteps.length > 0 && (
            <div className="rounded-lg border border-border bg-background/50 p-3">
              <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <Sparkles className="size-3.5 text-cyan" /> {t.continueNextSteps}
              </div>
              <ol className="list-decimal space-y-1 ps-5 text-sm text-slate-300">
                {data.context.nextSteps.slice(0, 6).map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ol>
            </div>
          )}
          <details className="rounded-lg border border-border bg-background/50" open={!compact}>
            <summary className="cursor-pointer px-3 py-2 text-sm text-slate-300">{t.continuePreview.replace('{n}', data.prompt.length.toLocaleString())}</summary>
            <pre className="max-h-[480px] overflow-auto whitespace-pre-wrap border-t border-border p-3 font-mono text-xs leading-relaxed text-slate-300" dir="ltr">{data.prompt}</pre>
          </details>
        </>
      )}

      {review && (
        <ReviewDialog
          files={review.files}
          onClose={() => setReview(null)}
          actions={(r) =>
            review.mode === 'prompt' ? (
              <>
                <button onClick={() => r.files[0].text && saveText(r.files[0].text, review.files[0].name)} disabled={!r.files[0].text} className={btn}>
                  <Download className="size-4" /> {t.reviewDownload}
                </button>
                <CopyReviewed text={r.files[0].text} onDone={() => { setReview(null); setResult({ kind: 'ok', text: t.continueCopied }); }} />
              </>
            ) : (
              <>
                <button onClick={() => buildPackage(r, true)} title="Writes only into <repo>/.devcontinuity/. Never overwrites files." className="inline-flex h-9 items-center gap-2 rounded-lg border border-cyan/40 px-3 text-sm text-cyan hover:bg-cyan/10">
                  <FolderInput className="size-4" /> {t.reviewDropIn}
                </button>
                <button onClick={() => buildPackage(r, false)} className="inline-flex h-9 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-white hover:bg-primary/85">
                  <FileArchive className="size-4" /> {t.reviewBuildZip}
                </button>
              </>
            )
          }
        />
      )}
    </div>
  );
}
