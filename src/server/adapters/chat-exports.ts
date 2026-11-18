import fs from 'node:fs';
import path from 'node:path';
import { AgentAdapter, AgentId, AgentInventory, DiscoveredSession, ParseContext, SessionAccumulator, SessionSink, asRecord, clip, compactJson, str, toDate } from './types';

/**
 * ChatGPT and Claude.ai data exports ("Export data" in each app's settings). Both arrive as a ZIP with a
 * conversations.json; upload it in the Import Center and pick the matching type. Every conversation
 * becomes one session keyed by its own id, so importing a newer export only adds or updates what
 * changed.
 */

type Rec = Record<string, unknown>;
const MAX_BYTES = 1024 * 1024 * 1024;
const FILE = /(^|[\\/_])conversations[^\\/]*\.json$/i;

/** Exports are parsed once per archive copy, not once per conversation. */
const cache = new Map<string, { mtimeMs: number; list: Rec[] }>();
function loadList(file: string): Rec[] {
  const st = fs.statSync(file);
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs) return hit.list;
  if (st.size > MAX_BYTES) throw new Error('Export file is larger than 1 GB.');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')) as unknown;
  const list = (Array.isArray(raw) ? raw : Array.isArray(asRecord(raw)?.conversations) ? (asRecord(raw)!.conversations as unknown[]) : []).map((x) => asRecord(x) ?? {});
  cache.set(file, { mtimeMs: st.mtimeMs, list });
  if (cache.size > 4) cache.delete(cache.keys().next().value as string);
  return list;
}

function findExports(root: string, depth = 3): string[] {
  const out: string[] = [];
  const walk = (dir: string, d: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && d > 0) walk(p, d - 1);
      else if (e.isFile() && FILE.test(p)) out.push(p);
    }
  };
  if (fs.existsSync(root) && fs.statSync(root).isFile()) return FILE.test(root) ? [root] : [];
  walk(root, depth);
  return out;
}

interface ExportFlavor {
  id: AgentId;
  label: string;
  /** Recognizes a conversation of this export and returns its id, title and times. */
  identify(c: Rec): { id: string; title?: string; created?: Date; updated?: Date } | null;
  parse(c: Rec, acc: SessionAccumulator, ctx: ParseContext): Promise<void>;
  notes: string;
}

function makeAdapter(f: ExportFlavor): AgentAdapter {
  return {
    id: f.id,
    label: f.label,
    capabilities: { toolCalls: true, toolResults: true, thinking: true, subagents: false, fileSnapshots: false, todos: false, gitMetadata: false, maturity: 'tested-with-fixtures', notes: f.notes },
    defaultRoots: () => [],
    async scan(root: string): Promise<AgentInventory> {
      const inv: AgentInventory = { agent: f.id, label: f.label, root, exists: fs.existsSync(root), sessions: [], projectDirs: [], assets: [], notes: [], unrecoverable: [], errors: [] };
      if (!inv.exists) return inv;
      const base = fs.statSync(root).isFile() ? path.dirname(root) : root;
      for (const file of findExports(root)) {
        let list: Rec[];
        try {
          list = loadList(file);
        } catch (e) {
          inv.errors.push(`${file}: ${(e as Error).message}`);
          continue;
        }
        let n = 0;
        for (const c of list) {
          const who = f.identify(c);
          if (!who) continue;
          n++;
          const updated = who.updated ?? who.created ?? fs.statSync(file).mtime;
          inv.sessions.push({ agent: f.id, externalId: who.id, sourcePath: file, sourceKey: `${f.id}:${who.id}`, size: JSON.stringify(c).length, mtime: updated, relPath: path.relative(base, file) || path.basename(file), extra: { conversationId: who.id } });
        }
        if (!n && list.length) inv.notes.push(`${path.basename(file)} has ${list.length} conversations, none in the ${f.label} format. Is it the other export type?`);
        inv.projectDirs.push({ name: file, sessions: n, subagents: 0, bytes: fs.statSync(file).size, lastWrite: fs.statSync(file).mtime });
      }
      inv.assets.push({ kind: 'transcripts', label: `${f.label} conversations`, count: inv.sessions.length, bytes: inv.projectDirs.reduce((a, d) => a + d.bytes, 0), archived: true });
      return inv;
    },
    async parse(d: DiscoveredSession, sink: SessionSink, ctx: ParseContext) {
      const acc = new SessionAccumulator(sink, { agent: f.id, externalId: d.externalId, isSubagent: false });
      const c = loadList(ctx.archivePath).find((x) => f.identify(x)?.id === d.externalId);
      if (!c) return acc.finish();
      const who = f.identify(c)!;
      acc.session.title = who.title;
      acc.noteTime(who.created);
      await f.parse(c, acc, ctx);
      const done = await acc.finish();
      if (!done.title) done.title = done.firstUserPrompt ? clip(done.firstUserPrompt.split('\n')[0], 100) : undefined;
      Object.assign(done.providerMeta, { export: f.label, conversationId: who.id });
      return done;
    },
  };
}

