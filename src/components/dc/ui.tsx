import Link from 'next/link';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { AGENT_COLORS, END_STATE_STYLE, STATUS_STYLE, VERIFY_STYLE, agentName } from '@/lib/format';
import { endStateLabel, taskStatusLabel } from '@/lib/i18n';
import { getT } from '@/lib/server-i18n';

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
      <div className="min-w-0 flex-1 basis-64">
        <h1 className="break-words text-xl font-semibold tracking-tight text-white sm:text-2xl">{title}</h1>
        {subtitle && <div className="mt-1 text-sm text-muted-foreground">{subtitle}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Panel({ title, actions, children, className, bodyClass }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; bodyClass?: string }) {
  return (
    <section className={cn('min-w-0 rounded-xl border border-border bg-card shadow-sm shadow-black/20', className)}>
      {(title || actions) && (
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-border px-4 py-3">
          <h2 className="min-w-0 text-sm font-semibold text-slate-200">{title}</h2>
          {actions}
        </div>
      )}
      <div className={cn('min-w-0 p-4 [&:has(>table)]:overflow-x-auto', bodyClass)}>{children}</div>
    </section>
  );
}

export function Stat({ label: l, value, hint, tone = 'default', href }: { label: string; value: ReactNode; hint?: ReactNode; tone?: 'default' | 'primary' | 'cyan' | 'success' | 'warning' | 'danger'; href?: string }) {
  const tones = { default: 'text-white', primary: 'text-indigo-300', cyan: 'text-cyan', success: 'text-success', warning: 'text-warning', danger: 'text-danger' };
  const inner = (
    <div className="rounded-xl border border-border bg-card p-4 transition-colors hover:border-primary/40">
      <div className="text-xs font-medium text-muted-foreground">{l}</div>
      <div className={cn('mt-1.5 text-2xl font-semibold tabular-nums', tones[tone])}>{value}</div>
      {hint && <div className="mt-1 text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
  return href ? <Link href={href}>{inner}</Link> : inner;
}

export function Pill({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn('inline-flex items-center gap-1 whitespace-nowrap rounded-md border px-1.5 py-0.5 text-[11px] font-medium', className)}>{children}</span>;
}

export async function StatusPill({ status }: { status: string }) {
  const { t } = await getT();
  return <Pill className={STATUS_STYLE[status] ?? STATUS_STYLE.pending}>{taskStatusLabel(t, status)}</Pill>;
}

export async function EndStatePill({ state }: { state: string }) {
  const { t } = await getT();
  return <Pill className={END_STATE_STYLE[state] ?? END_STATE_STYLE.unknown}>{endStateLabel(t, state)}</Pill>;
}

/** Agent name with its colour dot. Every agent has one colour across the app. */
export function AgentBadge({ agent, href, className }: { agent: string; href?: string; className?: string }) {
  const inner = (
    <span className={cn('inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-medium', AGENT_COLORS[agent] ?? 'text-slate-300', className)}>
      <span className="agent-dot" />
      <span>{agentName(agent)}</span>
    </span>
  );
  return href ? <Link href={href} className="hover:opacity-80">{inner}</Link> : inner;
}

/** Tiny bar chart (one bar per bucket). Pure SVG, no library. */
export function Sparkline({ values, className }: { values: number[]; className?: string }) {
  const max = Math.max(1, ...values);
  const w = 4;
  const gap = 2;
  return (
    <svg viewBox={`0 0 ${values.length * (w + gap)} 24`} className={cn('h-6 w-full', className)} preserveAspectRatio="none" aria-hidden>
      {values.map((v, i) => {
        const h = v === 0 ? 1.5 : Math.max(3, (v / max) * 24);
        return <rect key={i} x={i * (w + gap)} y={24 - h} width={w} height={h} rx={1} fill="currentColor" opacity={v === 0 ? 0.2 : 0.85} />;
      })}
    </svg>
  );
}

export function VerifyTag({ v }: { v: string }) {
  const text: Record<string, string> = { verified: 'verified', evidence_found: 'evidence found', ai_reported: 'AI-reported', unverified: 'unverified', failed: 'failed' };
  return <span className={cn('text-[11px] font-medium', VERIFY_STYLE[v] ?? 'text-slate-400')}>{text[v] ?? v}</span>;
}

export function Empty({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border px-6 py-10 text-center text-sm text-muted-foreground">
      <div>{children}</div>
      {action}
    </div>
  );
}

export function LinkButton({ href, children, variant = 'outline', className }: { href: string; children: ReactNode; variant?: 'primary' | 'outline' | 'ghost'; className?: string }) {
  const v = { primary: 'bg-primary text-white hover:bg-primary/85', outline: 'border border-border bg-secondary/40 hover:bg-secondary text-slate-200', ghost: 'hover:bg-secondary text-slate-300' };
  return (
    <Link href={href} className={cn('inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-sm font-medium transition-colors', v[variant], className)}>
      {children}
    </Link>
  );
}

export function KV({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-sm">
      {items.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="min-w-0 break-words text-slate-200">{v ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Renders FTS snippets: only the [[ ]] markers become highlights; everything else stays plain text. */
export function Snippet({ text }: { text: string }) {
  const parts = text.split(/(\[\[[\s\S]*?\]\])/g);
  return (
    <span className="snippet-hit">
      {parts.map((p, i) => (p.startsWith('[[') && p.endsWith(']]') ? <b key={i}>{p.slice(2, -2)}</b> : <span key={i}>{p}</span>))}
    </span>
  );
}

export function Tabs({ tabs, active, base }: { tabs: { id: string; label: string; count?: number }[]; active: string; base: string }) {
  return (
    <div className="dc-scroll mb-4 flex gap-1 border-b border-border">
      {tabs.map((t) => (
        <Link key={t.id} href={`${base}${base.includes('?') ? '&' : '?'}tab=${t.id}`} className={cn('-mb-px shrink-0 whitespace-nowrap border-b-2 px-3 py-2 text-sm transition-colors', active === t.id ? 'border-primary text-white' : 'border-transparent text-muted-foreground hover:text-slate-200')}>
          {t.label}
          {t.count !== undefined && <span className="ms-1.5 rounded bg-secondary px-1.5 py-0.5 text-[10px] tabular-nums">{t.count}</span>}
        </Link>
      ))}
    </div>
  );
}

export async function Pager({ total, offset, limit, base }: { total: number; offset: number; limit: number; base: string }) {
  if (total <= limit) return null;
  const { t } = await getT();
  const sep = base.includes('?') ? '&' : '?';
  return (
    <div className="mt-4 flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
      <span className="tabular-nums">
        {offset + 1}–{Math.min(offset + limit, total)} {t.of} {total.toLocaleString('en-US')}
      </span>
      <div className="flex gap-2">
        {offset > 0 && <LinkButton href={`${base}${sep}offset=${Math.max(0, offset - limit)}`}>{t.previous}</LinkButton>}
        {offset + limit < total && <LinkButton href={`${base}${sep}offset=${offset + limit}`}>{t.next}</LinkButton>}
      </div>
    </div>
  );
}

export function qs(params: Record<string, string | number | undefined | null>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : '';
}
