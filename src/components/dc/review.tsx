'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { AlertTriangle, Check, FileText, ShieldCheck, X } from 'lucide-react';
import { assemble, findSensitive, highlightRuns, splitSections, summarize, type FindingKind } from '@/lib/review';
import { cn } from '@/lib/utils';
import { useT } from './lang';

export interface ReviewFile {
  name: string;
  text: string;
}

export interface ReviewResult {
  /** Final text per file; null when the whole file was left out. */
  files: { name: string; text: string | null }[];
}

const MARK: Record<FindingKind, string> = {
  redacted: 'bg-emerald-500/20 text-emerald-200 ring-1 ring-emerald-400/40',
  secret: 'bg-red-500/25 text-red-100 ring-1 ring-red-400/50',
  email: 'bg-amber-500/20 text-amber-100 ring-1 ring-amber-400/40',
  path: 'bg-sky-500/20 text-sky-100 ring-1 ring-sky-400/40',
};

function Highlighted({ text }: { text: string }) {
  return (
    <>
      {highlightRuns(text).map((r, i) => (r.kind ? <mark key={i} className={cn('rounded px-0.5', MARK[r.kind])} data-kind={r.kind}>{r.text}</mark> : <span key={i}>{r.text}</span>))}
    </>
  );
}

/**
 * "Review before sharing": shows the exact text that is about to be copied or exported, highlights
 * what the redactor replaced and anything that still looks secret or personal, and lets the owner
 * leave out whole sections (or whole files of a handoff package) first.
 */
