'use client';

import { useEffect, useState } from 'react';
import { ArrowRightLeft, ClipboardCopy, Loader2, Rocket, X, Zap } from 'lucide-react';
import { api } from '@/lib/api';
import { ago } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useT } from './lang';
import { CopyReviewed, ReviewDialog } from './review';

export interface LimitItem {
  sessionId: string;
  agent: string;
  agentLabel: string;
  title: string | null;
  project: { id: string; name: string } | null;
  cwd: string | null;
  endedAt: string | null;
  detail: string | null;
  targets: string[];
}

const LABEL: Record<string, string> = { codex: 'Codex', 'claude-code': 'Claude Code', opencode: 'OpenCode', cursor: 'Cursor', 'gemini-cli': 'Gemini CLI', windsurf: 'Windsurf', antigravity: 'Antigravity', copilot: 'Copilot', generic: 'any AI' };
const LAUNCHABLE = new Set(['codex', 'claude-code', 'opencode', 'cursor']);
const FLAVOR: Record<string, string> = { codex: 'codex', 'claude-code': 'claude-code', opencode: 'opencode', cursor: 'cursor' };
export const targetName = (id: string) => LABEL[id] ?? id;

/**
 * Overview card for sessions that stopped on a usage, rate or billing limit: one click continues
 * the same work in the preferred fallback agent (opened with the briefing), or reviews and copies the
 * briefing for agents DevContinuity cannot open.
 */
