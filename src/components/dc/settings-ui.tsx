'use client';

import { useCallback, useEffect, useState } from 'react';
import { Loader2, Plus, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import type { Dict } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useT } from './lang';

const btn = 'inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-sm font-medium disabled:opacity-50';
const btnP = `${btn} bg-primary text-white hover:bg-primary/85`;
const btnO = `${btn} border border-border text-slate-200 hover:bg-secondary`;
const inp = 'h-8 rounded-md border border-border bg-background px-2 text-sm';

interface Provider { id: string; kind: string; name: string; baseUrl: string | null; keyRef: string | null; enabled: boolean; models: string[]; virtual?: boolean; hasKey: boolean }
interface ProvData { providers: Provider[]; kinds: string[]; defaults: Record<string, string>; routes: Record<string, { providerId: string; model: string }[]>; jobs: string[]; budget: { monthlyCapUsd: number; warnAtUsd: number }; prices: Record<string, { input: number; output: number }>; privateProjectIds: string[] }

const JOB_HELP: Record<string, keyof Dict> = {
  summary: 'setJobSummary',
  analysis: 'setJobAnalysis',
  plan: 'setJobPlan',
  worker: 'setJobWorker',
  review: 'setJobReview',
  chat: 'setJobChat',
  triage: 'setJobTriage',
  digest: 'setJobDigest',
  embed: 'setJobEmbed',
  private: 'setJobPrivate',
};

const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k: string) => String(v[k] ?? ''));

/** Commands, file names and env vars stay left-to-right inside Arabic text. */
function Ltr({ children, className }: { children: string; className?: string }) {
  return <bdi dir="ltr" className={cn('font-mono text-[0.85em]', className)}>{children}</bdi>;
}

