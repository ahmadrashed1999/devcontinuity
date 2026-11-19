import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { pathKey } from '../security/paths';
import { cachedWorkingCopy, hasTable, openWorkingCopy } from './sqlite-util';
import { AgentAdapter, AgentInventory, DiscoveredSession, ParseContext, SessionAccumulator, SessionSink, asRecord, clip, compactJson, str, toDate } from './types';

/**
 * Zed's assistant. Two stores:
 * - text threads: conversations/*.zed.json (the whole buffer plus message offsets and roles);
 * - agent threads: threads/threads.db, one row per thread holding JSON (plain or zstd-compressed).
 * Zed changes these formats between releases, so this adapter reads the shapes seen so far and records
 * anything else as unknown instead of failing. Experimental.
 */

type Rec = Record<string, unknown>;

function zedDirs(): { conversations: string; threads: string }[] {
  const home = os.homedir();
  const out: { conversations: string; threads: string }[] = [];
  if (process.platform === 'win32') {
    out.push({ conversations: path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'Zed', 'conversations'), threads: path.join(process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'Zed', 'threads') });
  } else if (process.platform === 'darwin') {
    out.push({ conversations: path.join(home, '.config', 'zed', 'conversations'), threads: path.join(home, 'Library', 'Application Support', 'Zed', 'threads') });
  } else {
    out.push({ conversations: path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, '.config'), 'zed', 'conversations'), threads: path.join(process.env.XDG_DATA_HOME ?? path.join(home, '.local', 'share'), 'zed', 'threads') });
  }
  return out;
}

/** Text thread: messages are ranges of `text` starting at `start`, in order of their offsets. */
export function zedTextThreadMessages(doc: Rec): { role: string; text: string; status?: string }[] {
  const text = typeof doc.text === 'string' ? doc.text : '';
  const msgs = (Array.isArray(doc.messages) ? doc.messages : []).map((m) => asRecord(m) ?? {}).map((m) => ({ start: Number(m.start) || 0, meta: asRecord(m.metadata) ?? {} })).sort((a, b) => a.start - b.start);
  return msgs
    .map((m, i) => ({ role: str(m.meta.role) ?? 'unknown', status: typeof m.meta.status === 'string' ? m.meta.status : str(Object.keys(asRecord(m.meta.status) ?? {})[0]), text: text.slice(m.start, i + 1 < msgs.length ? msgs[i + 1].start : text.length).trim() }))
    .filter((m) => m.text);
}

/** Decodes a threads.db row's data column. */
export function decodeZedThread(dataType: string, data: Uint8Array | string): Rec | null {
  try {
    let json: string;
    if (dataType === 'zstd') {
      const z = (zlib as unknown as { zstdDecompressSync?: (b: Buffer) => Buffer }).zstdDecompressSync;
      if (!z) return null;
      json = z(Buffer.from(data as Uint8Array)).toString('utf8');
    } else json = typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
    return asRecord(JSON.parse(json)) ?? null;
  } catch {
    return null;
  }
}

