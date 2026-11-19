'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Loader2, Minus, Plug, Unplug } from 'lucide-react';
import { api } from '@/lib/api';
import { AGENT_COLORS, ago, fmtNum } from '@/lib/format';

const btn = 'inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium disabled:opacity-50';
const btnP = `${btn} bg-primary text-white hover:bg-primary/85`;
const btnO = `${btn} border border-border text-slate-200 hover:bg-secondary`;

interface Connection { agent: string; label: string; hooks: boolean; mcp: boolean; telemetry: boolean; liveSessions: number; lastLiveEvent: string | null }
interface Status { connections: Connection[]; liveStreams: { agent: string; label: string; sessions: number; bytes: number; last: string | null }[] }
interface PlanChange { file: string; description: string; exists: boolean }
interface Plan { agent: string; label: string; remove: boolean; changes: PlanChange[]; commands: string[]; notes: string[] }

/** What each agent can be connected with. Telemetry adds token/cost data where the agent supports it. */
const OFFERS: Record<string, { hooks: boolean; telemetry: boolean; why: string }> = {
  'gemini-cli': { hooks: true, telemetry: true, why: 'Gemini CLI keeps no readable transcript, so hooks record every prompt, tool call and answer.' },
  cursor: { hooks: true, telemetry: false, why: 'Cursor keeps chats in an internal database; hooks record them as they happen.' },
  windsurf: { hooks: true, telemetry: false, why: 'Windsurf encrypts its conversations; hooks are the only way to log them.' },
  antigravity: { hooks: false, telemetry: false, why: 'Already imported from its own index. MCP lets its agents log summaries and see other agents’ work.' },
  'claude-code': { hooks: false, telemetry: true, why: 'Already imported from its transcripts. MCP adds summaries; telemetry adds exact cost per session.' },
  codex: { hooks: false, telemetry: true, why: 'Already imported from its rollouts. MCP adds summaries; telemetry adds token usage.' },
  'qwen-code': { hooks: true, telemetry: true, why: 'Experimental. Qwen Code follows Gemini CLI: hooks (in versions that have them) record prompts and tools; MCP adds summaries and shared memory.' },
  'copilot-cli': { hooks: false, telemetry: false, why: 'Experimental. Adds the MCP server; Copilot CLI hooks live in each repository, and connecting shows the file to add.' },
  kiro: { hooks: false, telemetry: false, why: 'Experimental. Adds the MCP server to Kiro; connecting shows the hooks to add to a Kiro CLI agent.' },
};

function Flag({ on, label }: { on: boolean; label: string }) {
  return <span className={`inline-flex items-center gap-1 text-xs ${on ? 'text-success' : 'text-slate-500'}`}>{on ? <Check className="size-3.5" /> : <Minus className="size-3.5" />}{label}</span>;
}

