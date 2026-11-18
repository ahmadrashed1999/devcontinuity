import fs from 'node:fs';
import path from 'node:path';
import { dataPath, ensureDir } from '../config';

/**
 * Live capture spool. Everything an agent reports about itself (hook payloads, OpenTelemetry log
 * records, MCP log calls, direct API posts) is appended unchanged, one JSON line per record, to
 *   data/live/<agent>/<session>.jsonl
 * The `live` adapter turns these files into normal sessions through the regular importer, so live
 * sessions get the same archive, search, tasks and handoffs as file-based ones.
 * scripts/hook.mjs writes the same format directly (it must work while the server is down).
 */
export type LiveSource = 'hook' | 'otlp' | 'mcp' | 'api';

export interface LiveRecord {
  v: 1;
  /** When DevContinuity received it (ISO). */
  at: string;
  source: LiveSource;
  agent: string;
  session: string;
  /** Working directory of the process that reported it, when known. */
  cwd?: string;
  payload: unknown;
}

const MAX_LINE = 2 * 1024 * 1024;
const MAX_STRING = 200_000;

/** Ids become file names: keep them short and filesystem-safe. */
export function safeId(v: unknown, fallback: string): string {
  const s = typeof v === 'string' || typeof v === 'number' ? String(v) : '';
  const clean = s.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^[._]+/, '').slice(0, 100);
  return clean || fallback;
}

export function normalizeAgentId(v: unknown): string {
  const s = String(v ?? '').toLowerCase().trim();
  if (!s) return 'unknown';
  if (s.startsWith('claude')) return 'claude-code';
  if (s.startsWith('codex')) return 'codex';
  if (s.startsWith('gemini')) return 'gemini-cli';
  return safeId(s.replace(/\s+/g, '-'), 'unknown').toLowerCase();
}

/** Clips huge strings so one tool output cannot produce a multi-megabyte line. The clip is marked. */
export function clipDeep(v: unknown, depth = 0): unknown {
  if (typeof v === 'string') return v.length > MAX_STRING ? `${v.slice(0, MAX_STRING)}…[clipped ${v.length - MAX_STRING} chars]` : v;
  if (depth > 12 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.slice(0, 5000).map((x) => clipDeep(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = clipDeep(x, depth + 1);
  return out;
}

export function liveDir(): string {
  return ensureDir(dataPath('live'));
}

export function appendLive(rec: Omit<LiveRecord, 'v' | 'at'> & { at?: string }): string {
  const agent = normalizeAgentId(rec.agent);
  const session = safeId(rec.session, `${agent}-${new Date().toISOString().slice(0, 10)}`);
  const full: LiveRecord = { v: 1, at: rec.at ?? new Date().toISOString(), source: rec.source, agent, session, cwd: rec.cwd, payload: clipDeep(rec.payload) };
  let line = JSON.stringify(full);
  if (line.length > MAX_LINE) line = JSON.stringify({ ...full, payload: { clipped: true, preview: line.slice(0, 50_000) } });
  const file = path.join(ensureDir(path.join(liveDir(), agent)), `${session}.jsonl`);
  fs.appendFileSync(file, `${line}\n`, 'utf8');
  return file;
}

export interface LiveStream {
  agent: string;
  session: string;
  file: string;
  size: number;
  mtime: Date;
}

export function listLiveStreams(): LiveStream[] {
  const root = liveDir();
  const out: LiveStream[] = [];
  for (const agent of fs.readdirSync(root)) {
    const dir = path.join(root, agent);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const n of fs.readdirSync(dir)) {
      if (!n.endsWith('.jsonl')) continue;
      const file = path.join(dir, n);
      const st = fs.statSync(file);
      out.push({ agent, session: n.slice(0, -6), file, size: st.size, mtime: st.mtime });
    }
  }
  return out;
}