export function ProvidersSettings({ projects }: { projects: { id: string; name: string }[] }) {
  const { t } = useT();
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
        <h2 className="mb-1 font-semibold text-white">{t.setProviders}</h2>
        <p className="mb-3 text-sm text-muted-foreground">{t.setProvidersHelp}</p>
        <div className="space-y-2">
          {d.providers.map((p) => (
            <div key={p.id} className="rounded-lg border border-border bg-background/50 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-white">{p.name}</span>
                <span className="text-xs text-muted-foreground" dir="ltr">{p.kind}{p.baseUrl ? ` · ${p.baseUrl}` : ''}</span>
                <span className={cn('text-xs', p.hasKey ? 'text-success' : 'text-warning')}>{p.hasKey ? (['ollama', 'lmstudio'].includes(p.kind) ? t.setLocalNoKey : t.setKeySet) : t.setNoKey}</span>
                {!p.virtual && (
                  <span className="ms-auto flex items-center gap-2">
                    <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={p.enabled} onChange={async (e) => { await api(`providers/${p.id}`, { method: 'PATCH', json: { enabled: e.target.checked } }); void load(); }} /> {t.setEnabled}</label>
                    <button onClick={async () => { const k = window.prompt(t.setNewKeyPrompt); if (k) { await api(`providers/${p.id}`, { method: 'PATCH', json: { apiKey: k } }); ok(t.setKeyUpdated); void load(); } }} className="text-xs text-primary">{t.setChangeKey}</button>
                    <button onClick={async () => { if (window.confirm(fill(t.setRemoveProvider, { name: p.name }))) { await api(`providers/${p.id}`, { method: 'DELETE' }); void load(); } }} className="text-red-300"><Trash2 className="size-3.5" /></button>
                  </span>
                )}
                {p.virtual && <span className="ms-auto text-[11px] text-muted-foreground">{t.setFromEnv}</span>}
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <button onClick={() => loadModels(p.id)} className="rounded border border-border px-2 py-0.5 text-xs">{t.setListModels}{models[p.id] ? ` (${models[p.id].length})` : ''}</button>
                <input list={`m-${p.id}`} value={testModel[p.id] ?? ''} onChange={(e) => setTestModel({ ...testModel, [p.id]: e.target.value })} placeholder={t.setModelId} dir="ltr" className={`${inp} h-7 w-64 max-w-full font-mono text-xs`} />
                <datalist id={`m-${p.id}`}>{allModelOptions(p.id).map((m) => <option key={m} value={m} />)}</datalist>
                <button onClick={async () => { try { const r = await api<{ model: string; reply: string; ms: number }>(`providers/${p.id}/test`, { method: 'POST', json: { model: testModel[p.id] } }); ok(fill(t.setTestReply, { name: p.name, model: r.model, reply: r.reply, ms: r.ms })); } catch (e) { fail(e); } }} disabled={!testModel[p.id]} className="rounded border border-primary/40 px-2 py-0.5 text-xs text-indigo-200 disabled:opacity-40">{t.setTest}</button>
              </div>
            </div>
          ))}
        </div>
        <div className="mt-3 grid gap-2 rounded-lg border border-dashed border-border p-3 md:grid-cols-[150px_1fr_1fr_1fr_auto]">
          <select value={nf.kind} onChange={(e) => setNf({ ...nf, kind: e.target.value })} className={inp}>{d.kinds.map((k) => <option key={k}>{k}</option>)}</select>
          <input value={nf.name} onChange={(e) => setNf({ ...nf, name: e.target.value })} placeholder={t.setNameOptional} className={inp} />
          <input value={nf.baseUrl} onChange={(e) => setNf({ ...nf, baseUrl: e.target.value })} placeholder={d.defaults[nf.kind] || t.setBaseUrlCustom} dir="ltr" className={`${inp} font-mono text-xs`} />
          <input type="password" value={nf.apiKey} onChange={(e) => setNf({ ...nf, apiKey: e.target.value })} placeholder={['ollama', 'lmstudio'].includes(nf.kind) ? t.setNoKeyNeeded : t.setApiKey} disabled={['ollama', 'lmstudio'].includes(nf.kind)} className={inp} />
          <button onClick={async () => { try { await api('providers', { method: 'POST', json: { kind: nf.kind, name: nf.name || undefined, baseUrl: nf.baseUrl || undefined, apiKey: nf.apiKey || undefined } }); setNf({ kind: 'openai', name: '', baseUrl: '', apiKey: '' }); ok(t.setProviderAdded); void load(); } catch (e) { fail(e); } }} className={btnP}><Plus className="size-4" /> {t.setAdd}</button>
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-5">
        <h2 className="mb-1 font-semibold text-white">{t.setRoutes}</h2>
        <p className="mb-3 text-sm text-muted-foreground">{t.setRoutesHelp}</p>
        <div className="space-y-2">
          {d.jobs.map((j) => (
            <div key={j} className="grid gap-2 md:grid-cols-[200px_1fr]">
              <div><div className="font-mono text-sm text-slate-200">{j}</div><div className="text-[11px] text-muted-foreground">{JOB_HELP[j] ? t[JOB_HELP[j]] : ''}</div></div>
              <div className="space-y-1">
                {(routes[j] ?? []).map((r, i) => (
                  <div key={i} className="flex flex-wrap items-center gap-1">
                    <span className="w-4 text-xs text-slate-500">{i + 1}.</span>
                    <select value={r.providerId} onChange={(e) => setRoutes({ ...routes, [j]: routes[j].map((x, k) => (k === i ? { ...x, providerId: e.target.value } : x)) })} className={`${inp} h-7 text-xs`}>{d.providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
                    <input list={`m-${r.providerId}`} value={r.model} onChange={(e) => setRoutes({ ...routes, [j]: routes[j].map((x, k) => (k === i ? { ...x, model: e.target.value } : x)) })} onFocus={() => !models[r.providerId] && loadModels(r.providerId)} placeholder={t.setModelId} dir="ltr" className={`${inp} h-7 w-64 max-w-full font-mono text-xs`} />
                    <button onClick={() => setRoutes({ ...routes, [j]: routes[j].filter((_, k) => k !== i) })} className="text-red-300"><Trash2 className="size-3.5" /></button>
                  </div>
                ))}
                <button disabled={!d.providers.length} onClick={() => setRoutes({ ...routes, [j]: [...(routes[j] ?? []), { providerId: d.providers[0]?.id ?? '', model: '' }] })} className="text-xs text-primary">+ {routes[j]?.length ? t.setFallback : t.setSetModel}</button>
              </div>
            </div>
          ))}
        </div>
        <button onClick={async () => { try { await api('ai/routes', { method: 'PUT', json: routes }); ok(t.setRoutesSaved); } catch (e) { fail(e); } }} className={`${btnP} mt-3`}>{t.setSaveRoutes}</button>
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-xl border border-border bg-card p-5">
          <h2 className="mb-1 font-semibold text-white">{t.setBudget}</h2>
          <p className="mb-3 text-sm text-muted-foreground">{t.setBudgetHelp}</p>
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-xs text-muted-foreground">{t.setWarnAt}<input value={budget.warnAtUsd} onChange={(e) => setBudget({ ...budget, warnAtUsd: e.target.value })} dir="ltr" className={`${inp} mt-1 block w-24`} /></label>
            <label className="text-xs text-muted-foreground">{t.setHardCap}<input value={budget.monthlyCapUsd} onChange={(e) => setBudget({ ...budget, monthlyCapUsd: e.target.value })} dir="ltr" className={`${inp} mt-1 block w-24`} /></label>
            <button onClick={async () => { try { await api('budget', { method: 'PUT', json: { monthlyCapUsd: Number(budget.monthlyCapUsd), warnAtUsd: Number(budget.warnAtUsd) } }); ok(t.setBudgetSaved); } catch (e) { fail(e); } }} className={btnP}>{t.setSave}</button>
          </div>
          <h3 className="mt-5 mb-1 text-sm font-semibold text-white">{t.setPrivate}</h3>
          <p className="mb-2 text-xs text-muted-foreground">{t.setPrivateHelp}</p>
          <div className="max-h-40 overflow-auto">{projects.map((p) => <label key={p.id} className="flex items-center gap-2 text-xs"><input type="checkbox" checked={priv.includes(p.id)} onChange={(e) => setPriv((x) => (e.target.checked ? [...x, p.id] : x.filter((y) => y !== p.id)))} />{p.name}</label>)}</div>
          <button onClick={async () => { await api('settings/advanced', { method: 'PUT', json: { privateProjectIds: priv } }); ok(t.setPrivateSaved); }} className={`${btnO} mt-2`}>{t.setSavePrivate}</button>
        </div>
        <div className="rounded-xl border border-border bg-card p-5">
          <h2 className="mb-1 font-semibold text-white">{t.setPrices}</h2>
          <p className="mb-3 text-sm text-muted-foreground">{t.setPricesHelp}</p>
          {prices.map((p, i) => (
            <div key={i} className="mb-1 flex gap-1">
              <input value={p.model} onChange={(e) => setPrices(prices.map((x, k) => (k === i ? { ...x, model: e.target.value } : x)))} placeholder={t.setModelOrPrefix} dir="ltr" className={`${inp} h-7 min-w-0 flex-1 font-mono text-xs`} />
              <input value={p.input} onChange={(e) => setPrices(prices.map((x, k) => (k === i ? { ...x, input: e.target.value } : x)))} placeholder={t.setInput} dir="ltr" className={`${inp} h-7 w-20 text-xs`} />
              <input value={p.output} onChange={(e) => setPrices(prices.map((x, k) => (k === i ? { ...x, output: e.target.value } : x)))} placeholder={t.setOutput} dir="ltr" className={`${inp} h-7 w-20 text-xs`} />
              <button onClick={() => setPrices(prices.filter((_, k) => k !== i))} className="text-red-300"><Trash2 className="size-3.5" /></button>
            </div>
          ))}
          <div className="mt-2 flex gap-2">
            <button onClick={() => setPrices([...prices, { model: '', input: '', output: '' }])} className={btnO}>{t.setAddPrice}</button>
            <button onClick={async () => { try { await api('ai/prices', { method: 'PUT', json: Object.fromEntries(prices.filter((p) => p.model).map((p) => [p.model, { input: Number(p.input), output: Number(p.output) }])) }); ok(t.setPricesSaved); } catch (e) { fail(e); } }} className={btnP}>{t.setSavePrices}</button>
          </div>
        </div>
      </section>
      {msg && <div className={cn('rounded-lg border px-3 py-2 text-sm', msg.ok ? 'border-success/30 bg-success/10 text-green-200' : 'border-danger/30 bg-danger/10 text-red-200')}>{msg.text}</div>}
    </div>
  );
}