export function LimitHandoffs({ items, highlight }: { items: LimitItem[]; highlight?: string }) {
  const { t, lang } = useT();
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<Record<string, { ok: boolean; text: string }>>({});
  const [review, setReview] = useState<{ item: LimitItem; target: string; text: string } | null>(null);

  useEffect(() => {
    if (highlight) document.getElementById(`limit-${highlight}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [highlight]);

  const say = (id: string, ok: boolean, text: string) => setMsg((m) => ({ ...m, [id]: { ok, text } }));

  const openReview = async (item: LimitItem, target: string) => {
    setBusy(`${item.sessionId}:copy:${target}`);
    try {
      const r = await api<{ prompt: string }>(`resume?${new URLSearchParams({ sessionId: item.sessionId, agent: FLAVOR[target] ?? 'generic' })}`);
      setReview({ item, target, text: r.prompt });
    } catch (e) {
      say(item.sessionId, false, (e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const continueIn = async (item: LimitItem, target: string) => {
    if (!LAUNCHABLE.has(target)) return openReview(item, target);
    setBusy(`${item.sessionId}:${target}`);
    try {
      const r = await api<{ note: string }>('launch', { method: 'POST', json: { agent: target, sessionId: item.sessionId } });
      say(item.sessionId, true, `${t.limitLaunched.replace('{agent}', targetName(target))} ${r.note}`);
    } catch (e) {
      say(item.sessionId, false, (e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const dismiss = async (item: LimitItem) => {
    setHidden((h) => new Set(h).add(item.sessionId));
    await api(`handoff/limits/${item.sessionId}/dismiss`, { method: 'POST' }).catch(() => undefined);
  };

  const visible = items.filter((i) => !hidden.has(i.sessionId));
  if (!visible.length) return null;

  return (
    <section className="space-y-3" aria-label={t.needsAttention}>
      {visible.map((item) => {
        const [first, ...others] = item.targets;
        const where = item.project?.name ?? item.cwd ?? '—';
        const m = msg[item.sessionId];
        return (
          <div key={item.sessionId} id={`limit-${item.sessionId}`} className={cn('rounded-xl border bg-gradient-to-br from-red-500/10 via-card to-card p-4', highlight === item.sessionId ? 'border-red-400/70 ring-2 ring-red-400/30' : 'border-red-400/30')}>
            <div className="flex items-start gap-3">
              <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-red-500/15 text-red-300">
                <Zap className="size-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-[11px] font-semibold uppercase tracking-wider text-red-300">{t.needsAttention}</div>
                <h3 className="text-sm font-semibold text-white sm:text-base">
                  {t.limitHit.replace('{agent}', item.agentLabel).replace('{project}', where)}
                </h3>
                <div className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                  {item.title && <span className="line-clamp-1">{t.limitLastRequest}: {item.title}</span>}
                  {item.endedAt && <span className="whitespace-nowrap">{ago(item.endedAt, lang)}</span>}
                </div>
                {item.detail && <div className="mt-1 line-clamp-1 font-mono text-[11px] text-red-200/80" dir="ltr">{item.detail}</div>}
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <button onClick={() => continueIn(item, first)} disabled={!!busy} className="inline-flex h-9 items-center gap-2 rounded-lg bg-gradient-to-r from-primary to-cyan px-3.5 text-sm font-semibold text-white shadow-lg shadow-primary/20 hover:opacity-90 disabled:opacity-60">
                    {busy === `${item.sessionId}:${first}` ? <Loader2 className="size-4 animate-spin" /> : LAUNCHABLE.has(first) ? <Rocket className="size-4" /> : <ArrowRightLeft className="size-4" />}
                    {t.limitContinueIn.replace('{agent}', targetName(first))}
                  </button>
                  <button onClick={() => openReview(item, first)} disabled={!!busy} className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border px-3 text-sm text-slate-200 hover:bg-secondary disabled:opacity-60">
                    {busy?.startsWith(`${item.sessionId}:copy`) ? <Loader2 className="size-4 animate-spin" /> : <ClipboardCopy className="size-4" />}
                    {t.limitCopy}
                  </button>
                  <span className="text-xs text-muted-foreground">{t.limitOther}</span>
                  {others.slice(0, 6).map((o) => (
                    <button key={o} onClick={() => continueIn(item, o)} disabled={!!busy} className="h-7 rounded-md border border-border px-2 text-xs text-slate-300 hover:border-primary/50 hover:bg-primary/10 disabled:opacity-60">
                      {targetName(o)}
                    </button>
                  ))}
                </div>
                {m && <div className={cn('mt-2 text-xs', m.ok ? 'text-success' : 'text-danger')}>{m.text}</div>}
              </div>
              <button onClick={() => dismiss(item)} className="grid size-8 shrink-0 place-items-center rounded-lg text-slate-500 hover:bg-secondary hover:text-slate-300" aria-label={t.limitDismiss} title={t.limitDismiss}>
                <X className="size-4" />
              </button>
            </div>
          </div>
        );
      })}
      {review && (
        <ReviewDialog
          files={[{ name: `continue-in-${review.target}.md`, text: review.text }]}
          onClose={() => setReview(null)}
          actions={(r) => (
            <CopyReviewed
              text={r.files[0].text}
              label={t.limitCopyFor.replace('{agent}', targetName(review.target))}
              onDone={() => {
                say(review.item.sessionId, true, t.limitCopied.replace('{agent}', targetName(review.target)));
                setReview(null);
              }}
            />
          )}
        />
      )}
    </section>
  );
}

/** Settings → Agents: which agent to offer first when another one hits a limit. */
export function FallbackAgentSetting() {
  const { t } = useT();
  const [d, setD] = useState<{ fallback: string; targets: { id: string; launch: boolean }[] } | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  useEffect(() => {
    api<typeof d>('settings/fallback-agent').then(setD).catch(() => undefined);
  }, []);
  if (!d) return <Loader2 className="size-4 animate-spin" />;
  return (
    <section className="rounded-xl border border-border bg-card p-5">
      <h2 className="mb-1 font-semibold text-white">{t.fallbackTitle}</h2>
      <p className="mb-3 text-sm text-muted-foreground">{t.fallbackHelp}</p>
      <div className="flex flex-wrap gap-1.5">
        {d.targets.map((x) => (
          <button
            key={x.id}
            onClick={async () => {
              try {
                const r = await api<{ fallback: string }>('settings/fallback-agent', { method: 'PUT', json: { agent: x.id } });
                setD({ ...d, fallback: r.fallback });
                setSaved(t.fallbackSaved);
              } catch (e) {
                setSaved((e as Error).message);
              }
            }}
            className={cn('rounded-lg border px-3 py-1.5 text-sm', d.fallback === x.id ? 'border-primary bg-primary/20 text-white' : 'border-border text-slate-300 hover:bg-secondary')}
          >
            {targetName(x.id)}
            {!x.launch && <span className="ms-1 text-[10px] text-muted-foreground">({t.fallbackCopyOnly})</span>}
          </button>
        ))}
      </div>
      {saved && <p className="mt-2 text-xs text-muted-foreground">{saved}</p>}
    </section>
  );
}
