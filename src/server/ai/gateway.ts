import crypto from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { audit, isKillSwitchOn, notify } from '../audit';
import { getSetting, prisma } from '../db';
import { redactSecrets } from '../security/redact';
import { resolveKeyRef } from '../security/vault';

/**
 * AI Gateway: one interface over every provider.
 * - Anthropic (official SDK, Messages API) and any OpenAI-compatible API: OpenAI, Gemini, OpenRouter,
 *   DeepSeek, Ollama, LM Studio, or a custom endpoint.
 * - Jobs (summary, analysis, plan, worker, review, chat, triage, digest, embed, private) map to an
 *   ordered route of provider+model. On rate limits, exhausted credits, auth failures or outages the
 *   next route entry is tried automatically.
 * - Budgets are enforced before every call; usage and cost are recorded after every call.
 */

export const JOBS = ['summary', 'analysis', 'plan', 'worker', 'review', 'chat', 'triage', 'digest', 'embed', 'private'] as const;
export type Job = (typeof JOBS)[number];
export const PROVIDER_KINDS = ['anthropic', 'openai', 'gemini', 'openrouter', 'deepseek', 'ollama', 'lmstudio', 'openai-compatible'] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];
export const LOCAL_KINDS: ProviderKind[] = ['ollama', 'lmstudio'];

export const DEFAULT_BASE_URL: Record<ProviderKind, string> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
  openrouter: 'https://openrouter.ai/api/v1',
  deepseek: 'https://api.deepseek.com/v1',
  ollama: 'http://127.0.0.1:11434/v1',
  lmstudio: 'http://127.0.0.1:1234/v1',
  'openai-compatible': '',
};

export const ENV_ANTHROPIC_ID = 'env-anthropic';

export class AiError extends Error {
  constructor(message: string, public status = 400, public retryable = false) {
    super(message);
  }
}

// ---------------- Unified message format ----------------
export type Part = { type: 'text'; text: string } | { type: 'tool_call'; id: string; name: string; input: Record<string, unknown> } | { type: 'tool_result'; id: string; content: string; isError?: boolean };
export interface Msg {
  role: 'user' | 'assistant';
  content: string | Part[];
}
export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}
export interface CallContext {
  projectId?: string | null;
  departmentId?: string | null;
  roleId?: string | null;
  runId?: string | null;
  /** owner = triggered by a click; org = AI organization / schedules (blocked by the kill switch). */
  origin?: 'owner' | 'org';
}
export interface ChatRequest {
  job: Job;
  /** Override: "providerId:model" */
  route?: string;
  system?: string;
  messages: Msg[];
  tools?: ToolDef[];
  maxTokens?: number;
  jsonSchema?: Record<string, unknown>;
  ctx?: CallContext;
  signal?: AbortSignal;
}
export interface ChatResponse {
  text: string;
  toolCalls: { id: string; name: string; input: Record<string, unknown> }[];
  stop: 'end' | 'tool' | 'max_tokens';
  model: string;
  providerId: string;
  providerKind: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
}

interface ResolvedProvider {
  id: string;
  kind: ProviderKind;
  name: string;
  baseUrl: string;
  apiKey?: string;
}

export interface RouteEntry {
  providerId: string;
  model: string;
}

// ---------------- Providers ----------------
export async function listProviders(): Promise<{ id: string; kind: string; name: string; baseUrl: string | null; keyRef: string | null; enabled: boolean; models: string[]; virtual?: boolean; hasKey: boolean }[]> {
  const rows = await prisma().provider.findMany({ orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }] });
  const out = await Promise.all(
    rows.map(async (r) => ({ virtual: false as boolean, id: r.id, kind: r.kind, name: r.name, baseUrl: r.baseUrl, keyRef: r.keyRef, enabled: r.enabled, models: r.models ? (JSON.parse(r.models) as string[]) : [], hasKey: !!(await resolveKeyRef(r.keyRef).catch(() => undefined)) || LOCAL_KINDS.includes(r.kind as ProviderKind) })),
  );
  if (process.env.ANTHROPIC_API_KEY?.trim()) {
    out.unshift({ id: ENV_ANTHROPIC_ID, kind: 'anthropic', name: 'Anthropic (ANTHROPIC_API_KEY)', baseUrl: null, keyRef: 'env:ANTHROPIC_API_KEY', enabled: true, models: process.env.ANTHROPIC_MODEL ? [process.env.ANTHROPIC_MODEL] : [], virtual: true, hasKey: true });
  }
  return out;
}