export function AgentPathsSettings() {
  const { t } = useT();
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
      <h2 className="mb-1 font-semibold text-white">{t.setAgentPrograms}</h2>
      <p className="mb-3 text-sm text-muted-foreground">{t.setAgentProgramsHelp}</p>
      {d.agents.map((a) => (
        <div key={a.agent} className="mb-2 grid gap-2 md:grid-cols-[140px_1fr_1fr]">
          <div className="text-sm text-slate-200">{a.agent}</div>
          <div className={cn('truncate font-mono text-xs', a.path ? 'text-success' : 'text-warning')} title={a.path ?? ''} dir={a.path ? 'ltr' : undefined}>{a.path ? `${a.path} (${a.kind}, ${a.source})` : t.setNotFound}</div>
          <input value={paths[a.agent] ?? ''} onChange={(e) => setPaths({ ...paths, [a.agent]: e.target.value })} placeholder={t.setCustomPath} dir="ltr" className={`${inp} font-mono text-xs`} />
        </div>
      ))}
      <button onClick={async () => { try { await api('agents/paths', { method: 'PUT', json: paths }); setMsg(t.setSaved); void load(); } catch (e) { setMsg((e as Error).message); } }} className={btnP}>{t.setSavePaths}</button>
      {msg && <span className="ms-2 text-xs text-muted-foreground">{msg}</span>}
      <p className="mt-3 text-xs text-muted-foreground">{t.setInstallClis} OpenCode <Ltr>npm i -g opencode-ai</Ltr> · Claude Code <Ltr>npm i -g @anthropic-ai/claude-code</Ltr> · Codex <Ltr>npm i -g @openai/codex</Ltr></p>
    </section>
  );
}

