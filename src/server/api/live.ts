import type { NextRequest } from 'next/server';
import { agentLabel } from '../adapters';
import { prisma } from '../db';
import { Features, getFeatures, setFeatures } from '../features';
import { applyConnect, CONNECT_AGENTS, ConnectAgent, connectionStatus, planConnect } from '../live/connect';
import { ingestOtlpLogs } from '../live/otlp';
import { appendLive, listLiveStreams, normalizeAgentId } from '../live/store';

type Handler = (req: NextRequest, m: string[]) => Promise<Response>;
const json = (data: unknown, status = 200) => Response.json(data, { status });
type Rec = Record<string, unknown>;

const MAX_BODY = 16 * 1024 * 1024;

async function readJson(req: NextRequest): Promise<unknown> {
  const len = Number(req.headers.get('content-length') ?? 0);
  if (len > MAX_BODY) throw Object.assign(new Error('Payload too large.'), { status: 413 });
  const text = await req.text();
  if (text.length > MAX_BODY) throw Object.assign(new Error('Payload too large.'), { status: 413 });
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error('Body must be JSON.'), { status: 400 });
  }
}

const sessionOf = (p: Rec) => p.session_id ?? p.sessionId ?? p.conversation_id ?? p.trajectory_id ?? p.thread_id ?? p.session;

/** OTLP/HTTP accepts logs; traces and metrics are acknowledged and dropped so exporters stay quiet. */
const otlp: Handler = async (req) => {
  if (/protobuf/i.test(req.headers.get('content-type') ?? '')) return json({ error: 'DevContinuity accepts OTLP as JSON. Set OTEL_EXPORTER_OTLP_PROTOCOL=http/json (or otlpProtocol "http" for Gemini CLI).' }, 415);
  const body = (await readJson(req)) as Rec;
  if (Array.isArray(body?.resourceLogs)) {
    const r = ingestOtlpLogs(body);
    return json({ partialSuccess: {}, stored: r.stored });
  }
  return json({ partialSuccess: {} });
};

const hook: Handler = async (req, m) => {
  const p = ((await readJson(req)) ?? {}) as Rec;
  const agent = normalizeAgentId(m[0] ?? req.nextUrl.searchParams.get('agent'));
  appendLive({ source: 'hook', agent, session: String(sessionOf(p) ?? ''), cwd: typeof p.cwd === 'string' ? p.cwd : undefined, payload: p });
  return json({ ok: true });
};

/** Generic event API for any tool: { agent, session, kind, text, ... } or { agent, session, events: [...] }. */
const event: Handler = async (req) => {
  const b = ((await readJson(req)) ?? {}) as Rec;
  const agent = normalizeAgentId(b.agent);
  if (agent === 'unknown') return json({ error: 'Pass "agent" (for example "aider" or "my-tool").' }, 400);
  const list = Array.isArray(b.events) ? (b.events as Rec[]) : [b];
  for (const e of list.slice(0, 1000)) appendLive({ source: 'api', agent, session: String(e.session ?? b.session ?? ''), cwd: typeof (e.cwd ?? b.cwd) === 'string' ? String(e.cwd ?? b.cwd) : undefined, payload: e });
  return json({ ok: true, stored: Math.min(list.length, 1000) });
};

function connectAgent(v: unknown): ConnectAgent {
  if (!CONNECT_AGENTS.includes(v as ConnectAgent)) throw Object.assign(new Error(`agent must be one of: ${CONNECT_AGENTS.join(', ')}`), { status: 400 });
  return v as ConnectAgent;
}

export const liveRoutes: [string, string, Handler][] = [
  ['POST', 'ingest/hook/:agent', hook],
  ['POST', 'ingest/event', event],
  ['POST', 'ingest/t/:token/hook/:agent', (req, m) => hook(req, m.slice(1))],
  ['POST', 'ingest/t/:token/event', event],
  ['POST', 'otlp', otlp],
  ['POST', 'otlp/v1/logs', otlp],
  ['POST', 'otlp/v1/traces', otlp],
  ['POST', 'otlp/v1/metrics', otlp],
  ['POST', 'otlp/t/:token', otlp],
  ['POST', 'otlp/t/:token/v1/logs', otlp],
  ['POST', 'otlp/t/:token/v1/traces', otlp],
  ['POST', 'otlp/t/:token/v1/metrics', otlp],

  // Which agents are connected, and what each one has sent.
  ['GET', 'live/status', async () => {
    const streams = listLiveStreams();
    const byAgent = new Map<string, { sessions: number; bytes: number; last: Date | null }>();
    for (const s of streams) {
      const a = byAgent.get(s.agent) ?? { sessions: 0, bytes: 0, last: null };
      a.sessions++;
      a.bytes += s.size;
      if (!a.last || s.mtime > a.last) a.last = s.mtime;
      byAgent.set(s.agent, a);
    }
    const counts = await prisma().session.groupBy({ by: ['agent'], _count: true, _max: { endedAt: true } });
    return json({
      connections: connectionStatus(),
      liveStreams: [...byAgent.entries()].map(([agent, v]) => ({ agent, label: agentLabel(agent), ...v })),
      sessionsByAgent: counts.map((c) => ({ agent: c.agent, label: agentLabel(c.agent), sessions: c._count, lastActivity: c._max.endedAt })),
    });
  }],
  ['GET', 'features', async () => json(await getFeatures())],
  ['PUT', 'features', async (req) => json(await setFeatures(((await readJson(req)) ?? {}) as Partial<Features>))],
  ['POST', 'live/connect', async (req) => {
    const b = ((await readJson(req)) ?? {}) as Rec;
    const plan = planConnect(connectAgent(b.agent), { telemetry: b.telemetry === true, remove: b.remove === true });
    if (b.apply !== true) return json({ plan: { ...plan, changes: plan.changes.map((c) => ({ file: c.file, description: c.description, exists: c.before != null })) } });
    const res = applyConnect(plan);
    return json({ applied: true, ...res, commands: plan.commands, notes: plan.notes });
  }],
];
