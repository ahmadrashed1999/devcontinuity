'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Loader2, Send } from 'lucide-react';
import { api } from '@/lib/api';
import { ago, fmtDate } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Md, VoiceButton } from '@/components/dc/common';

export interface Decision {
  id: string;
  kind: string;
  title: string;
  question: string;
  context: string | null;
  options: string;
  recommendation: string | null;
  risk: string | null;
  costUsd: number | null;
  orderId: string | null;
  workItemId: string | null;
  fromRoleKey: string | null;
  status: string;
  answer: string | null;
  comment: string | null;
  createdAt: string;
}

function WorkDiff({ id }: { id: string }) {
  const [w, setW] = useState<{ result: string | null; type: string; branch: string | null; worktreePath: string | null; runs: { id: string; purpose: string; status: string; role: { title: string } | null; log: string | null; costUsd: number }[] } | null>(null);
  useEffect(() => {
    api<typeof w>(`workitems/${id}`).then(setW).catch(() => undefined);
  }, [id]);
  if (!w) return <Loader2 className="size-4 animate-spin text-muted-foreground" />;
  const [summary, diff] = (w.result ?? '').split('\n--- diff ---\n');
  return (
    <div className="space-y-2">
      {w.branch && <div className="font-mono text-xs text-muted-foreground">branch {w.branch} · worktree {w.worktreePath}</div>}
      {w.type === 'code' ? (
        <pre className="max-h-[500px] overflow-auto rounded-lg bg-black/40 p-2 font-mono text-[11px] leading-relaxed">
          {(diff ?? '').split('\n').map((l, i) => <div key={i} className={l.startsWith('+') && !l.startsWith('+++') ? 'text-green-400' : l.startsWith('-') && !l.startsWith('---') ? 'text-red-400' : l.startsWith('@@') ? 'text-cyan' : 'text-slate-400'}>{l || ' '}</div>)}
          {!diff?.trim() && <div className="text-slate-500">No file changes were made.</div>}
        </pre>
      ) : (
        <div className="max-h-[500px] overflow-auto rounded-lg border border-border bg-background/60 p-3"><Md text={summary ?? ''} /></div>
      )}
      <details>
        <summary className="cursor-pointer text-xs text-slate-500">Work log ({w.runs.length} runs)</summary>
        {w.runs.map((r) => (
          <div key={r.id} className="mt-2">
            <div className="text-xs text-slate-300">{r.purpose} · {r.role?.title ?? '-'} · {r.status} · ${r.costUsd.toFixed(3)}</div>
            {r.log && <pre className="max-h-48 overflow-auto rounded bg-black/40 p-2 font-mono text-[10px] text-slate-500">{r.log}</pre>}
          </div>
        ))}
      </details>
    </div>
  );
}