async function resolveProvider(id: string): Promise<ResolvedProvider> {
  if (id === ENV_ANTHROPIC_ID) {
    const key = process.env.ANTHROPIC_API_KEY?.trim();
    if (!key) throw new AiError('ANTHROPIC_API_KEY is not set.', 412);
    return { id, kind: 'anthropic', name: 'Anthropic (env)', baseUrl: DEFAULT_BASE_URL.anthropic, apiKey: key };
  }
  const row = await prisma().provider.findUnique({ where: { id } });
  if (!row) throw new AiError(`Provider ${id} not found.`, 404);
  if (!row.enabled) throw new AiError(`Provider "${row.name}" is disabled.`, 412);
  const kind = row.kind as ProviderKind;
  const apiKey = await resolveKeyRef(row.keyRef);
  if (!apiKey && !LOCAL_KINDS.includes(kind)) throw new AiError(`Provider "${row.name}" has no API key.`, 412);
  return { id, kind, name: row.name, baseUrl: (row.baseUrl || DEFAULT_BASE_URL[kind]).replace(/\/+$/, ''), apiKey };
}

export function validateBaseUrl(url: string): string {
  const u = new URL(url);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) throw new AiError('Base URL must be https (http is allowed only for localhost).');
  return u.toString().replace(/\/+$/, '');
}

const anthropicClients = new Map<string, Anthropic>();
function anthropic(p: ResolvedProvider): Anthropic {
  const k = `${p.id}:${p.apiKey}`;
  let c = anthropicClients.get(k);
  if (!c) {
    c = new Anthropic({ apiKey: p.apiKey, maxRetries: 2, timeout: 300_000, ...(p.baseUrl && p.baseUrl !== DEFAULT_BASE_URL.anthropic ? { baseURL: p.baseUrl } : {}) });
    anthropicClients.set(k, c);
  }
  return c;
}