export function ReviewDialog({ title, files, onClose, actions }: { title?: string; files: ReviewFile[]; onClose: () => void; actions: (result: ReviewResult, removedCount: number) => ReactNode }) {
  const { t } = useT();
  const parsed = useMemo(() => files.map((f) => ({ ...f, sections: splitSections(f.text) })), [files]);
  const [removed, setRemoved] = useState<Record<string, Set<string>>>({});
  const [omitted, setOmitted] = useState<Set<string>>(new Set());
  const [active, setActive] = useState(files[0]?.name ?? '');
  const current = parsed.find((f) => f.name === active) ?? parsed[0];
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const result: ReviewResult = {
    files: parsed.map((f) => ({ name: f.name, text: omitted.has(f.name) ? null : assemble(f.sections, removed[f.name] ?? []) })),
  };
  const removedCount = Object.values(removed).reduce((a, s) => a + s.size, 0) + omitted.size;
  const totals = summarize(result.files.flatMap((f) => (f.text ? findSensitive(f.text) : [])));
  const toggle = (file: string, id: string) =>
    setRemoved((r) => {
      const s = new Set(r[file] ?? []);
      if (s.has(id)) s.delete(id);
      else s.add(id);
      return { ...r, [file]: s };
    });

  const badge = (kind: FindingKind, label: string) => totals[kind] > 0 && (
    <span key={kind} className={cn('rounded-md px-2 py-0.5 text-xs', MARK[kind])}>
      {totals[kind]} {label}
    </span>
  );

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center sm:items-center" role="dialog" aria-modal="true" aria-label={title ?? t.reviewTitle}>
      <button className="absolute inset-0 bg-black/70 backdrop-blur-sm" aria-label={t.close} onClick={onClose} />
      <div className="relative flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-t-2xl border border-border bg-card shadow-2xl sm:rounded-2xl">
        <div className="flex items-start gap-3 border-b border-border px-4 py-3">
          <ShieldCheck className="mt-0.5 size-5 shrink-0 text-cyan" />
          <div className="min-w-0 flex-1">
            <h2 className="font-semibold text-white">{title ?? t.reviewTitle}</h2>
            <p className="text-xs text-muted-foreground">{t.reviewIntro}</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {badge('redacted', t.reviewRedacted)}
              {badge('secret', t.reviewSecret)}
              {badge('email', t.reviewEmail)}
              {badge('path', t.reviewPath)}
              {totals.redacted + totals.secret + totals.email + totals.path === 0 && <span className="text-xs text-success">{t.reviewNothing}</span>}
              {removedCount > 0 && <span className="rounded-md bg-secondary px-2 py-0.5 text-xs text-slate-300">{t.reviewRemoved.replace('{n}', String(removedCount))}</span>}
            </div>
          </div>
          <button onClick={onClose} className="grid size-8 shrink-0 place-items-center rounded-lg text-slate-400 hover:bg-secondary" aria-label={t.close}>
            <X className="size-4" />
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          {parsed.length > 1 && (
            <div className="max-h-40 shrink-0 overflow-y-auto border-b border-border p-2 md:max-h-none md:w-60 md:border-e md:border-b-0">
              <div className="px-1 pb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">{t.reviewFiles}</div>
              {parsed.map((f) => {
                const n = findSensitive(f.text).filter((x) => x.kind !== 'redacted').length;
                return (
                  <div key={f.name} className={cn('flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs', active === f.name ? 'bg-primary/15 text-white' : 'text-slate-300 hover:bg-secondary/60')}>
                    <input
                      type="checkbox"
                      checked={!omitted.has(f.name)}
                      aria-label={`${t.reviewInclude} ${f.name}`}
                      onChange={() => setOmitted((o) => {
                        const s = new Set(o);
                        if (s.has(f.name)) s.delete(f.name);
                        else s.add(f.name);
                        return s;
                      })}
                    />
                    <button onClick={() => setActive(f.name)} className={cn('flex min-w-0 flex-1 items-center gap-1.5 text-start', omitted.has(f.name) && 'line-through opacity-50')} dir="ltr">
                      <FileText className="size-3.5 shrink-0" />
                      <span className="truncate">{f.name}</span>
                    </button>
                    {n > 0 && <AlertTriangle className="size-3.5 shrink-0 text-warning" aria-label={t.reviewSecret} />}
                  </div>
                );
              })}
            </div>
          )}
          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
            {current?.sections.map((s) => {
              const off = (removed[current.name] ?? new Set()).has(s.id) || omitted.has(current.name);
              return (
                <div key={s.id} className={cn('rounded-lg border', off ? 'border-border/50 opacity-45' : 'border-border')}>
                  <label className="flex cursor-pointer items-center gap-2 border-b border-border/60 px-3 py-1.5 text-xs text-slate-300">
                    <input type="checkbox" checked={!off} disabled={omitted.has(current.name)} onChange={() => toggle(current.name, s.id)} />
                    <span className="truncate font-medium">{s.title || t.reviewIntroSection}</span>
                    {!off && findSensitive(s.text).some((f) => f.kind !== 'redacted') && <AlertTriangle className="ms-auto size-3.5 shrink-0 text-warning" />}
                  </label>
                  {!off && (
                    <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-[11px] leading-relaxed text-slate-300" dir="ltr">
                      <Highlighted text={s.text} />
                    </pre>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border px-4 py-3">
          <button onClick={onClose} className="h-9 rounded-lg border border-border px-3 text-sm text-slate-300 hover:bg-secondary">{t.reviewCancel}</button>
          {actions(result, removedCount)}
        </div>
      </div>
    </div>
  );
}

/** Copy button for a reviewed single text. */
export function CopyReviewed({ text, label, onDone }: { text: string | null; label?: string; onDone?: () => void }) {
  const { t } = useT();
  const [done, setDone] = useState(false);
  return (
    <button
      disabled={!text}
      onClick={async () => {
        if (!text) return;
        await navigator.clipboard.writeText(text);
        setDone(true);
        setTimeout(() => {
          setDone(false);
          onDone?.();
        }, 900);
      }}
      className="inline-flex h-9 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-white hover:bg-primary/85 disabled:opacity-50"
    >
      <Check className={cn('size-4', !done && 'hidden')} />
      {done ? t.reviewCopied : label ?? t.reviewCopy}
    </button>
  );
}