export function AdvancedSettings() {
  const { t } = useT();
  const [d, setD] = useState<Record<string, number | boolean> | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    api<Record<string, number | boolean>>('settings/advanced').then(setD);
  }, []);
  if (!d) return null;
  const num = (k: string, label: string, help: string) => (
    <label className="text-xs text-muted-foreground">{label}<input type="number" step="any" value={String(d[k])} onChange={(e) => setD({ ...d, [k]: Number(e.target.value) })} dir="ltr" className={`${inp} mt-1 block w-28 text-slate-200`} /><span className="text-[10px]">{help}</span></label>
  );
  return (
    <section className="rounded-xl border border-border bg-card p-5">
      <h2 className="mb-3 font-semibold text-white">{t.setOrgLimits}</h2>
      <div className="grid gap-4 md:grid-cols-4">
        {num('orgMaxConcurrent', t.setOrgConcurrent, '1–6')}
        {num('taskCostCapUsd', t.setOrgCostCap, t.setOrgCostCapHelp)}
        {num('agentMaxSteps', t.setOrgSteps, t.setOrgStepsHelp)}
        {num('maxRework', t.setOrgRework, t.setOrgReworkHelp)}
      </div>
      <div className="mt-3 space-y-1 text-sm">
        <label className="flex items-center gap-2"><input type="checkbox" checked={!!d.digestUseAi} onChange={(e) => setD({ ...d, digestUseAi: e.target.checked })} /> {t.setDigestAi}</label>
        <label className="flex items-center gap-2"><input type="checkbox" checked={!!d.remoteApprovals} onChange={(e) => setD({ ...d, remoteApprovals: e.target.checked })} /> {t.setRemoteApprovals}</label>
      </div>
      <button onClick={async () => { await api('settings/advanced', { method: 'PUT', json: d }); setMsg(t.setSaved); }} className={`${btnP} mt-3`}>{t.setSave}</button>
      {msg && <span className="ms-2 text-xs text-success">{msg}</span>}
    </section>
  );
}