export async function listProviderModels(providerId: string): Promise<string[]> {
  const p = await resolveProvider(providerId);
  if (p.kind === 'anthropic') {
    const page = await anthropic(p).models.list({ limit: 100 });
    return page.data.map((m) => m.id);
  }
  const res = await fetch(`${p.baseUrl}/models`, { headers: p.apiKey ? { Authorization: `Bearer ${p.apiKey}` } : {}, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new AiError(`Model list failed (${res.status}).`, res.status);
  const data = (await res.json()) as { data?: { id: string }[]; models?: { name: string }[] };
  return (data.data?.map((m) => m.id) ?? data.models?.map((m) => m.name) ?? []).map((m) => m.replace(/^models\//, '')).sort();
}

// ---------------- Routes ----------------
export async function getRoutes(): Promise<Record<Job, RouteEntry[]>> {
  const saved = await getSetting<Partial<Record<Job, RouteEntry[]>>>('aiRoutes', {});
  const out = {} as Record<Job, RouteEntry[]>;
  for (const j of JOBS) out[j] = saved[j] ?? [];
  return out;
}

/** Model to use when a job has no explicit route: Settings > ANTHROPIC_MODEL > first model from the API. */
let detectedDefault: string | undefined;
async function defaultRoute(): Promise<RouteEntry[]> {
  const providers = (await listProviders()).filter((p) => p.enabled && p.hasKey);
  const first = providers[0];
  if (!first) return [];
  const settingModel = (await getSetting<string>('aiModel', '')).trim();
  let model = settingModel || (first.id === ENV_ANTHROPIC_ID ? process.env.ANTHROPIC_MODEL?.trim() : first.models[0]) || detectedDefault;
  if (!model) {
    const models = await listProviderModels(first.id).catch(() => []);
    model = detectedDefault = models[0];
  }
  return model ? [{ providerId: first.id, model }] : [];
}

async function routeFor(req: ChatRequest): Promise<RouteEntry[]> {
  if (req.route?.includes(':')) {
    const i = req.route.indexOf(':');
    return [{ providerId: req.route.slice(0, i), model: req.route.slice(i + 1) }];
  }
  const private_ = req.ctx?.projectId && (await getSetting<string[]>('privateProjectIds', [])).includes(req.ctx.projectId);
  const job: Job = private_ ? 'private' : ((req.route as Job) && JOBS.includes(req.route as Job) ? (req.route as Job) : req.job);
  const routes = await getRoutes();
  const list = routes[job].length ? routes[job] : job === 'private' ? [] : await defaultRoute();
  if (job === 'private') {
    const providers = await prisma().provider.findMany({ where: { id: { in: list.map((l) => l.providerId) } } });
    const nonLocal = providers.filter((p) => !LOCAL_KINDS.includes(p.kind as ProviderKind));
    if (!list.length || nonLocal.length) throw new AiError('This project is marked private: configure the "private" route with a local provider (Ollama or LM Studio). Nothing was sent.', 412);
  }
  if (!list.length) throw new AiError('No AI provider is configured. Add ANTHROPIC_API_KEY to .env.local or add a provider in Settings → AI Providers.', 412);
  return list;
}

// ---------------- Budget & pricing ----------------
export interface BudgetSettings {
  monthlyCapUsd: number;
  warnAtUsd: number;
}
export async function getBudget(): Promise<BudgetSettings> {
  return getSetting<BudgetSettings>('budget', { monthlyCapUsd: 50, warnAtUsd: 25 });
}

export function monthStart(d = new Date()): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

export async function spentThisMonth(departmentId?: string): Promise<number> {
  const agg = await prisma().usageRecord.aggregate({ where: { at: { gte: monthStart() }, departmentId: departmentId ?? undefined }, _sum: { costUsd: true } });
  return agg._sum.costUsd ?? 0;
}

export type PriceTable = Record<string, { input: number; output: number }>;
export async function priceFor(model: string): Promise<{ input: number; output: number } | undefined> {
  const table = await getSetting<PriceTable>('modelPrices', {});
  if (table[model]) return table[model];
  const key = Object.keys(table).filter((k) => model.startsWith(k)).sort((a, b) => b.length - a.length)[0];
  return key ? table[key] : undefined;
}

async function checkBudget(ctx: CallContext | undefined, providerKind: string): Promise<void> {
  if (LOCAL_KINDS.includes(providerKind as ProviderKind)) return; // local models cost nothing
  const b = await getBudget();
  const spent = await spentThisMonth();
  if (b.monthlyCapUsd > 0 && spent >= b.monthlyCapUsd) {
    await notify('error', 'Monthly AI budget reached', `Spent $${spent.toFixed(2)} of $${b.monthlyCapUsd}. AI calls are paused until next month or until you raise the cap in Settings.`, '/settings?tab=ai', `budget-cap-${monthStart().toISOString().slice(0, 7)}`);
    throw new AiError(`Monthly AI budget of $${b.monthlyCapUsd} reached ($${spent.toFixed(2)} spent). Raise it in Settings to continue.`, 402);
  }
  if (ctx?.departmentId) {
    const dept = await prisma().department.findUnique({ where: { id: ctx.departmentId } });
    if (dept?.budgetUsd && (await spentThisMonth(dept.id)) >= dept.budgetUsd) throw new AiError(`The ${dept.name} department reached its monthly budget of $${dept.budgetUsd}.`, 402);
  }
}

async function recordUsage(r: ChatResponse, job: Job, ctx: CallContext | undefined, cached: boolean, apiCost?: number) {
  let cost: number | null = apiCost ?? null;
  if (cost == null) {
    if (LOCAL_KINDS.includes(r.providerKind as ProviderKind)) cost = 0;
    else {
      const p = await priceFor(r.model);
      if (p) cost = (r.inputTokens * p.input + r.outputTokens * p.output) / 1_000_000;
      else await notify('warning', `No price set for model ${r.model}`, 'Budget tracking cannot count this model until you enter its price per million tokens in Settings → AI → Prices.', '/settings?tab=ai', `price-missing-${r.model}`);
    }
  }
  r.costUsd = cached ? 0 : cost;
  await prisma().usageRecord.create({ data: { providerId: r.providerId, providerKind: r.providerKind, model: r.model, job, projectId: ctx?.projectId ?? null, departmentId: ctx?.departmentId ?? null, roleId: ctx?.roleId ?? null, runId: ctx?.runId ?? null, inputTokens: cached ? 0 : r.inputTokens, outputTokens: cached ? 0 : r.outputTokens, costUsd: r.costUsd, cached } });
  if (!cached && cost) {
    const b = await getBudget();
    const spent = await spentThisMonth();
    if (b.warnAtUsd > 0 && spent >= b.warnAtUsd) await notify('warning', 'AI spending passed your warning level', `$${spent.toFixed(2)} spent this month (warning at $${b.warnAtUsd}, cap $${b.monthlyCapUsd}).`, '/costs', `budget-warn-${monthStart().toISOString().slice(0, 7)}`);
  }
}

// ---------------- Provider calls ----------------
function toAnthropic(messages: Msg[]): Anthropic.MessageParam[] {
  return messages.map((m) => ({
    role: m.role,
    content: typeof m.content === 'string' ? m.content : m.content.map((p): Anthropic.ContentBlockParam => (p.type === 'text' ? { type: 'text', text: p.text } : p.type === 'tool_call' ? { type: 'tool_use', id: p.id, name: p.name, input: p.input } : { type: 'tool_result', tool_use_id: p.id, content: p.content, is_error: p.isError })),
  }));
}

async function callAnthropic(p: ResolvedProvider, model: string, req: ChatRequest): Promise<ChatResponse> {
  const params: Anthropic.MessageCreateParamsNonStreaming = {
    model,
    max_tokens: req.maxTokens ?? 4096,
    messages: toAnthropic(req.messages),
    ...(req.system ? { system: req.system } : {}),
    ...(req.tools?.length ? { tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters as Anthropic.Tool.InputSchema })) } : {}),
    ...(req.jsonSchema ? { output_config: { format: { type: 'json_schema' as const, schema: req.jsonSchema } } } : {}),
  };
  let res: Anthropic.Message;
  try {
    res = await anthropic(p).messages.create(params, { signal: req.signal });
  } catch (e) {
    if (req.jsonSchema && e instanceof Anthropic.BadRequestError && /output_config|json_schema|format/i.test(e.message)) {
      const { output_config: _drop, ...rest } = params as Anthropic.MessageCreateParamsNonStreaming & { output_config?: unknown };
      void _drop;
      res = await anthropic(p).messages.create({ ...rest, system: `${req.system ?? ''}\n\nRespond with one JSON object matching this JSON Schema and nothing else:\n${JSON.stringify(req.jsonSchema)}` }, { signal: req.signal });
    } else throw e;
  }
  return {
    text: res.content.map((b) => (b.type === 'text' ? b.text : '')).join(''),
    toolCalls: res.content.flatMap((b) => (b.type === 'tool_use' ? [{ id: b.id, name: b.name, input: (b.input ?? {}) as Record<string, unknown> }] : [])),
    stop: res.stop_reason === 'tool_use' ? 'tool' : res.stop_reason === 'max_tokens' ? 'max_tokens' : 'end',
    model: res.model ?? model,
    providerId: p.id,
    providerKind: p.kind,
    inputTokens: res.usage.input_tokens ?? 0,
    outputTokens: res.usage.output_tokens ?? 0,
    costUsd: null,
  };
}

function toOpenAI(system: string | undefined, messages: Msg[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  if (system) out.push({ role: 'system', content: system });
  for (const m of messages) {
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    if (m.role === 'assistant') {
      const text = m.content.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('');
      const calls = m.content.filter((p) => p.type === 'tool_call') as Extract<Part, { type: 'tool_call' }>[];
      out.push({ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.input) } })) } : {}) });
    } else {
      const text = m.content.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('');
      for (const r of m.content.filter((p) => p.type === 'tool_result') as Extract<Part, { type: 'tool_result' }>[]) out.push({ role: 'tool', tool_call_id: r.id, content: r.isError ? `ERROR: ${r.content}` : r.content });
      if (text) out.push({ role: 'user', content: text });
    }
  }
  return out;
}