export function ConnectedAgents() {
  const router = useRouter();
  const [s, setS] = useState<Status | null>(null);
  const [plan, setPlan] = useState<{ plan: Plan; telemetry: boolean } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(() => api<Status>('live/status').then(setS).catch((e) => setMsg((e as Error).message)), []);
  useEffect(() => {
    void load();
  }, [load]);

  const preview = async (agent: string, remove: boolean, telemetry = false) => {
    setBusy(agent);
    setMsg(null);
    try {
      const r = await api<{ plan: Plan }>('live/connect', { method: 'POST', json: { agent, remove, telemetry } });
      setPlan({ plan: r.plan, telemetry });
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const apply = async () => {
    if (!plan) return;
    setBusy(plan.plan.agent);
    try {
      const r = await api<{ written: string[]; backupDir: string; commands: string[] }>('live/connect', { method: 'POST', json: { agent: plan.plan.agent, remove: plan.plan.remove, telemetry: plan.telemetry, apply: true } });
      setMsg(`Updated ${r.written.length} file(s). Originals backed up to ${r.backupDir}.${r.commands.length ? ` Still to run yourself: ${r.commands.join(' ; ')}` : ''}`);
      setPlan(null);
      await load();
      router.refresh();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (!s) return <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Checking agent connections…</div>;
  const other = s.liveStreams.filter((l) => !s.connections.some((c) => c.agent === l.agent));
  return (
    <div className="space-y-3">
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {s.connections.map((c) => {
          const offer = OFFERS[c.agent];
          const connected = c.hooks || c.mcp || c.telemetry;
          return (
            <div key={c.agent} className="rounded-xl border border-border bg-card p-4">
              <div className="flex items-center gap-2">
                <span className={`font-semibold ${AGENT_COLORS[c.agent] ?? 'text-slate-200'}`}>{c.label}</span>
                <span className={`ms-auto rounded-full px-2 py-0.5 text-[10px] ${connected ? 'bg-success/15 text-success' : 'bg-secondary text-slate-400'}`}>{connected ? 'connected' : 'not connected'}</span>
              </div>
              <p className="mt-1.5 text-xs text-muted-foreground">{offer?.why}</p>
              <div className="mt-2 flex flex-wrap gap-3">
                {offer?.hooks && <Flag on={c.hooks} label="Hooks" />}
                <Flag on={c.mcp} label="MCP" />
                {offer?.telemetry && <Flag on={c.telemetry} label="Telemetry" />}
              </div>
              <div className="mt-2 text-[11px] text-slate-500">{c.liveSessions ? `${fmtNum(c.liveSessions)} live session(s) · last event ${ago(c.lastLiveEvent)}` : 'No live events yet'}</div>
              <div className="mt-3 flex flex-wrap gap-2">
                <button disabled={!!busy} onClick={() => preview(c.agent, false)} className={btnP}>{busy === c.agent ? <Loader2 className="size-3.5 animate-spin" /> : <Plug className="size-3.5" />}{connected ? 'Reconnect' : 'Connect'}</button>
                {offer?.telemetry && <button disabled={!!busy} onClick={() => preview(c.agent, false, true)} className={btnO}>+ Telemetry</button>}
                {connected && <button disabled={!!busy} onClick={() => preview(c.agent, true)} className={btnO}><Unplug className="size-3.5" />Disconnect</button>}
              </div>
            </div>
          );
        })}
      </div>
      {other.length > 0 && (
        <div className="rounded-xl border border-border bg-card p-4 text-sm">
          <div className="mb-1 font-medium text-slate-200">Other agents reporting through the API</div>
          {other.map((o) => <div key={o.agent} className="text-xs text-slate-400"><span className={AGENT_COLORS[o.agent] ?? 'text-slate-200'}>{o.label}</span> · {o.sessions} session(s) · last {ago(o.last)}</div>)}
        </div>
      )}
      {plan && (
        <div className="rounded-xl border border-primary/40 bg-primary/5 p-4 text-sm">
          <div className="font-medium text-white">{plan.plan.remove ? 'Disconnect' : 'Connect'} {plan.plan.label}{plan.telemetry ? ' (with telemetry)' : ''}</div>
          {plan.plan.changes.length === 0 && plan.plan.commands.length === 0 && <p className="mt-1 text-slate-400">Nothing to change: it is already set up this way.</p>}
          <ul className="mt-2 space-y-1.5">
            {plan.plan.changes.map((c) => <li key={c.file} className="text-xs"><span className="text-slate-400">{c.exists ? 'update' : 'create'}</span> <span className="font-mono text-slate-200">{c.file}</span><div className="text-slate-400">{c.description}</div></li>)}
            {plan.plan.commands.map((c) => <li key={c} className="text-xs"><span className="text-slate-400">run in a terminal:</span><div className="mt-0.5 select-all rounded bg-black/40 p-1.5 font-mono text-slate-200">{c}</div></li>)}
          </ul>
          {plan.plan.notes.map((n) => <p key={n} className="mt-1.5 text-xs text-muted-foreground">{n}</p>)}
          <div className="mt-3 flex gap-2">
            {plan.plan.changes.length > 0 && <button disabled={!!busy} onClick={apply} className={btnP}>Apply (originals are backed up)</button>}
            <button onClick={() => setPlan(null)} className={btnO}>Close</button>
          </div>
        </div>
      )}
      {msg && <p className="text-xs text-slate-300">{msg}</p>}
    </div>
  );
}

export function FeaturesSettings() {
  const router = useRouter();
  const [f, setF] = useState<{ aiOrg: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void api<{ aiOrg: boolean }>('features').then(setF);
  }, []);
  const toggle = async () => {
    if (!f) return;
    setBusy(true);
    try {
      setF(await api<{ aiOrg: boolean }>('features', { method: 'PUT', json: { aiOrg: !f.aiOrg } }));
      router.refresh();
    } finally {
      setBusy(false);
    }
  };
  if (!f) return <Loader2 className="size-4 animate-spin text-muted-foreground" />;
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-start gap-4">
        <div className="flex-1">
          <div className="font-medium text-slate-100">AI organization (experimental)</div>
          <p className="mt-1 text-sm text-muted-foreground">A CEO agent plans your orders and AI workers carry them out in sandbox Git worktrees, with your approval at every step. Needs an AI provider and budget. Turning it off hides its pages and stops its background work; orders, roles and history are kept.</p>
        </div>
        <button disabled={busy} onClick={toggle} className={f.aiOrg ? btnO : btnP}>{busy ? <Loader2 className="size-3.5 animate-spin" /> : null}{f.aiOrg ? 'Turn off' : 'Turn on'}</button>
      </div>
    </div>
  );
}
