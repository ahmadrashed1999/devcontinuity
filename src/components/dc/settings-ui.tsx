'use client';

import { useCallback, useEffect, useState } from 'react';
import { Loader2, Plus, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

const btn = 'inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-sm font-medium disabled:opacity-50';
const btnP = `${btn} bg-primary text-white hover:bg-primary/85`;
const btnO = `${btn} border border-border text-slate-200 hover:bg-secondary`;
const inp = 'h-8 rounded-md border border-border bg-background px-2 text-sm';

interface Provider { id: string; kind: string; name: string; baseUrl: string | null; keyRef: string | null; enabled: boolean; models: string[]; virtual?: boolean; hasKey: boolean }
interface ProvData { providers: Provider[]; kinds: string[]; defaults: Record<string, string>; routes: Record<string, { providerId: string; model: string }[]>; jobs: string[]; budget: { monthlyCapUsd: number; warnAtUsd: number }; prices: Record<string, { input: number; output: number }>; privateProjectIds: string[] }

const JOB_HELP: Record<string, string> = {
  summary: 'Session summaries, search expansion (cheap model)',
  analysis: 'Project analysis (strong model)',
  plan: 'CEO planning (strong model)',
  worker: 'AI organization workers / built-in coding agent',
  review: 'Department-head, QA and security reviews',
  chat: '“Ask my projects” answers',
  triage: 'Triage helpers (cheap model)',
  digest: 'Owner brief narrative',
  embed: 'Embeddings for semantic search (local Ollama/LM Studio recommended)',
  private: 'Projects marked private — must be a local provider',
};

export function ProvidersSettings({ projects }: { projects: { id: string; name: string }[] }) {
  const [d, setD] = useState<ProvData | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [nf, setNf] = useState({ kind: 'openai', name: '', baseUrl: '', apiKey: '' });
  const [models, setModels] = useState<Record<string, string[]>>({});
  const [routes, setRoutes] = useState<ProvData['routes']>({});
  const [prices, setPrices] = useState<{ model: string; input: string; output: string }[]>([]);
  const [budget, setBudget] = useState({ monthlyCapUsd: '50', warnAtUsd: '25' });
  const [priv, setPriv] = useState<string[]>([]);
  const [testModel, setTestModel] = useState<Record<string, string>>({});
  const load = useCallback(async () => {
    const x = await api<ProvData>('providers');
    setD(x);
    setRoutes(x.routes);
    setPrices(Object.entries(x.prices).map(([model, p]) => ({ model, input: String(p.input), output: String(p.output) })));
    setBudget({ monthlyCapUsd: String(x.budget.monthlyCapUsd), warnAtUsd: String(x.budget.warnAtUsd) });
    setPriv(x.privateProjectIds);
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch
    void load();
  }, [load]);
  if (!d) return <Loader2 className="size-4 animate-spin" />;
  const ok = (text: string) => setMsg({ ok: true, text });
  const fail = (e: unknown) => setMsg({ ok: false, text: (e as Error).message });
  const loadModels = async (id: string) => {
    try {
      const m = await api<string[]>(`providers/${id}/models`);
      setModels((x) => ({ ...x, [id]: m }));
    } catch (e) {
      fail(e);
    }
  };
  const allModelOptions = (pid: string) => [...new Set([...(models[pid] ?? []), ...(d.providers.find((p) => p.id === pid)?.models ?? [])])];
  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-border bg-card p-5">
        <h2 className="mb-1 font-semibold text-white">AI providers</h2>
        <p className="mb-3 text-sm text-muted-foreground">Use any provider. Keys are stored encrypted on this PC and never sent to the browser. If one provider runs out or fails, the next one in a job&apos;s route is used automatically.</p>
        <div className="space-y-2">
          {d.providers.map((p) => (
            <div key={p.id} className="rounded-lg border border-border bg-background/50 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-white">{p.name}</span>
                <span className="text-xs text-muted-foreground">{p.kind}{p.baseUrl ? ` · ${p.baseUrl}` : ''}</span>
                <span className={cn('text-xs', p.hasKey ? 'text-success' : 'text-warning')}>{p.hasKey ? (['ollama', 'lmstudio'].includes(p.kind) ? 'local, no key needed' : 'key set') : 'no key'}</span>
                {!p.virtual && (
                  <span className="ms-auto flex items-center gap-2">
                    <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={p.enabled} onChange={async (e) => { await api(`providers/${p.id}`, { method: 'PATCH', json: { enabled: e.target.checked } }); void load(); }} /> enabled</label>
                    <button onClick={async () => { const k = window.prompt('New API key:'); if (k) { await api(`providers/${p.id}`, { method: 'PATCH', json: { apiKey: k } }); ok('Key updated.'); void load(); } }} className="text-xs text-primary">change key</button>
                    <button onClick={async () => { if (window.confirm(`Remove provider ${p.name}?`)) { await api(`providers/${p.id}`, { method: 'DELETE' }); void load(); } }} className="text-red-300"><Trash2 className="size-3.5" /></button>
                  </span>
                )}
                {p.virtual && <span className="ms-auto text-[11px] text-muted-foreground">from .env.local (ANTHROPIC_API_KEY)</span>}
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <button onClick={() => loadModels(p.id)} className="rounded border border-border px-2 py-0.5 text-xs">List models{models[p.id] ? ` (${models[p.id].length})` : ''}</button>
                <input list={`m-${p.id}`} value={testModel[p.id] ?? ''} onChange={(e) => setTestModel({ ...testModel, [p.id]: e.target.value })} placeholder="model id" className={`${inp} h-7 w-64 font-mono text-xs`} />
                <datalist id={`m-${p.id}`}>{allModelOptions(p.id).map((m) => <option key={m} value={m} />)}</datalist>
                <button onClick={async () => { try { const r = await api<{ model: string; reply: string; ms: number }>(`providers/${p.id}/test`, { method: 'POST', json: { model: testModel[p.id] } }); ok(`${p.name}: ${r.model} replied "${r.reply}" in ${r.ms} ms.`); } catch (e) { fail(e); } }} disabled={!testModel[p.id]} className="rounded border border-primary/40 px-2 py-0.5 text-xs text-indigo-200 disabled:opacity-40">Test</button>
              </div>
            </div>
          ))}
        </div>
        <div className="mt-3 grid gap-2 rounded-lg border border-dashed border-border p-3 md:grid-cols-[150px_1fr_1fr_1fr_auto]">
          <select value={nf.kind} onChange={(e) => setNf({ ...nf, kind: e.target.value })} className={inp}>{d.kinds.map((k) => <option key={k}>{k}</option>)}</select>
          <input value={nf.name} onChange={(e) => setNf({ ...nf, name: e.target.value })} placeholder="Name (optional)" className={inp} />
          <input value={nf.baseUrl} onChange={(e) => setNf({ ...nf, baseUrl: e.target.value })} placeholder={d.defaults[nf.kind] || 'https://… (required for custom)'} className={`${inp} font-mono text-xs`} />
          <input type="password" value={nf.apiKey} onChange={(e) => setNf({ ...nf, apiKey: e.target.value })} placeholder={['ollama', 'lmstudio'].includes(nf.kind) ? 'no key needed' : 'API key'} disabled={['ollama', 'lmstudio'].includes(nf.kind)} className={inp} />
          <button onClick={async () => { try { await api('providers', { method: 'POST', json: { kind: nf.kind, name: nf.name || undefined, baseUrl: nf.baseUrl || undefined, apiKey: nf.apiKey || undefined } }); setNf({ kind: 'openai', name: '', baseUrl: '', apiKey: '' }); ok('Provider added. Add it to job routes below.'); void load(); } catch (e) { fail(e); } }} className={btnP}><Plus className="size-4" /> Add</button>
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-5">
        <h2 className="mb-1 font-semibold text-white">Model per job (with fallback)</h2>
        <p className="mb-3 text-sm text-muted-foreground">Choose a model for each kind of work. The first entry is used; if it is rate-limited, out of credit or down, the next is tried. Empty = default provider/model.</p>
        <div className="space-y-2">
          {d.jobs.map((j) => (
            <div key={j} className="grid gap-2 md:grid-cols-[200px_1fr]">
              <div><div className="font-mono text-sm text-slate-200">{j}</div><div className="text-[11px] text-muted-foreground">{JOB_HELP[j]}</div></div>
              <div className="space-y-1">
                {(routes[j] ?? []).map((r, i) => (
                  <div key={i} className="flex flex-wrap items-center gap-1">
                    <span className="w-4 text-xs text-slate-500">{i + 1}.</span>
                    <select value={r.providerId} onChange={(e) => setRoutes({ ...routes, [j]: routes[j].map((x, k) => (k === i ? { ...x, providerId: e.target.value } : x)) })} className={`${inp} h-7 text-xs`}>{d.providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
                    <input list={`m-${r.providerId}`} value={r.model} onChange={(e) => setRoutes({ ...routes, [j]: routes[j].map((x, k) => (k === i ? { ...x, model: e.target.value } : x)) })} onFocus={() => !models[r.providerId] && loadModels(r.providerId)} placeholder="model id" className={`${inp} h-7 w-64 font-mono text-xs`} />
                    <button onClick={() => setRoutes({ ...routes, [j]: routes[j].filter((_, k) => k !== i) })} className="text-red-300"><Trash2 className="size-3.5" /></button>
                  </div>
                ))}
                <button disabled={!d.providers.length} onClick={() => setRoutes({ ...routes, [j]: [...(routes[j] ?? []), { providerId: d.providers[0]?.id ?? '', model: '' }] })} className="text-xs text-primary">+ {routes[j]?.length ? 'fallback' : 'set model'}</button>
              </div>
            </div>
          ))}
        </div>
        <button onClick={async () => { try { await api('ai/routes', { method: 'PUT', json: routes }); ok('Routes saved.'); } catch (e) { fail(e); } }} className={`${btnP} mt-3`}>Save routes</button>
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-xl border border-border bg-card p-5">
          <h2 className="mb-1 font-semibold text-white">Monthly budget</h2>
          <p className="mb-3 text-sm text-muted-foreground">At the cap, all paid AI calls stop until next month (local models keep working). You get a warning first.</p>
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-xs text-muted-foreground">Warn at $<input value={budget.warnAtUsd} onChange={(e) => setBudget({ ...budget, warnAtUsd: e.target.value })} className={`${inp} mt-1 block w-24`} /></label>
            <label className="text-xs text-muted-foreground">Hard cap $<input value={budget.monthlyCapUsd} onChange={(e) => setBudget({ ...budget, monthlyCapUsd: e.target.value })} className={`${inp} mt-1 block w-24`} /></label>
            <button onClick={async () => { try { await api('budget', { method: 'PUT', json: { monthlyCapUsd: Number(budget.monthlyCapUsd), warnAtUsd: Number(budget.warnAtUsd) } }); ok('Budget saved.'); } catch (e) { fail(e); } }} className={btnP}>Save</button>
          </div>
          <h3 className="mt-5 mb-1 text-sm font-semibold text-white">Private projects</h3>
          <p className="mb-2 text-xs text-muted-foreground">AI for these projects only uses the “private” route (local models). Nothing is sent to cloud providers.</p>
          <div className="max-h-40 overflow-auto">{projects.map((p) => <label key={p.id} className="flex items-center gap-2 text-xs"><input type="checkbox" checked={priv.includes(p.id)} onChange={(e) => setPriv((x) => (e.target.checked ? [...x, p.id] : x.filter((y) => y !== p.id)))} />{p.name}</label>)}</div>
          <button onClick={async () => { await api('settings/advanced', { method: 'PUT', json: { privateProjectIds: priv } }); ok('Private projects saved.'); }} className={`${btnO} mt-2`}>Save private projects</button>
        </div>
        <div className="rounded-xl border border-border bg-card p-5">
          <h2 className="mb-1 font-semibold text-white">Model prices (USD per 1M tokens)</h2>
          <p className="mb-3 text-sm text-muted-foreground">Used for budget tracking. Enter the prices from your provider&apos;s pricing page. A prefix matches model versions (e.g. “claude-sonnet”). OpenRouter reports cost itself; local models are free.</p>
          {prices.map((p, i) => (
            <div key={i} className="mb-1 flex gap-1">
              <input value={p.model} onChange={(e) => setPrices(prices.map((x, k) => (k === i ? { ...x, model: e.target.value } : x)))} placeholder="model or prefix" className={`${inp} h-7 flex-1 font-mono text-xs`} />
              <input value={p.input} onChange={(e) => setPrices(prices.map((x, k) => (k === i ? { ...x, input: e.target.value } : x)))} placeholder="input" className={`${inp} h-7 w-20 text-xs`} />
              <input value={p.output} onChange={(e) => setPrices(prices.map((x, k) => (k === i ? { ...x, output: e.target.value } : x)))} placeholder="output" className={`${inp} h-7 w-20 text-xs`} />
              <button onClick={() => setPrices(prices.filter((_, k) => k !== i))} className="text-red-300"><Trash2 className="size-3.5" /></button>
            </div>
          ))}
          <div className="mt-2 flex gap-2">
            <button onClick={() => setPrices([...prices, { model: '', input: '', output: '' }])} className={btnO}>+ Price</button>
            <button onClick={async () => { try { await api('ai/prices', { method: 'PUT', json: Object.fromEntries(prices.filter((p) => p.model).map((p) => [p.model, { input: Number(p.input), output: Number(p.output) }])) }); ok('Prices saved.'); } catch (e) { fail(e); } }} className={btnP}>Save prices</button>
          </div>
        </div>
      </section>
      {msg && <div className={cn('rounded-lg border px-3 py-2 text-sm', msg.ok ? 'border-success/30 bg-success/10 text-green-200' : 'border-danger/30 bg-danger/10 text-red-200')}>{msg.text}</div>}
    </div>
  );
}

export function AgentPathsSettings() {
  const [d, setD] = useState<{ agents: { agent: string; path: string | null; kind: string | null; source: string | null }[]; paths: Record<string, string> } | null>(null);
  const [paths, setPaths] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(() => api<typeof d>('agents/detect').then((x) => { setD(x); setPaths(x?.paths ?? {}); }), []);
  useEffect(() => {
    void load();
  }, [load]);
  if (!d) return <Loader2 className="size-4 animate-spin" />;
  return (
    <section className="rounded-xl border border-border bg-card p-5">
      <h2 className="mb-1 font-semibold text-white">Agent programs</h2>
      <p className="mb-3 text-sm text-muted-foreground">Detected automatically. Override a path when you install an agent somewhere else; the system adapts immediately.</p>
      {d.agents.map((a) => (
        <div key={a.agent} className="mb-2 grid gap-2 md:grid-cols-[140px_1fr_1fr]">
          <div className="text-sm text-slate-200">{a.agent}</div>
          <div className={cn('truncate font-mono text-xs', a.path ? 'text-success' : 'text-warning')} title={a.path ?? ''}>{a.path ? `${a.path} (${a.kind}, ${a.source})` : 'not found'}</div>
          <input value={paths[a.agent] ?? ''} onChange={(e) => setPaths({ ...paths, [a.agent]: e.target.value })} placeholder="custom path (optional)" className={`${inp} font-mono text-xs`} />
        </div>
      ))}
      <button onClick={async () => { try { await api('agents/paths', { method: 'PUT', json: paths }); setMsg('Saved.'); void load(); } catch (e) { setMsg((e as Error).message); } }} className={btnP}>Save paths</button>
      {msg && <span className="ms-2 text-xs text-muted-foreground">{msg}</span>}
      <p className="mt-3 text-xs text-muted-foreground">Install missing CLIs: OpenCode <code>npm i -g opencode-ai</code> · Claude Code <code>npm i -g @anthropic-ai/claude-code</code> · Codex <code>npm i -g @openai/codex</code>.</p>
    </section>
  );
}

export function AdvancedSettings() {
  const [d, setD] = useState<Record<string, number | boolean> | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    api<Record<string, number | boolean>>('settings/advanced').then(setD);
  }, []);
  if (!d) return null;
  const num = (k: string, label: string, help: string) => (
    <label className="text-xs text-muted-foreground">{label}<input type="number" step="any" value={String(d[k])} onChange={(e) => setD({ ...d, [k]: Number(e.target.value) })} className={`${inp} mt-1 block w-28 text-slate-200`} /><span className="text-[10px]">{help}</span></label>
  );
  return (
    <section className="rounded-xl border border-border bg-card p-5">
      <h2 className="mb-3 font-semibold text-white">AI organization limits</h2>
      <div className="grid gap-4 md:grid-cols-4">
        {num('orgMaxConcurrent', 'Tasks in parallel', '1–6')}
        {num('taskCostCapUsd', 'Max cost per task run ($)', 'stops a runaway agent')}
        {num('agentMaxSteps', 'Max agent steps', 'tool calls per run')}
        {num('maxRework', 'Max review rounds', 'before it goes to you anyway')}
      </div>
      <div className="mt-3 space-y-1 text-sm">
        <label className="flex items-center gap-2"><input type="checkbox" checked={!!d.digestUseAi} onChange={(e) => setD({ ...d, digestUseAi: e.target.checked })} /> Add an AI-written narrative to the daily/weekly brief (uses the digest route)</label>
        <label className="flex items-center gap-2"><input type="checkbox" checked={!!d.remoteApprovals} onChange={(e) => setD({ ...d, remoteApprovals: e.target.checked })} /> Allow answering decisions from the phone (remote access stays read-only otherwise)</label>
      </div>
      <button onClick={async () => { await api('settings/advanced', { method: 'PUT', json: d }); setMsg('Saved.'); }} className={`${btnP} mt-3`}>Save</button>
      {msg && <span className="ms-2 text-xs text-success">{msg}</span>}
    </section>
  );
}