/** One agent-thread message in either known layout ({role, segments, tool_uses} or {User:{…}} / {Agent:{…}}). */
function threadMessage(raw: unknown): { role: string; texts: string[]; thinking: string[]; tools: { id?: string; name: string; input: unknown }[]; results: { id?: string; text: string; isError: boolean }[] } {
  const m = asRecord(raw) ?? {};
  const out = { role: 'unknown', texts: [] as string[], thinking: [] as string[], tools: [] as { id?: string; name: string; input: unknown }[], results: [] as { id?: string; text: string; isError: boolean }[] };
  const tagged = asRecord(m.User) ?? asRecord(m.Agent);
  if (tagged) {
    out.role = m.User ? 'user' : 'assistant';
    for (const c of Array.isArray(tagged.content) ? tagged.content : []) {
      const b = asRecord(c) ?? {};
      if (typeof b.Text === 'string') out.texts.push(b.Text);
      else if (asRecord(b.Thinking)) out.thinking.push(str(asRecord(b.Thinking)!.text) ?? '');
      else if (typeof b.Thinking === 'string') out.thinking.push(b.Thinking);
      else if (asRecord(b.ToolUse)) out.tools.push({ id: str(asRecord(b.ToolUse)!.id), name: str(asRecord(b.ToolUse)!.name) ?? 'tool', input: asRecord(b.ToolUse)!.input });
      else if (asRecord(b.Mention)) out.texts.push(`[${str(asRecord(asRecord(b.Mention)!.uri)?.File ? 'file' : 'mention')}] ${compactJson(asRecord(b.Mention)!.uri, 300)}`);
    }
    const results = asRecord(tagged.tool_results) ?? {};
    for (const [id, r] of Object.entries(results)) out.results.push({ id, text: compactJson(asRecord(r)?.content ?? r, 4000), isError: asRecord(r)?.is_error === true });
    return out;
  }
  out.role = str(m.role) ?? 'unknown';
  for (const sgm of Array.isArray(m.segments) ? m.segments : []) {
    const g = asRecord(sgm) ?? {};
    if (g.type === 'text' && typeof g.text === 'string') out.texts.push(g.text);
    else if (g.type === 'thinking' && typeof g.text === 'string') out.thinking.push(g.text);
  }
  if (typeof m.text === 'string' && !out.texts.length) out.texts.push(m.text);
  for (const t of Array.isArray(m.tool_uses) ? m.tool_uses : []) out.tools.push({ id: str(asRecord(t)?.id), name: str(asRecord(t)?.name) ?? 'tool', input: asRecord(t)?.input });
  for (const r of Array.isArray(m.tool_results) ? m.tool_results : []) out.results.push({ id: str(asRecord(r)?.tool_use_id), text: compactJson(asRecord(r)?.content, 4000), isError: asRecord(r)?.is_error === true });
  return out;
}