function Code({ text }: { text: string }) {
  return <pre dir="ltr" className="mt-1 overflow-x-auto whitespace-pre-wrap break-all rounded-md border border-border bg-black/40 p-2 text-start font-mono text-xs text-cyan">{text}</pre>;
}

export function RemoteSettings() {
  const { t } = useT();
  const [d, setD] = useState<{ allowRemote: boolean; hosts: string[]; accessTeam: string | null; accessAudConfigured: boolean; remoteApprovals: boolean; cloudflaredInstalled: boolean } | null>(null);
  useEffect(() => {
    api<typeof d>('remote/status').then(setD);
  }, []);
  if (!d) return null;
  const ready = d.allowRemote && d.hosts.length && d.accessTeam && d.accessAudConfigured;
  const check = (on: boolean) => <span aria-hidden className="w-5 shrink-0 text-center">{on ? '✅' : '⬜'}</span>;
  return (
    <section className="rounded-xl border border-border bg-card p-5">
      <h2 className="mb-1 font-semibold text-white">{t.setRemote}</h2>
      <p className="mb-3 text-sm text-muted-foreground">{t.setRemoteHelp}</p>
      <ul className="mb-3 space-y-1 text-sm">
        <li className="flex items-center gap-2">{check(d.cloudflaredInstalled)}{t.setCloudflared}</li>
        <li className="flex items-center gap-2">{check(d.allowRemote)}<Ltr>DEVCONTINUITY_ALLOW_REMOTE=1</Ltr></li>
        <li className="flex flex-wrap items-center gap-2">{check(!!d.hosts.length)}<Ltr>DEVCONTINUITY_REMOTE_HOSTS</Ltr>{d.hosts.length > 0 && <Ltr className="text-muted-foreground">{d.hosts.join(', ')}</Ltr>}</li>
        <li className="flex flex-wrap items-center gap-2">{check(!!(d.accessTeam && d.accessAudConfigured))}{t.setAccessCheck} <Ltr className="text-muted-foreground">CF_ACCESS_TEAM_DOMAIN + CF_ACCESS_AUD</Ltr></li>
        <li className="flex items-center gap-2"><span aria-hidden className="w-5 shrink-0 text-center">{d.remoteApprovals ? '✅' : '🔒'}</span>{d.remoteApprovals ? t.setPhoneAnswers : t.setPhoneReadOnly}</li>
      </ul>
      {!ready && (
        <ol className="list-decimal space-y-2 ps-5 text-sm text-slate-300">
          <li>{t.setRemoteStep1}<Code text={'powershell -ExecutionPolicy Bypass -File scripts\\remote-setup.ps1 -Hostname dc.yourdomain.com'} /></li>
          <li>{t.setRemoteStep2}</li>
          <li>{t.setRemoteStep3}<Code text={'DEVCONTINUITY_ALLOW_REMOTE=1\nDEVCONTINUITY_REMOTE_HOSTS=dc.yourdomain.com\nCF_ACCESS_TEAM_DOMAIN=yourteam.cloudflareaccess.com\nCF_ACCESS_AUD=…'} /></li>
          <li>{t.setRemoteStep4}</li>
        </ol>
      )}
    </section>
  );
}
