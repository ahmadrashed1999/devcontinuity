'use client';

import { useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useT } from './lang';

/** Button that calls an API endpoint, shows the outcome, and refreshes the page data. */
export function ActionButton({ path, method = 'POST', body, children, confirm, className, variant = 'outline', onDone }: { path: string; method?: string; body?: unknown; children: ReactNode; confirm?: string; className?: string; variant?: 'primary' | 'outline'; onDone?: (r: unknown) => void }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const v = { primary: 'bg-primary text-white hover:bg-primary/85', outline: 'border border-border text-slate-200 hover:bg-secondary' };
  return (
    <span className="inline-flex flex-col gap-1">
      <button
        disabled={busy}
        onClick={async () => {
          if (confirm && !window.confirm(confirm)) return;
          setBusy(true);
          setMsg(null);
          try {
            const r = await api(path, { method, json: body ?? {} });
            setMsg({ ok: true, text: 'Done.' });
            onDone?.(r);
            router.refresh();
          } catch (e) {
            setMsg({ ok: false, text: (e as Error).message });
          } finally {
            setBusy(false);
          }
        }}
        className={cn('inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-sm font-medium disabled:opacity-50', v[variant], className)}
      >
        {busy && <Loader2 className="size-3.5 animate-spin" />}
        {children}
      </button>
      {msg && <span className={cn('max-w-md text-xs', msg.ok ? 'text-success' : 'text-danger')}>{msg.text}</span>}
    </span>
  );
}

const STATUSES = ['pending', 'in_progress', 'blocked', 'requires_verification', 'completed', 'failed', 'cancelled'];

/** Status editor. Completing a task requires saying what was checked: agent claims alone never complete a task. */
export function TaskStatusControl({ id, status }: { id: string; status: string }) {
  const router = useRouter();
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const change = async (next: string) => {
    let note: string | undefined;
    if (next === 'completed') {
      note = window.prompt('What did you check to verify this is complete? (e.g. "tests pass", "feature works in the app", "commit abc123 reviewed")') ?? undefined;
      if (!note?.trim()) return;
    }
    setBusy(true);
    setErr(null);
    try {
      await api(`tasks/${id}`, { method: 'PATCH', json: { status: next, note } });
      router.refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="inline-flex flex-col">
      <select value={status} disabled={busy} onChange={(e) => change(e.target.value)} className="h-7 rounded-md border border-border bg-background px-1.5 text-xs text-slate-200">
        {STATUSES.map((s) => (
          <option key={s} value={s}>
            {s.replace(/_/g, ' ')}
          </option>
        ))}
      </select>
      {err && <span className="text-[10px] text-danger">{err}</span>}
    </span>
  );
}

export function NewItemForm({ kind, projects, defaultProjectId }: { kind: 'task' | 'knowledge'; projects: { id: string; name: string }[]; defaultProjectId?: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [bodyText, setBody] = useState('');
  const [projectId, setProjectId] = useState(defaultProjectId ?? projects[0]?.id ?? '');
  const [k, setK] = useState('decision');
  const [err, setErr] = useState<string | null>(null);
  if (!open) return <button onClick={() => setOpen(true)} className="inline-flex h-8 items-center rounded-lg bg-primary px-3 text-sm font-medium text-white hover:bg-primary/85">{kind === 'task' ? 'New task' : 'New entry'}</button>;
  return (
    <div className="w-full rounded-lg border border-border bg-card p-3">
      <div className="grid gap-2 md:grid-cols-[1fr_200px_160px]">
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" className="h-8 rounded-md border border-border bg-background px-2 text-sm" />
        <select value={projectId} onChange={(e) => setProjectId(e.target.value)} className="h-8 rounded-md border border-border bg-background px-2 text-sm">
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        {kind === 'knowledge' && (
          <select value={k} onChange={(e) => setK(e.target.value)} className="h-8 rounded-md border border-border bg-background px-2 text-sm">
            {['decision', 'issue', 'note'].map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
        )}
      </div>
      <textarea value={bodyText} onChange={(e) => setBody(e.target.value)} placeholder={kind === 'task' ? 'Description (optional)' : 'Details'} rows={3} className="mt-2 w-full rounded-md border border-border bg-background p-2 text-sm" />
      {err && <div className="text-xs text-danger">{err}</div>}
      <div className="mt-2 flex gap-2">
        <button
          onClick={async () => {
            try {
              if (kind === 'task') await api('tasks', { method: 'POST', json: { title, description: bodyText, projectId } });
              else await api('knowledge', { method: 'POST', json: { title, body: bodyText, projectId, kind: k } });
              setOpen(false);
              setTitle('');
              setBody('');
              router.refresh();
            } catch (e) {
              setErr((e as Error).message);
            }
          }}
          className="h-8 rounded-lg bg-primary px-3 text-sm text-white"
        >
          Save
        </button>
        <button onClick={() => setOpen(false)} className="h-8 rounded-lg border border-border px-3 text-sm">
          Cancel
        </button>
      </div>
    </div>
  );
}

/** GET-form filter bar for server-rendered lists. Selects apply immediately; text applies on Enter or the button. */
export function FilterBar({ children }: { children: ReactNode }) {
  const { t } = useT();
  return (
    <form className="mb-4 grid grid-cols-2 items-end gap-2 rounded-xl border border-border bg-card p-3 text-sm sm:flex sm:flex-wrap">
      {children}
      <button className="col-span-2 h-9 rounded-lg bg-secondary px-4 text-sm text-slate-200 hover:bg-secondary/70 sm:h-8">{t.apply}</button>
    </form>
  );
}

export function Select({ name, value, options, label }: { name: string; value?: string; options: [string, string][]; label: string }) {
  const { t } = useT();
  return (
    <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
      {label}
      <select name={name} defaultValue={value ?? ''} onChange={(e) => e.currentTarget.form?.requestSubmit()} className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm text-slate-200 sm:h-8 sm:w-auto sm:min-w-36">
        <option value="">{t.all}</option>
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );
}

export function TextFilter({ name, value, label, placeholder }: { name: string; value?: string; label: string; placeholder?: string }) {
  return (
    <label className="col-span-2 flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
      {label}
      <input name={name} type="search" defaultValue={value ?? ''} placeholder={placeholder} className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm text-slate-200 sm:h-8 sm:w-56" />
    </label>
  );
}
