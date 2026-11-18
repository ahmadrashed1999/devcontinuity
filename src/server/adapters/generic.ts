import fs from 'node:fs';
import path from 'node:path';
import { dataPath, ensureDir } from '../config';
import { readJsonl } from '../parsers/jsonl';
import { pathKey } from '../security/paths';
import { AgentAdapter, AgentInventory, DiscoveredSession, ParseContext, SessionAccumulator, SessionSink, asRecord, clip, compactJson, str, toDate } from './types';

type Rec = Record<string, unknown>;

const MAX_JSON_BYTES = 200 * 1024 * 1024;

const ROLE_MAP: Record<string, 'user' | 'assistant' | 'system' | 'tool'> = {
  user: 'user', human: 'user', customer: 'user',
  assistant: 'assistant', ai: 'assistant', model: 'assistant', bot: 'assistant', gpt: 'assistant', agent: 'assistant',
  system: 'system', developer: 'system',
  tool: 'tool', function: 'tool', tool_result: 'tool',
};

export function extractText(v: unknown, depth = 0): string {
  if (v == null || depth > 4) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map((x) => extractText(x, depth + 1)).filter(Boolean).join('\n');
  const o = asRecord(v);
  if (!o) return '';
  for (const k of ['text', 'content', 'parts', 'value', 'message', 'output']) {
    if (o[k] != null && k !== 'role') {
      const t = extractText(o[k], depth + 1);
      if (t) return t;
    }
  }
  return '';
}

/** Finds the list of conversation items inside an arbitrary JSON document. */
export function findItems(root: unknown): { items: unknown[]; meta: Rec } | null {
  if (Array.isArray(root)) return { items: root, meta: {} };
  const o = asRecord(root);
  if (!o) return null;
  for (const k of ['messages', 'conversation', 'history', 'items', 'events', 'turns', 'transcript', 'log']) {
    if (Array.isArray(o[k])) {
      const meta: Rec = {};
      for (const [mk, mv] of Object.entries(o)) if (mk !== k && (typeof mv !== 'object' || mv === null)) meta[mk] = mv;
      return { items: o[k] as unknown[], meta };
    }
  }
  return null;
}

async function mapItem(acc: SessionAccumulator, item: unknown, raw: { rawOffset?: number; rawLength?: number; lineNo?: number }) {
  const o = asRecord(item);
  if (!o) {
    await acc.event({ ...raw, kind: 'unknown', rawType: typeof item, text: compactJson(item, 500) });
    return;
  }
  const roleRaw = (str(o.role) ?? str(asRecord(o.author)?.role) ?? str(o.sender) ?? str(o.speaker) ?? str(o.from) ?? str(o.type) ?? '').toLowerCase();
  const role = ROLE_MAP[roleRaw];
  const timestamp = toDate(o.timestamp ?? o.created_at ?? o.createdAt ?? o.time ?? o.create_time ?? o.date);
  const model = str(o.model);
  const common = { ...raw, rawType: roleRaw || '<no-role>', timestamp, uuid: str(o.id) ?? str(o.uuid) };
  if (!role) {
    await acc.event({ ...common, kind: 'unknown', text: `No recognizable role. Keys: ${Object.keys(o).slice(0, 25).join(', ')}` });
    return;
  }
  const text = extractText(o.content ?? o.text ?? o.message ?? o.parts ?? o.value);
  if (role === 'user') {
    const seq = await acc.event({ ...common, kind: 'user_message', role, text });
    if (text.trim()) acc.humanPrompt(seq, text, timestamp, str(o.id));
  } else if (role === 'assistant') {
    acc.noteModel(model);
    if (text.trim() || !Array.isArray(o.tool_calls)) {
      const seq = await acc.event({ ...common, kind: 'assistant_message', role, text, model });
      if (text.trim()) acc.assistantText(seq, text, 'unknown');
    }
    if (Array.isArray(o.tool_calls)) {
      for (const tc of o.tool_calls) {
        const t = asRecord(tc) ?? {};
        const fn = asRecord(t.function) ?? t;
        const name = str(fn.name) ?? 'tool';
        const id = str(t.id);
        const args = typeof fn.arguments === 'string' ? fn.arguments : compactJson(fn.arguments ?? fn.input ?? {}, 6000);
        const seq = await acc.event({ ...common, kind: 'tool_call', role, toolName: name, toolUseId: id, text: args, model });
        acc.toolCall(seq, id, name, { timestamp });
      }
    }
  } else if (role === 'tool') {
    const id = str(o.tool_call_id) ?? str(o.tool_use_id);
    const isError = o.is_error === true || o.error != null;
    await acc.event({ ...common, kind: 'tool_result', role, toolUseId: id, toolName: str(o.name), text, isError });
    acc.toolResult(id, isError);
  } else {
    await acc.event({ ...common, kind: 'system', role, text, isMeta: true });
  }
}