export const zedAdapter: AgentAdapter = {
  id: 'zed',
  label: 'Zed',
  capabilities: {
    toolCalls: true,
    toolResults: true,
    thinking: true,
    subagents: false,
    fileSnapshots: false,
    todos: false,
    gitMetadata: false,
    maturity: 'experimental',
    notes: 'Reads Zed text threads (conversations/*.zed.json) and agent threads (threads/threads.db, JSON or zstd). Zed changes these formats between releases; unknown shapes are recorded, not guessed.',
  },

  defaultRoots() {
    return zedDirs().flatMap((d) => [d.conversations, d.threads]);
  },

  async scan(root: string): Promise<AgentInventory> {
    const inv: AgentInventory = { agent: 'zed', label: 'Zed', root, exists: fs.existsSync(root), sessions: [], projectDirs: [], assets: [], notes: [], unrecoverable: [], errors: [] };
    if (!inv.exists) return inv;
    const db = path.join(root, 'threads.db');
    if (fs.existsSync(db)) {
      let w: ReturnType<typeof openWorkingCopy> | undefined;
      try {
        w = openWorkingCopy(db);
        if (!hasTable(w.db, 'threads')) inv.notes.push('threads.db has no "threads" table; skipped.');
        else {
          for (const r of w.db.prepare('SELECT id, summary, updated_at, length(data) AS size FROM threads').all() as { id: string; summary: string; updated_at: string; size: number }[]) {
            inv.sessions.push({ agent: 'zed', externalId: String(r.id), sourcePath: db, sourceKey: `zed:${pathKey(db)}#${r.id}`, size: Number(r.size) || 0, mtime: toDate(r.updated_at) ?? new Date(0), relPath: 'threads.db', extra: { kind: 'agent-thread', summary: r.summary } });
          }
        }
      } catch (e) {
        inv.errors.push(`threads.db: ${(e as Error).message}`);
      } finally {
        w?.dispose();
      }
      inv.assets.push({ kind: 'transcripts', label: 'Agent threads (threads.db)', count: inv.sessions.length, bytes: fs.statSync(db).size, archived: true });
      if (!(zlib as unknown as { zstdDecompressSync?: unknown }).zstdDecompressSync) inv.notes.push('This Node.js version cannot decompress zstd; compressed Zed threads are skipped (Node 22.15+ can).');
    }
    for (const n of fs.readdirSync(root)) {
      if (!/\.zed\.json$/i.test(n)) continue;
      const file = path.join(root, n);
      const st = fs.statSync(file);
      inv.sessions.push({ agent: 'zed', externalId: n.replace(/\.zed\.json$/i, ''), sourcePath: file, sourceKey: `zed:${pathKey(file)}`, size: st.size, mtime: st.mtime, relPath: n, extra: { kind: 'text-thread' } });
    }
    return inv;
  },

  async parse(d: DiscoveredSession, sink: SessionSink, ctx: ParseContext) {
    const acc = new SessionAccumulator(sink, { agent: 'zed', externalId: d.externalId, isSubagent: false });
    const s = acc.session;
    if (d.extra?.kind === 'text-thread') {
      const doc = asRecord(JSON.parse(fs.readFileSync(ctx.archivePath, 'utf8'))) ?? {};
      s.title = str(doc.summary) ?? d.externalId.replace(/ - \d+$/, '');
      acc.noteTime(d.mtime);
      for (const m of zedTextThreadMessages(doc)) {
        if (m.role === 'user') {
          const seq = await acc.event({ kind: 'user_message', role: 'user', text: m.text });
          acc.humanPrompt(seq, m.text);
        } else if (m.role === 'assistant') {
          const seq = await acc.event({ kind: 'assistant_message', role: 'assistant', text: m.text, isError: m.status === 'Error' });
          if (m.status === 'Error') acc.apiError(clip(m.text, 300));
          else acc.assistantText(seq, m.text, 'final');
        } else await acc.event({ kind: 'system', role: m.role, text: m.text, isMeta: true });
      }
      return acc.finish();
    }

    const db = cachedWorkingCopy(ctx.archivePath);
    const row = db.prepare('SELECT summary, updated_at, data_type, data FROM threads WHERE id = ?').get(d.externalId) as { summary: string; updated_at: string; data_type: string; data: Uint8Array } | undefined;
    if (!row) return acc.finish();
    s.title = row.summary || undefined;
    acc.noteTime(toDate(row.updated_at));
    const thread = decodeZedThread(row.data_type, row.data);
    if (!thread) {
      await acc.event({ kind: 'unknown', subtype: `zed:${row.data_type}`, text: row.data_type === 'zstd' ? 'Compressed thread; this Node.js version cannot decompress zstd.' : 'Unreadable thread data.' });
      return acc.finish();
    }
    ctx.writeRaw?.(thread);
    const model = asRecord(thread.model);
    if (model) acc.noteModel(str(model.model));
    const cwd = str(asRecord((asRecord(thread.initial_project_snapshot)?.worktree_snapshots as unknown[] | undefined)?.[0])?.worktree_path);
    if (cwd) acc.noteCwd(cwd);
    for (const raw of Array.isArray(thread.messages) ? thread.messages : []) {
      const m = threadMessage(raw);
      if (m.role === 'user') {
        const text = m.texts.join('\n');
        const seq = await acc.event({ kind: 'user_message', role: 'user', text });
        if (text.trim()) acc.humanPrompt(seq, text);
        continue;
      }
      if (m.role !== 'assistant') {
        await acc.event({ kind: 'unknown', subtype: 'zed:message', text: compactJson(raw, 2000) });
        continue;
      }
      for (const th of m.thinking) {
        await acc.event({ kind: 'thinking', role: 'assistant', text: th });
        acc.assistantPartial();
      }
      for (const t of m.tools) {
        const input = asRecord(t.input) ?? {};
        const filePath = str(input.path) ?? str(input.file_path);
        const command = str(input.command);
        const op = /edit|write|create/i.test(t.name) ? (/create|write/i.test(t.name) ? 'write' : 'edit') : /read/i.test(t.name) ? 'read' : undefined;
        const seq = await acc.event({ kind: 'tool_call', role: 'assistant', toolName: t.name, toolUseId: t.id, text: command ? `$ ${command}` : compactJson(t.input, 4000), command, filePath });
        acc.toolCall(seq, t.id, t.name, { filePath: op ? filePath : undefined, op: op as 'edit' | 'write' | 'read' | undefined, command });
      }
      for (const r of m.results) {
        await acc.event({ kind: 'tool_result', role: 'tool', toolUseId: r.id, text: r.text, isError: r.isError });
        acc.toolResult(r.id, r.isError);
      }
      const text = m.texts.join('\n');
      if (text.trim()) {
        const seq = await acc.event({ kind: 'assistant_message', role: 'assistant', text });
        acc.assistantText(seq, text, m.tools.length && !m.results.length ? 'interim' : 'final');
      }
    }
    const done = await acc.finish();
    Object.assign(done.providerMeta, { threadVersion: thread.version ?? null, tokenUsage: thread.cumulative_token_usage ?? null });
    return done;
  },
};