export function DecisionCard({ d, showWork }: { d: Decision; showWork?: boolean }) {
  const router = useRouter();
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [open, setOpen] = useState(!!showWork);
  const options = JSON.parse(d.options) as { id: string; label: string }[];
  const answer = async (id: string) => {
    if (['revise', 'request_changes'].includes(id) && !comment.trim()) return setMsg({ ok: false, text: 'Write what should change in the comment box first.' });
    if (['approve_merge', 'push_pr'].includes(id) || id.startsWith('pick:')) if (!window.confirm(id === 'push_pr' ? 'Push this branch to GitHub and open a pull request?' : 'Merge this branch into the repository\'s current branch?')) return;
    setBusy(id);
    setMsg(null);
    try {
      const r = await api<{ message: string }>(`decisions/${d.id}`, { method: 'POST', json: { answer: id, comment } });
      setMsg({ ok: true, text: r.message });
      setTimeout(() => router.refresh(), 800);
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };
  const tone = d.kind === 'plan_approval' ? 'border-s-primary' : d.kind === 'merge' || d.kind === 'compare' ? 'border-s-cyan' : 'border-s-warning';
  return (
    <div className={cn('rounded-xl border border-border border-s-4 bg-card p-4', tone)}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-md bg-secondary px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-slate-400">{d.kind.replace(/_/g, ' ')}</span>
        <span className="font-semibold text-white">{d.title}</span>
        <span className="ms-auto text-xs text-muted-foreground">{d.fromRoleKey ? `from ${d.fromRoleKey} · ` : ''}{ago(d.createdAt)}{d.costUsd != null ? ` · ${d.kind === 'plan_approval' ? 'est. ' : ''}$${d.costUsd.toFixed(2)}` : ''}</span>
      </div>
      <div className="mt-1 text-sm text-slate-300">{d.question}</div>
      {d.recommendation && <div className="mt-2 rounded-lg bg-primary/10 px-3 py-2 text-sm text-indigo-100"><span className="text-xs text-indigo-300">Recommendation: </span>{d.recommendation}</div>}
      {d.risk && <div className="mt-2 whitespace-pre-wrap rounded-lg bg-warning/10 px-3 py-2 text-sm text-amber-100"><span className="text-xs text-warning">Risks: </span>{d.risk}</div>}
      {d.context && <div className="mt-3 max-h-[420px] overflow-auto rounded-lg border border-border bg-background/50 p-3"><Md text={d.context} /></div>}
      {d.workItemId && d.kind !== 'compare' && (
        <div className="mt-3">
          <button onClick={() => setOpen(!open)} className="inline-flex items-center gap-1 text-xs text-primary">{open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}{open ? 'Hide' : 'Show'} the actual work (diff / document / logs)</button>
          {open && <div className="mt-2"><WorkDiff id={d.workItemId} /></div>}
        </div>
      )}
      {d.status === 'pending' ? (
        <>
          <textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={2} placeholder="Comment (required for revise / request changes)" className="mt-3 w-full rounded-lg border border-border bg-background p-2 text-sm" />
          <div className="mt-2 flex flex-wrap gap-2">
            {options.map((o) => (
              <button key={o.id} disabled={!!busy} onClick={() => answer(o.id)} className={cn('inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-sm font-medium disabled:opacity-50', o.id === 'approve' || o.id === 'approve_merge' || o.id === 'accept' || o.id.startsWith('pick:') ? 'bg-success/90 text-white hover:bg-success' : o.id === 'reject' ? 'border border-danger/40 text-red-300 hover:bg-danger/10' : 'border border-border text-slate-200 hover:bg-secondary')}>
                {busy === o.id && <Loader2 className="size-3.5 animate-spin" />}
                {o.label}
              </button>
            ))}
          </div>
        </>
      ) : (
        <div className="mt-3 text-sm text-muted-foreground">Answered: <b className="text-slate-200">{d.answer}</b>{d.comment ? ` — ${d.comment}` : ''}</div>
      )}
      {msg && <div className={cn('mt-2 text-sm', msg.ok ? 'text-success' : 'text-danger')}>{msg.text}</div>}
    </div>
  );
}

export function OrderComposer({ projects, lang }: { projects: { id: string; name: string }[]; lang: 'en' | 'ar' }) {
  const router = useRouter();
  const [text, setText] = useState('');
  const [projectId, setProjectId] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [mode, setMode] = useState<'order' | 'compare'>('order');
  const [exA, setExA] = useState('api');
  const [exB, setExB] = useState('codex');
  const submit = async () => {
    setBusy(true);
    setMsg(null);
    try {
      if (mode === 'compare') {
        if (!projectId) throw new Error('Pick a Git project for a side-by-side run.');
        await api('compare', { method: 'POST', json: { projectId, instruction: text, executors: [exA, exB] } });
        setMsg({ ok: true, text: 'Two agents started on the same task in separate worktrees. You will get one decision to pick the better result.' });
      } else {
        const intent = await api<{ action: string; agent?: string; projectId?: string; projectName?: string; question?: string }>('voice/intent', { method: 'POST', json: { text } });
        if (intent.action === 'launch' && intent.agent && window.confirm(`Open ${intent.projectName} in ${intent.agent}?`)) {
          await api('launch', { method: 'POST', json: { agent: intent.agent, projectId: intent.projectId } });
          setMsg({ ok: true, text: `Opening ${intent.projectName} in ${intent.agent}.` });
        } else {
          await api('orders', { method: 'POST', json: { instruction: text, projectId: projectId || null, lang } });
          setMsg({ ok: true, text: 'Order sent to the CEO. The plan will arrive in your Decision Inbox for approval.' });
        }
      }
      setText('');
      router.refresh();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="rounded-xl border border-primary/30 bg-gradient-to-br from-primary/10 to-cyan/5 p-4">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="font-semibold text-white">{lang === 'ar' ? 'أعطِ أمراً للرئيس التنفيذي' : 'Give an order to the CEO'}</span>
        <div className="ms-auto flex gap-1 text-xs">
          {(['order', 'compare'] as const).map((m) => <button key={m} onClick={() => setMode(m)} className={cn('rounded-md border px-2 py-1', mode === m ? 'border-primary bg-primary/20 text-white' : 'border-border text-slate-400')}>{m === 'order' ? 'Order' : 'Two agents side by side'}</button>)}
        </div>
      </div>
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} dir="auto" placeholder={lang === 'ar' ? 'مثال: أكمل صفحة التسجيل في تطبيق my-app مع اختبارات' : 'e.g. "Finish the sign-up flow in my-app with tests" or "Continue my-app with Codex"'} className="w-full rounded-lg border border-border bg-background/80 p-3 text-sm" />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <select value={projectId} onChange={(e) => setProjectId(e.target.value)} className="h-9 max-w-60 rounded-lg border border-border bg-background px-2 text-sm">
          <option value="">{mode === 'compare' ? 'Choose project' : 'No specific project / detect'}</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        {mode === 'compare' && (
          <>
            {[exA, exB].map((v, i) => (
              <select key={i} value={v} onChange={(e) => (i ? setExB(e.target.value) : setExA(e.target.value))} className="h-9 rounded-lg border border-border bg-background px-2 text-sm">
                {['api', 'claude-code', 'codex', 'opencode'].map((x) => <option key={x} value={x}>{i ? 'B' : 'A'}: {x === 'api' ? 'built-in agent (API)' : x}</option>)}
              </select>
            ))}
          </>
        )}
        <VoiceButton lang={lang} onText={(t) => setText((cur) => (cur ? `${cur} ${t}` : t))} />
        <button disabled={busy || text.trim().length < 5} onClick={submit} className="ms-auto inline-flex h-9 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-white disabled:opacity-50">
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />} {mode === 'compare' ? 'Start both' : 'Send'}
        </button>
      </div>
      {msg && <div className={cn('mt-2 text-sm', msg.ok ? 'text-success' : 'text-danger')}>{msg.text}</div>}
    </div>
  );
}