export function RemoteSettings() {
  const [d, setD] = useState<{ allowRemote: boolean; hosts: string[]; accessTeam: string | null; accessAudConfigured: boolean; remoteApprovals: boolean; cloudflaredInstalled: boolean } | null>(null);
  useEffect(() => {
    api<typeof d>('remote/status').then(setD);
  }, []);
  if (!d) return null;
  const ready = d.allowRemote && d.hosts.length && d.accessTeam && d.accessAudConfigured;
  return (
    <section className="rounded-xl border border-border bg-card p-5">
      <h2 className="mb-1 font-semibold text-white">Access from your phone</h2>
      <p className="mb-3 text-sm text-muted-foreground">Through a Cloudflare Tunnel protected by Cloudflare Access (login required). Remote use is read-only unless you allow phone approvals.</p>
      <ul className="mb-3 space-y-1 text-sm">
        <li>{d.cloudflaredInstalled ? '✅' : '⬜'} cloudflared installed</li>
        <li>{d.allowRemote ? '✅' : '⬜'} DEVCONTINUITY_ALLOW_REMOTE=1</li>
        <li>{d.hosts.length ? '✅' : '⬜'} DEVCONTINUITY_REMOTE_HOSTS {d.hosts.join(', ')}</li>
        <li>{d.accessTeam && d.accessAudConfigured ? '✅' : '⬜'} Cloudflare Access verification (CF_ACCESS_TEAM_DOMAIN + CF_ACCESS_AUD)</li>
        <li>{d.remoteApprovals ? '✅ phone can answer decisions' : '🔒 read-only from the phone'}</li>
      </ul>
      {!ready && (
        <ol className="list-decimal space-y-1 ps-5 text-sm text-slate-300">
          <li>Run <code className="text-cyan">powershell -ExecutionPolicy Bypass -File scripts\remote-setup.ps1 -Hostname dc.yourdomain.com</code> (installs cloudflared, creates the tunnel and DNS route).</li>
          <li>In the Cloudflare dashboard → Zero Trust → Access → Applications, add a self-hosted app for that hostname with a policy allowing only your email. Copy its <b>Application Audience (AUD) tag</b>.</li>
          <li>Add to <code>.env.local</code>: <code>DEVCONTINUITY_ALLOW_REMOTE=1</code>, <code>DEVCONTINUITY_REMOTE_HOSTS=dc.yourdomain.com</code>, <code>CF_ACCESS_TEAM_DOMAIN=yourteam.cloudflareaccess.com</code>, <code>CF_ACCESS_AUD=…</code>, then restart from the tray.</li>
          <li>On your phone, open the hostname and choose “Add to Home Screen”.</li>
        </ol>
      )}
    </section>
  );
}