/** Imports arbitrary chat exports: a JSONL file of messages, a JSON array, or a JSON object wrapping a message list. */
export const genericAdapter: AgentAdapter = {
  id: 'generic',
  label: 'Generic JSON / JSONL',
  capabilities: {
    toolCalls: true,
    toolResults: true,
    thinking: false,
    subagents: false,
    fileSnapshots: false,
    todos: false,
    gitMetadata: false,
    maturity: 'tested-with-fixtures',
    notes: 'Maps common role/content shapes (including OpenAI-style tool_calls). Anything it cannot classify is kept as an unknown event with its raw record.',
  },

  defaultRoots() {
    return [ensureDir(dataPath('uploads'))];
  },

  async scan(root: string): Promise<AgentInventory> {
    const inv: AgentInventory = { agent: 'generic', label: 'Generic JSON / JSONL', root, exists: fs.existsSync(root), sessions: [], projectDirs: [], assets: [], notes: [], unrecoverable: [], errors: [] };
    if (!inv.exists) return inv;
    const st = fs.statSync(root);
    const files = st.isFile() ? [root] : fs.readdirSync(root).map((n) => path.join(root, n));
    for (const f of files) {
      if (!/\.(json|jsonl|ndjson)$/i.test(f)) continue;
      const fst = fs.statSync(f);
      if (!fst.isFile()) continue;
      inv.sessions.push({ agent: 'generic', externalId: path.basename(f).replace(/\.(json|jsonl|ndjson)$/i, ''), sourcePath: f, sourceKey: `generic:${pathKey(f)}`, size: fst.size, mtime: fst.mtime, relPath: path.basename(f) });
    }
    inv.assets.push({ kind: 'transcripts', label: 'Imported JSON / JSONL files', count: inv.sessions.length, bytes: inv.sessions.reduce((a, s) => a + s.size, 0), archived: true });
    return inv;
  },

  async parse(d: DiscoveredSession, sink: SessionSink, ctx: ParseContext) {
    const acc = new SessionAccumulator(sink, { agent: 'generic', externalId: d.externalId, isSubagent: false });
    const isJsonDoc = /\.json$/i.test(ctx.archivePath);
    if (isJsonDoc) {
      const size = fs.statSync(ctx.archivePath).size;
      if (size > MAX_JSON_BYTES) throw new Error(`JSON document is too large to load (${size} bytes). Convert it to JSONL to import it.`);
      let root: unknown;
      try {
        root = JSON.parse(fs.readFileSync(ctx.archivePath, 'utf8').replace(/^\uFEFF/, ''));
      } catch (e) {
        await acc.malformed(1, `The file is not valid JSON: ${(e as Error).message}`, undefined, { offset: 0, length: 0 });
        return acc.finish();
      }
      const found = findItems(root);
      if (!found) {
        const r = ctx.writeRaw?.(root);
        await acc.event({ kind: 'unknown', rawType: 'document', text: 'No message list was found in this JSON document. The original is preserved in the archive.', rawOffset: r?.offset, rawLength: r?.length });
        return acc.finish();
      }
      acc.session.title = str(found.meta.title) ?? str(found.meta.name);
      acc.session.cwd = str(found.meta.cwd) ?? str(found.meta.project_path) ?? str(found.meta.workspace);
      acc.session.providerMeta.documentMeta = found.meta;
      for (const item of found.items) {
        const r = ctx.writeRaw?.(item);
        await mapItem(acc, item, { rawOffset: r?.offset, rawLength: r?.length });
      }
    } else {
      for await (const line of readJsonl(ctx.archivePath)) {
        if (line.error) {
          await acc.malformed(line.lineNo, line.error, line.preview, { offset: line.offset, length: line.length });
          continue;
        }
        await mapItem(acc, line.value, { rawOffset: line.offset, rawLength: line.length, lineNo: line.lineNo });
      }
    }
    const done = await acc.finish();
    if (!done.title && done.firstUserPrompt) done.title = clip(done.firstUserPrompt.split('\n')[0], 90);
    return done;
  },
};