// ---------------- ChatGPT ----------------

/** The visible branch of a ChatGPT conversation tree: from current_node back to the root. */
export function chatgptThread(c: Rec): Rec[] {
  const mapping = asRecord(c.mapping) ?? {};
  let id = str(c.current_node) ?? Object.keys(mapping).find((k) => !(asRecord(mapping[k])?.children as unknown[] | undefined)?.length);
  const out: Rec[] = [];
  const seen = new Set<string>();
  while (id && !seen.has(id)) {
    seen.add(id);
    const node = asRecord(mapping[id]);
    const msg = asRecord(node?.message);
    if (msg) out.push(msg);
    id = str(node?.parent);
  }
  return out.reverse();
}

function chatgptText(content: Rec | undefined): string {
  if (!content) return '';
  if (typeof content.text === 'string') return content.text;
  const parts = Array.isArray(content.parts) ? content.parts : [];
  return parts
    .map((p) => (typeof p === 'string' ? p : asRecord(p)?.content_type === 'image_asset_pointer' ? '[image]' : str(asRecord(p)?.text) ?? ''))
    .filter(Boolean)
    .join('\n');
}

export const chatgptAdapter = makeAdapter({
  id: 'chatgpt',
  label: 'ChatGPT',
  notes: 'Imports a ChatGPT data export (Settings → Data controls → Export data): upload the ZIP or conversations.json in the Import Center. The visible branch of each conversation is imported, with code interpreter and browsing steps as tool calls.',
  identify(c) {
    if (!asRecord(c.mapping)) return null;
    const id = str(c.conversation_id) ?? str(c.id);
    if (!id) return null;
    return { id, title: str(c.title), created: toDate(c.create_time), updated: toDate(c.update_time) };
  },
  async parse(c, acc, ctx) {
    for (const m of chatgptThread(c)) {
      const author = asRecord(m.author) ?? {};
      const role = str(author.role) ?? 'unknown';
      const content = asRecord(m.content);
      const type = str(content?.content_type) ?? 'text';
      const meta = asRecord(m.metadata) ?? {};
      const text = chatgptText(content);
      const timestamp = toDate(m.create_time);
      const model = str(meta.model_slug);
      const r = ctx.writeRaw?.(m);
      const raw = r ? { rawOffset: r.offset, rawLength: r.length } : {};
      if (meta.is_visually_hidden_from_conversation === true || (role === 'system' && !text.trim())) continue;
      if (role === 'user') {
        const seq = await acc.event({ ...raw, kind: 'user_message', role, text, timestamp, uuid: str(m.id) });
        if (text.trim()) acc.humanPrompt(seq, text, timestamp, str(m.id));
      } else if (role === 'assistant') {
        acc.noteModel(model);
        const recipient = str(m.recipient) ?? 'all';
        if (type === 'thoughts' || type === 'reasoning_recap') {
          await acc.event({ ...raw, kind: 'thinking', role, text: text || compactJson(content?.thoughts, 4000), timestamp, model });
          acc.assistantPartial();
        } else if (recipient !== 'all') {
          const id = str(m.id);
          const seq = await acc.event({ ...raw, kind: 'tool_call', role, toolName: recipient, toolUseId: id, text, timestamp, model, command: recipient === 'python' ? text : undefined });
          acc.toolCall(seq, id, recipient);
          acc.toolResult(id, false);
        } else if (text.trim()) {
          const seq = await acc.event({ ...raw, kind: 'assistant_message', role, text, timestamp, model, uuid: str(m.id) });
          acc.assistantText(seq, text, m.end_turn === false ? 'interim' : 'final');
        }
      } else if (role === 'tool') {
        await acc.event({ ...raw, kind: 'tool_result', role, toolName: str(author.name), text, timestamp, isError: /error/i.test(str(asRecord(meta.aggregate_result)?.status) ?? '') });
      } else {
        await acc.event({ ...raw, kind: 'system', role, text, timestamp, isMeta: true });
      }
    }
  },
});