interface Activity {
  orchestrator: { online: boolean; pid: number | null; at: string; active?: number };
  running: { id: string; purpose: string; executor: string; startedAt: string; log: string | null; role: { title: string } | null; workItem: { id: string; title: string; orderId: string | null } | null }[];
  recent: { id: string; purpose: string; status: string; executor: string; startedAt: string; finishedAt: string | null; costUsd: number; error: string | null; role: { title: string } | null; workItem: { title: string; orderId: string | null } | null }[];
  queued: number;
  lastAutoSync: { at: string; imported: number; agents: string[] } | null;
  killSwitch: boolean;
}

export function ActivityLive() {
  const [a, setA] = useState<Activity | null>(null);
  const load = useCallback(() => api<Activity>('activity').then(setA).catch(() => undefined), []);
  useEffect(() => {
    void load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [load]);
  if (!a) return <Loader2 className="size-5 animate-spin text-muted-foreground" />;
  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-4">
        <div className={cn('rounded-xl border p-3', a.orchestrator.online ? 'border-success/30 bg-success/5' : 'border-danger/30 bg-danger/5')}>
          <div className="text-xs text-muted-foreground">Background service</div>
          <div className={cn('font-semibold', a.orchestrator.online ? 'text-success' : 'text-danger')}>{a.orchestrator.online ? 'Online' : 'Offline'}</div>
          <div className="text-[11px] text-muted-foreground">{a.orchestrator.online ? `pid ${a.orchestrator.pid}` : 'Start it from the tray app or: npm run orchestrator'}</div>
        </div>
        <div className="rounded-xl border border-border bg-card p-3"><div className="text-xs text-muted-foreground">Running now</div><div className="text-xl font-semibold text-cyan">{a.running.length}</div></div>
        <div className="rounded-xl border border-border bg-card p-3"><div className="text-xs text-muted-foreground">Queued tasks</div><div className="text-xl font-semibold text-white">{a.queued}</div></div>
        <div className="rounded-xl border border-border bg-card p-3"><div className="text-xs text-muted-foreground">Last auto-sync</div><div className="text-sm text-slate-200">{a.lastAutoSync ? `${ago(a.lastAutoSync.at)} · ${a.lastAutoSync.imported} imported` : 'not yet'}</div></div>
      </div>
      {a.killSwitch && <div className="rounded-xl border border-danger bg-danger/10 p-3 text-sm text-red-200">The kill switch is ON. No AI organization work runs until you resume.</div>}
      <div className="space-y-3">
        {a.running.map((r) => (
          <div key={r.id} className="rounded-xl border border-cyan/30 bg-card p-3">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Loader2 className="size-4 animate-spin text-cyan" />
              <span className="font-medium text-white">{r.workItem?.title ?? r.purpose}</span>
              <span className="text-xs text-muted-foreground">{r.purpose} · {r.role?.title} · {r.executor} · started {ago(r.startedAt)}</span>
              {r.workItem?.orderId && <Link href={`/owner/orders?order=${r.workItem.orderId}`} className="ms-auto text-xs text-primary">order</Link>}
            </div>
            {r.log && <pre className="mt-2 max-h-56 overflow-auto rounded bg-black/40 p-2 font-mono text-[10px] text-slate-400">{r.log}</pre>}
          </div>
        ))}
        {a.running.length === 0 && <div className="text-sm text-muted-foreground">Nothing is running.</div>}
      </div>
      <div className="overflow-hidden rounded-xl border border-border">
        <table className="w-full text-xs">
          <thead className="bg-card text-muted-foreground"><tr><th className="p-2 text-start">Finished</th><th className="p-2 text-start">Work</th><th className="p-2 text-start">Role / executor</th><th className="p-2 text-start">Status</th><th className="p-2 text-end">Cost</th></tr></thead>
          <tbody>
            {a.recent.map((r) => (
              <tr key={r.id} className="border-t border-border">
                <td className="p-2 text-muted-foreground">{fmtDate(r.finishedAt ?? r.startedAt)}</td>
                <td className="p-2 text-slate-200">{r.workItem?.title ?? r.purpose} <span className="text-slate-500">({r.purpose})</span>{r.error && <div className="text-danger">{r.error.slice(0, 160)}</div>}</td>
                <td className="p-2 text-slate-400">{r.role?.title ?? '-'} · {r.executor}</td>
                <td className={cn('p-2', r.status === 'completed' ? 'text-success' : r.status === 'failed' ? 'text-danger' : 'text-slate-400')}>{r.status}</td>
                <td className="p-2 text-end tabular-nums">${r.costUsd.toFixed(3)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

interface RoleRow {
  id: string;
  key: string;
  title: string;
  titleAr: string;
  level: string;
  executor: string;
  modelRoute: string;
  autonomy: string;
  instructions: string;
  enabled: boolean;
  allowedCommands: string | null;
}
interface DeptRow {
  id: string;
  key: string;
  name: string;
  nameAr: string;
  description: string | null;
  enabled: boolean;
  budgetUsd: number | null;
  roles: RoleRow[];
}

function RoleEditor({ r, onSaved }: { r: RoleRow; onSaved: () => void }) {
  const [v, setV] = useState({ ...r, allowed: (r.allowedCommands ? (JSON.parse(r.allowedCommands) as string[]) : []).join('\n') });
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    try {
      await api(`roles/${r.id}`, { method: 'PATCH', json: { title: v.title, titleAr: v.titleAr, executor: v.executor, modelRoute: v.modelRoute, autonomy: v.autonomy, instructions: v.instructions, enabled: v.enabled, allowedCommands: v.allowed.split('\n').map((x) => x.trim()).filter(Boolean) } });
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <div className="mt-2 space-y-2 rounded-lg border border-border bg-background/60 p-3 text-sm">
      <div className="grid gap-2 md:grid-cols-2">
        <input value={v.title} onChange={(e) => setV({ ...v, title: e.target.value })} className="h-8 rounded-md border border-border bg-background px-2" />
        <input value={v.titleAr} dir="rtl" onChange={(e) => setV({ ...v, titleAr: e.target.value })} className="h-8 rounded-md border border-border bg-background px-2" />
      </div>
      <div className="grid gap-2 md:grid-cols-3">
        <label className="text-xs text-muted-foreground">Executor
          <select value={v.executor} onChange={(e) => setV({ ...v, executor: e.target.value })} className="mt-1 h-8 w-full rounded-md border border-border bg-background px-2 text-sm text-slate-200">
            <option value="api">Built-in agent (any API model)</option><option value="claude-code">Claude Code CLI</option><option value="codex">Codex CLI</option><option value="opencode">OpenCode CLI</option>
          </select>
        </label>
        <label className="text-xs text-muted-foreground">Model route (job name or providerId:model)
          <input value={v.modelRoute} onChange={(e) => setV({ ...v, modelRoute: e.target.value })} className="mt-1 h-8 w-full rounded-md border border-border bg-background px-2 font-mono text-xs text-slate-200" />
        </label>
        <label className="text-xs text-muted-foreground">Autonomy
          <select value={v.autonomy} onChange={(e) => setV({ ...v, autonomy: e.target.value })} className="mt-1 h-8 w-full rounded-md border border-border bg-background px-2 text-sm text-slate-200">
            <option value="L0">L0 — read & report only</option><option value="L1">L1 — draft in its own worktree</option><option value="L2">L2 — draft + run tests/builds</option><option value="L3">L3 — same as L2; merges/deploys still need you</option>
          </select>
        </label>
      </div>
      <textarea value={v.instructions} onChange={(e) => setV({ ...v, instructions: e.target.value })} rows={4} className="w-full rounded-md border border-border bg-background p-2 text-xs" />
      <textarea value={v.allowed} onChange={(e) => setV({ ...v, allowed: e.target.value })} rows={2} placeholder="Allowed command prefixes, one per line (empty = any allowed test/build command)" className="w-full rounded-md border border-border bg-background p-2 font-mono text-xs" />
      <div className="flex items-center gap-3">
        <label className="flex items-center gap-1.5 text-xs"><input type="checkbox" checked={v.enabled} onChange={(e) => setV({ ...v, enabled: e.target.checked })} /> Enabled</label>
        <button onClick={save} className="ms-auto h-8 rounded-lg bg-primary px-3 text-white">Save role</button>
      </div>
      {err && <div className="text-xs text-danger">{err}</div>}
    </div>
  );
}

export function OrgChart({ lang }: { lang: 'en' | 'ar' }) {
  const [data, setData] = useState<{ departments: DeptRow[]; workload: { roleKey: string | null; status: string; _count: number }[] } | null>(null);
  const [edit, setEdit] = useState<string | null>(null);
  const [newRole, setNewRole] = useState<string | null>(null);
  const [form, setForm] = useState({ key: '', title: '', titleAr: '' });
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(() => api<typeof data>('org').then(setData), []);
  useEffect(() => {
    void load();
  }, [load]);
  if (!data) return <Loader2 className="size-5 animate-spin text-muted-foreground" />;
  if (!data.departments.length)
    return (
      <div className="rounded-xl border border-dashed border-border p-8 text-center">
        <p className="mb-3 text-sm text-muted-foreground">The organization has not been created yet.</p>
        <button onClick={async () => { await api('org/seed', { method: 'POST' }); void load(); }} className="h-9 rounded-lg bg-primary px-4 text-sm text-white">Create the default organization (17 departments)</button>
      </div>
    );
  const busy = (key: string) => data.workload.filter((w) => w.roleKey === key).reduce((a, w) => a + w._count, 0);
  const ceo = data.departments.flatMap((d) => d.roles).find((r) => r.level === 'ceo');
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card p-3 text-sm">
        <span className="text-muted-foreground">Switch all coding workers to:</span>
        {['api', 'claude-code', 'codex', 'opencode'].map((x) => (
          <button key={x} onClick={async () => { const r = await api<{ updated: number }>('org/executors', { method: 'POST', json: { executor: x } }); setMsg(`${r.updated} coding role(s) now use ${x}.`); void load(); }} className="h-8 rounded-lg border border-border px-2.5 text-xs hover:bg-secondary">{x === 'api' ? 'Built-in agent (API)' : x}</button>
        ))}
        {msg && <span className="text-xs text-success">{msg}</span>}
      </div>
      <div className="flex flex-col items-center">
        <div className="rounded-xl border-2 border-warning/50 bg-warning/10 px-5 py-2 text-center"><div className="text-xs text-warning">{lang === 'ar' ? 'المالك' : 'OWNER'}</div><div className="font-semibold text-white">{lang === 'ar' ? 'أنت — القرار النهائي' : 'You — final decisions'}</div></div>
        <div className="h-4 w-px bg-border" />
        {ceo && <div className="rounded-xl border-2 border-primary/60 bg-primary/15 px-5 py-2 text-center"><div className="text-xs text-indigo-300">{lang === 'ar' ? ceo.titleAr : ceo.title}</div><div className="text-xs text-muted-foreground">{ceo.executor} · {ceo.modelRoute}</div></div>}
        <div className="h-4 w-px bg-border" />
      </div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {data.departments.filter((d) => d.key !== 'executive' || d.roles.some((r) => r.level !== 'ceo')).map((d) => (
          <div key={d.id} className={cn('rounded-xl border bg-card p-3', d.enabled ? 'border-border' : 'border-dashed border-border opacity-60')}>
            <div className="flex items-center gap-2">
              <span className="font-semibold text-white">{lang === 'ar' ? d.nameAr : d.name}</span>
              <label className="ms-auto flex items-center gap-1 text-[11px] text-muted-foreground"><input type="checkbox" checked={d.enabled} onChange={async (e) => { await api(`departments/${d.id}`, { method: 'PATCH', json: { enabled: e.target.checked } }); void load(); }} /> active</label>
            </div>
            <div className="text-[11px] text-muted-foreground">{d.description}</div>
            <div className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground">
              Budget/month $
              <input defaultValue={d.budgetUsd ?? ''} placeholder="none" onBlur={async (e) => { const v = e.target.value.trim(); await api(`departments/${d.id}`, { method: 'PATCH', json: { budgetUsd: v ? Number(v) : null } }); }} className="h-6 w-16 rounded border border-border bg-background px-1 text-xs" />
            </div>
            <div className="mt-2 space-y-1">
              {d.roles.filter((r) => r.level !== 'ceo').map((r) => (
                <div key={r.id}>
                  <button onClick={() => setEdit(edit === r.id ? null : r.id)} className={cn('flex w-full items-center gap-2 rounded-md px-2 py-1 text-start text-sm hover:bg-secondary/60', !r.enabled && 'opacity-50')}>
                    <span className={cn('size-1.5 rounded-full', r.level === 'head' ? 'bg-primary' : 'bg-cyan')} />
                    <span className={r.level === 'head' ? 'font-medium text-slate-100' : 'text-slate-300'}>{lang === 'ar' ? r.titleAr : r.title}</span>
                    <span className="ms-auto text-[10px] text-slate-500">{r.executor} · {r.autonomy}{busy(r.key) ? ` · ${busy(r.key)} active` : ''}</span>
                  </button>
                  {edit === r.id && <RoleEditor r={r} onSaved={() => { setEdit(null); void load(); }} />}
                </div>
              ))}
            </div>
            {newRole === d.id ? (
              <div className="mt-2 space-y-1">
                <input value={form.key} onChange={(e) => setForm({ ...form, key: e.target.value })} placeholder="key (e.g. flutter_dev_2)" className="h-7 w-full rounded border border-border bg-background px-2 text-xs" />
                <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Title" className="h-7 w-full rounded border border-border bg-background px-2 text-xs" />
                <input value={form.titleAr} dir="rtl" onChange={(e) => setForm({ ...form, titleAr: e.target.value })} placeholder="المسمى بالعربية" className="h-7 w-full rounded border border-border bg-background px-2 text-xs" />
                <button onClick={async () => { try { await api('roles', { method: 'POST', json: { ...form, departmentId: d.id, level: 'worker' } }); setNewRole(null); setForm({ key: '', title: '', titleAr: '' }); void load(); } catch (e) { setMsg((e as Error).message); } }} className="h-7 rounded bg-primary px-2 text-xs text-white">Add worker</button>
              </div>
            ) : (
              <button onClick={() => setNewRole(d.id)} className="mt-2 text-xs text-primary">+ Add a worker</button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