async function callOpenAI(p: ResolvedProvider, model: string, req: ChatRequest): Promise<{ r: ChatResponse; apiCost?: number }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (p.apiKey) headers.Authorization = `Bearer ${p.apiKey}`;
  if (p.kind === 'openrouter') {
    headers['HTTP-Referer'] = 'http://localhost';
    headers['X-Title'] = 'DevContinuity';
  }
  const base: Record<string, unknown> = { model, messages: toOpenAI(req.system, req.messages), max_tokens: req.maxTokens ?? 4096 };
  if (req.tools?.length) base.tools = req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
  if (p.kind === 'openrouter') base.usage = { include: true };
  const attempts: Record<string, unknown>[] = req.jsonSchema
    ? [{ ...base, response_format: { type: 'json_schema', json_schema: { name: 'result', strict: true, schema: req.jsonSchema } } }, { ...base, response_format: { type: 'json_object' }, messages: toOpenAI(`${req.system ?? ''}\n\nRespond with one JSON object matching this JSON Schema:\n${JSON.stringify(req.jsonSchema)}`, req.messages) }, { ...base, messages: toOpenAI(`${req.system ?? ''}\n\nRespond with one JSON object matching this JSON Schema and nothing else:\n${JSON.stringify(req.jsonSchema)}`, req.messages) }]
    : [base];
  let lastErr: AiError | undefined;
  for (const body of attempts) {
    const res = await fetch(`${p.baseUrl}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body), signal: req.signal ?? AbortSignal.timeout(300_000) });
    if (res.ok) {
      const data = (await res.json()) as { model?: string; choices: { message: { content?: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] }; finish_reason?: string }[]; usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number } };
      const choice = data.choices?.[0];
      const calls = (choice?.message.tool_calls ?? []).map((c) => {
        let input: Record<string, unknown> = {};
        try {
          input = JSON.parse(c.function.arguments || '{}');
        } catch {
          input = { _raw: c.function.arguments };
        }
        return { id: c.id, name: c.function.name, input };
      });
      return {
        r: { text: choice?.message.content ?? '', toolCalls: calls, stop: calls.length ? 'tool' : choice?.finish_reason === 'length' ? 'max_tokens' : 'end', model: data.model ?? model, providerId: p.id, providerKind: p.kind, inputTokens: data.usage?.prompt_tokens ?? 0, outputTokens: data.usage?.completion_tokens ?? 0, costUsd: null },
        apiCost: typeof data.usage?.cost === 'number' ? data.usage.cost : undefined,
      };
    }
    const text = (await res.text()).slice(0, 400);
    lastErr = new AiError(`${p.name} error ${res.status}: ${redactSecrets(text)}`, res.status, res.status === 429 || res.status >= 500 || res.status === 402 || res.status === 401 || res.status === 403 || res.status === 404);
    if (res.status !== 400 && res.status !== 422) break; // only schema-format problems try the next format
  }
  throw lastErr ?? new AiError(`${p.name}: request failed.`, 502);
}

function translate(e: unknown, p: ResolvedProvider): AiError {
  if (e instanceof AiError) return e;
  if (e instanceof Anthropic.APIError) {
    const s = e.status ?? 502;
    const msg = s === 429 ? 'rate limit / usage limit reached' : s === 401 ? 'API key rejected' : s === 403 ? 'not permitted' : s === 404 ? 'model not found' : s === 402 ? 'out of credits' : e.message.slice(0, 200);
    return new AiError(`${p.name}: ${msg} (${s})`, s, s === 429 || s >= 500 || s === 401 || s === 403 || s === 404 || s === 402 || s === 529);
  }
  const err = e as Error;
  if (err?.name === 'AbortError') return new AiError('The request was cancelled.', 499);
  return new AiError(`${p.name}: ${err?.message?.slice(0, 200) ?? 'request failed'}`, 503, true);
}

/** One chat completion with routing, fallback, budget and usage accounting. */
export async function chat(req: ChatRequest): Promise<ChatResponse> {
  if (req.ctx?.origin === 'org' && (await isKillSwitchOn())) throw new AiError('The kill switch is on: AI organization activity is stopped.', 423);
  const routes = await routeFor(req);
  const errors: string[] = [];
  for (let i = 0; i < routes.length; i++) {
    const { providerId, model } = routes[i];
    let p: ResolvedProvider;
    try {
      p = await resolveProvider(providerId);
    } catch (e) {
      errors.push((e as Error).message);
      continue;
    }
    if (!LOCAL_KINDS.includes(p.kind) && !(await getSetting<boolean>('aiConsent', false))) throw new AiError('AI features are disabled. Enable them in Settings → AI; nothing is sent until you do.', 403);
    await checkBudget(req.ctx, p.kind);
    try {
      const out = p.kind === 'anthropic' ? { r: await callAnthropic(p, model, req), apiCost: undefined } : await callOpenAI(p, model, req);
      await recordUsage(out.r, req.job, req.ctx, false, out.apiCost);
      if (i > 0) await notify('warning', `Switched AI provider for ${req.job}`, `Used ${p.name} / ${model} because earlier providers failed: ${errors.join(' | ')}`, '/settings?tab=ai');
      return out.r;
    } catch (e) {
      const err = translate(e, p);
      errors.push(err.message);
      if (!err.retryable || i === routes.length - 1) {
        if (err.retryable) await notify('error', `AI provider failed for ${req.job}`, errors.join(' | '), '/settings?tab=ai', `provider-fail-${req.job}-${new Date().toISOString().slice(0, 13)}`);
        throw err;
      }
    }
  }
  throw new AiError(`No provider could handle this request: ${errors.join(' | ')}`, 503);
}

// ---------------- Structured output ----------------
function strictSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(strictSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const o: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema as Record<string, unknown>)) if (k !== '$schema') o[k] = strictSchema(v);
  if (o.type === 'object') {
    o.additionalProperties = false;
    if (o.properties && typeof o.properties === 'object') o.required = Object.keys(o.properties as object);
  }
  return o;
}

export function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return strictSchema(z.toJSONSchema(schema)) as Record<string, unknown>;
}

export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (fenced ? fenced[1] : text).trim();
  const start = body.search(/[[{]/);
  return JSON.parse(start > 0 ? body.slice(start) : body);
}

export interface StructuredResult<T> {
  data: T;
  model: string;
  cached: boolean;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
}

/** Structured JSON call validated with zod, cached by content hash. */
export async function structured<S extends z.ZodType>(job: Job, schema: S, system: string, user: string, opts: { maxTokens?: number; ctx?: CallContext; route?: string; signal?: AbortSignal } = {}): Promise<StructuredResult<z.infer<S>>> {
  const prompt = redactSecrets(user);
  const routeKey = opts.route ?? job;
  const key = crypto.createHash('sha256').update(`${job}\n${routeKey}\n${system}\n${prompt}`).digest('hex');
  const db = prisma();
  const hit = await db.aiCache.findUnique({ where: { key } });
  if (hit) {
    const parsed = schema.safeParse(JSON.parse(hit.output));
    if (parsed.success) {
      await prisma().usageRecord.create({ data: { providerKind: 'cache', model: hit.model, job, projectId: opts.ctx?.projectId ?? null, departmentId: opts.ctx?.departmentId ?? null, roleId: opts.ctx?.roleId ?? null, cached: true, costUsd: 0 } });
      return { data: parsed.data, model: hit.model, cached: true, inputTokens: hit.inputTokens, outputTokens: hit.outputTokens, costUsd: 0 };
    }
  }
  const r = await chat({ job, route: opts.route, system, messages: [{ role: 'user', content: prompt }], maxTokens: opts.maxTokens ?? 4000, jsonSchema: toJsonSchema(schema), ctx: opts.ctx, signal: opts.signal });
  if (r.stop === 'max_tokens') throw new AiError('The model ran out of output tokens before finishing. Try a smaller scope.', 502);
  let raw: unknown;
  try {
    raw = extractJson(r.text);
  } catch {
    throw new AiError('The model did not return valid JSON.', 502);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new AiError(`The model output did not match the expected structure: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`, 502);
  await db.aiCache.upsert({ where: { key }, create: { key, feature: job, model: r.model, output: JSON.stringify(parsed.data), inputTokens: r.inputTokens, outputTokens: r.outputTokens }, update: { output: JSON.stringify(parsed.data) } });
  return { data: parsed.data, model: r.model, cached: false, inputTokens: r.inputTokens, outputTokens: r.outputTokens, costUsd: r.costUsd };
}

/** Plain text completion. */
export async function complete(job: Job, system: string, user: string, opts: { maxTokens?: number; ctx?: CallContext; route?: string } = {}): Promise<ChatResponse> {
  return chat({ job, route: opts.route, system, messages: [{ role: 'user', content: redactSecrets(user) }], maxTokens: opts.maxTokens ?? 2000, ctx: opts.ctx });
}

// ---------------- Embeddings (optional; local or API) ----------------
export async function embed(texts: string[], ctx?: CallContext): Promise<{ vectors: number[][]; model: string } | null> {
  const routes = (await getRoutes()).embed;
  if (!routes.length) return null;
  const { providerId, model } = routes[0];
  const p = await resolveProvider(providerId);
  if (p.kind === 'anthropic') throw new AiError('Anthropic does not offer an embeddings API. Use Ollama, LM Studio, OpenAI or another provider for the "embed" route.');
  if (!LOCAL_KINDS.includes(p.kind) && !(await getSetting<boolean>('aiConsent', false))) throw new AiError('AI features are disabled in Settings.', 403);
  await checkBudget(ctx, p.kind);
  const res = await fetch(`${p.baseUrl}/embeddings`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(p.apiKey ? { Authorization: `Bearer ${p.apiKey}` } : {}) }, body: JSON.stringify({ model, input: texts.map((t) => redactSecrets(t).slice(0, 8000)) }), signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new AiError(`Embedding request failed (${res.status}).`, res.status);
  const data = (await res.json()) as { data: { embedding: number[] }[]; usage?: { prompt_tokens?: number } };
  await prisma().usageRecord.create({ data: { providerId: p.id, providerKind: p.kind, model, job: 'embed', inputTokens: data.usage?.prompt_tokens ?? 0, costUsd: LOCAL_KINDS.includes(p.kind) ? 0 : null } });
  return { vectors: data.data.map((d) => d.embedding), model };
}

export async function testProvider(providerId: string, model: string): Promise<{ ok: true; model: string; reply: string; ms: number }> {
  const t = Date.now();
  const r = await chat({ job: 'summary', route: `${providerId}:${model}`, messages: [{ role: 'user', content: 'Reply with the single word: ready' }], maxTokens: 20, ctx: { origin: 'owner' } });
  await audit('owner', 'ai.test', providerId, { model });
  return { ok: true, model: r.model, reply: r.text.trim().slice(0, 60), ms: Date.now() - t };
}