// ---------------- Claude.ai ----------------

export const claudeAiAdapter = makeAdapter({
  id: 'claude-ai',
  label: 'Claude.ai',
  notes: 'Imports a Claude.ai data export (Settings → Privacy → Export data): upload the ZIP or conversations.json in the Import Center. Messages, thinking, tool use and attachments\' extracted text are imported.',
  identify(c) {
    if (!Array.isArray(c.chat_messages)) return null;
    const id = str(c.uuid) ?? str(c.id);
    if (!id) return null;
    return { id, title: str(c.name), created: toDate(c.created_at), updated: toDate(c.updated_at) };
  },
  async parse(c, acc, ctx) {
    for (const raw0 of c.chat_messages as unknown[]) {
      const m = asRecord(raw0) ?? {};
      const sender = str(m.sender);
      const timestamp = toDate(m.created_at);
      const r = ctx.writeRaw?.(m);
      const raw = r ? { rawOffset: r.offset, rawLength: r.length } : {};
      const blocks = Array.isArray(m.content) ? m.content.map((b) => asRecord(b) ?? {}) : [];
      const attachments = (Array.isArray(m.attachments) ? m.attachments : []).map((a) => asRecord(a) ?? {});
      if (sender === 'human') {
        const text = [str(m.text) ?? blocks.filter((b) => b.type === 'text').map((b) => str(b.text) ?? '').join('\n'), ...attachments.map((a) => `[attachment: ${str(a.file_name) ?? 'file'}]${a.extracted_content ? `\n${clip(String(a.extracted_content), 4000)}` : ''}`)].filter(Boolean).join('\n\n');
        const seq = await acc.event({ ...raw, kind: 'user_message', role: 'user', text, timestamp, uuid: str(m.uuid) });
        if (text.trim()) acc.humanPrompt(seq, text, timestamp, str(m.uuid));
        continue;
      }
      if (sender !== 'assistant') {
        await acc.event({ ...raw, kind: 'system', role: sender, text: str(m.text), timestamp, isMeta: true });
        continue;
      }
      if (!blocks.length && str(m.text)) {
        const seq = await acc.event({ ...raw, kind: 'assistant_message', role: 'assistant', text: str(m.text), timestamp, uuid: str(m.uuid) });
        acc.assistantText(seq, str(m.text)!, 'final');
        continue;
      }
      for (const [i, b] of blocks.entries()) {
        if (b.type === 'thinking') {
          await acc.event({ ...raw, blockIndex: i, kind: 'thinking', role: 'assistant', text: str(b.thinking) ?? str(b.text), timestamp });
          acc.assistantPartial();
        } else if (b.type === 'tool_use') {
          const id = str(b.id) ?? `${str(m.uuid)}-${i}`;
          const seq = await acc.event({ ...raw, blockIndex: i, kind: 'tool_call', role: 'assistant', toolName: str(b.name), toolUseId: id, text: compactJson(b.input, 6000), timestamp });
          acc.toolCall(seq, id, str(b.name));
        } else if (b.type === 'tool_result') {
          const id = str(b.tool_use_id);
          await acc.event({ ...raw, blockIndex: i, kind: 'tool_result', role: 'tool', toolUseId: id, text: compactJson(b.content, 6000), timestamp, isError: b.is_error === true });
          acc.toolResult(id, b.is_error === true);
        } else if (str(b.text)) {
          const seq = await acc.event({ ...raw, blockIndex: i, kind: 'assistant_message', role: 'assistant', text: str(b.text), timestamp });
          acc.assistantText(seq, str(b.text)!, i === blocks.length - 1 ? 'final' : 'interim');
        }
      }
    }
  },
});
