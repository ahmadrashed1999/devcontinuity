import fs from 'node:fs';
import path from 'node:path';
import { homeDir } from '../config';
import { readJsonl } from '../parsers/jsonl';
import { pathKey } from '../security/paths';
import { AgentAdapter, AgentInventory, DiscoveredSession, FileOpKind, ParseContext, SessionAccumulator, SessionSink, asRecord, clip, compactJson, str, toDate } from './types';

type Rec = Record<string, unknown>;

function listRollouts(dir: string, base: string, out: { full: string; rel: string; size: number; mtime: Date }[], errors: string[], depth = 0) {
  if (depth > 8) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    errors.push(`Cannot read ${dir}: ${(e as Error).message}`);
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) listRollouts(full, base, out, errors, depth + 1);
    else if (e.isFile() && /\.jsonl(\.zst|\.gz)?$/i.test(e.name)) {
      const st = fs.statSync(full);
      out.push({ full, rel: path.relative(base, full), size: st.size, mtime: st.mtime });
    }
  }
}

function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((c) => {
      const o = asRecord(c);
      if (!o) return typeof c === 'string' ? c : '';
      if (typeof o.text === 'string') return o.text;
      if (o.type === 'input_image' || o.type === 'image') return '[image]';
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function parseArgs(v: unknown): Rec | undefined {
  if (typeof v === 'string') {
    try {
      return asRecord(JSON.parse(v));
    } catch {
      return undefined;
    }
  }
  return asRecord(v);
}

function commandOf(args: Rec | undefined): string | undefined {
  if (!args) return undefined;
  const c = args.command ?? args.cmd ?? asRecord(args.action)?.command;
  if (Array.isArray(c)) return c.map(String).join(' ');
  return str(c);
}

const PATCH_FILE = /^\*\*\* (Add|Update|Delete) File: (.+)$/gm;

function patchFiles(patch: string): { path: string; op: FileOpKind }[] {
  const out: { path: string; op: FileOpKind }[] = [];
  PATCH_FILE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PATCH_FILE.exec(patch))) out.push({ path: m[2].trim(), op: m[1] === 'Add' ? 'write' : m[1] === 'Delete' ? 'delete' : 'edit' });
  return out;
}

function outputInfo(output: unknown): { text: string; isError: boolean } {
  let text = typeof output === 'string' ? output : compactJson(output, 20_000);
  let isError = false;
  const o = typeof output === 'string' ? parseArgs(output) : asRecord(output);
  if (o) {
    if (typeof o.output === 'string') text = o.output;
    else if (typeof o.content === 'string') text = o.content;
    const exit = asRecord(o.metadata)?.exit_code;
    if (typeof exit === 'number' && exit !== 0) isError = true;
    if (o.success === false) isError = true;
  }
  return { text, isError };
}

export const codexAdapter: AgentAdapter = {
  id: 'codex',
  label: 'OpenAI Codex CLI',
  capabilities: {
    toolCalls: true,
    toolResults: true,
    thinking: false,
    subagents: false,
    fileSnapshots: false,
    todos: false,
    gitMetadata: false,
    maturity: 'verified',
    notes: 'Parses rollout-*.jsonl session files, including zstd-compressed ones. Reasoning is stored encrypted by Codex, so only reasoning summaries are readable. Codex SQLite stores are inventoried but not parsed.',
  },

  defaultRoots() {
    const roots = [process.env.CODEX_HOME?.trim(), path.join(homeDir(), '.codex')].filter((r): r is string => !!r);
    return [...new Set(roots.map((r) => path.resolve(r)))];
  },

  async scan(root: string): Promise<AgentInventory> {
    const inv: AgentInventory = { agent: 'codex', label: 'OpenAI Codex CLI', root, exists: fs.existsSync(root), sessions: [], projectDirs: [], assets: [], notes: [], unrecoverable: [], errors: [] };
    if (!inv.exists) return inv;
    const files: { full: string; rel: string; size: number; mtime: Date }[] = [];
    for (const sub of ['sessions', 'archived_sessions']) {
      const dir = path.join(root, sub);
      if (fs.existsSync(dir)) listRollouts(dir, root, files, inv.errors);
    }
    for (const f of files) {
      const base = path.basename(f.full).replace(/\.jsonl(\.zst|\.gz)?$/i, '');
      const uuid = base.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)?.[0];
      inv.sessions.push({ agent: 'codex', externalId: uuid ?? base, sourcePath: f.full, sourceKey: `codex:${pathKey(f.full)}`, size: f.size, mtime: f.mtime, relPath: f.rel });
    }
    const compressed = files.filter((f) => /\.zst$/i.test(f.full)).length;
    inv.assets.push({ kind: 'transcripts', label: 'Rollout session files', count: files.length, bytes: files.reduce((a, f) => a + f.size, 0), relDir: 'sessions', archived: true, note: compressed ? `${compressed} are zstd-compressed and are decompressed on the fly.` : undefined });
    const sqlite = fs.readdirSync(root).filter((n) => /\.sqlite$/i.test(n));
    if (sqlite.length) {
      inv.assets.push({ kind: 'sqlite', label: 'Codex SQLite stores', count: sqlite.length, bytes: sqlite.reduce((a, n) => a + fs.statSync(path.join(root, n)).size, 0), archived: false, note: 'Not imported: internal, undocumented schema. Session content is taken from the rollout files instead.' });
    }
    inv.assets.push({ kind: 'credentials', label: 'Credential files', count: 0, bytes: 0, archived: false, note: 'Never read or copied (auth.json, sandbox secrets).' });
    inv.unrecoverable.push('Codex stores model reasoning encrypted; only the short reasoning summaries (when present) can be shown.');
    return inv;
  },

  async parse(d: DiscoveredSession, sink: SessionSink, ctx: ParseContext) {
    const acc = new SessionAccumulator(sink, { agent: 'codex', externalId: d.externalId, isSubagent: false });
    const s = acc.session;
    const typeCounts: Record<string, number> = {};
    let model: string | undefined;
    let encryptedReasoning = 0;

    for await (const line of readJsonl(ctx.archivePath)) {
      const raw = { rawOffset: line.offset, rawLength: line.length, lineNo: line.lineNo };
      if (line.error) {
        await acc.malformed(line.lineNo, line.error, line.preview, { offset: line.offset, length: line.length });
        continue;
      }
      const rec = asRecord(line.value);
      if (!rec) {
        await acc.event({ ...raw, kind: 'unknown', rawType: '<non-object>' });
        continue;
      }
      const type = str(rec.type) ?? '<no-type>';
      const p = asRecord(rec.payload) ?? {};
      const ptype = str(p.type);
      const key = ptype ? `${type}:${ptype}` : type;
      typeCounts[key] = (typeCounts[key] ?? 0) + 1;
      const timestamp = toDate(rec.timestamp);
      const common = { ...raw, rawType: type, subtype: ptype, timestamp };

      if (type === 'session_meta') {
        s.cwd = str(p.cwd) ?? s.cwd;
        s.agentVersion = str(p.cli_version) ?? s.agentVersion;
        const git = asRecord(p.git);
        if (git) s.gitBranch = str(git.branch) ?? s.gitBranch;
        Object.assign(s.providerMeta, { originator: p.originator ?? null, source: p.source ?? null, modelProvider: p.model_provider ?? null, git: git ?? null });
        await acc.event({ ...common, kind: 'meta', timestamp: toDate(p.timestamp) ?? timestamp });
      } else if (type === 'turn_context') {
        model = str(p.model) ?? model;
        acc.noteCwd(str(p.cwd));
        await acc.event({ ...common, kind: 'meta', model });
      } else if (type === 'response_item') {
        if (ptype === 'message') {
          const role = str(p.role) ?? 'assistant';
          const text = messageText(p.content);
          if (role === 'user') {
            const human = !!text.trim() && !text.trimStart().startsWith('<');
            const seq = await acc.event({ ...common, kind: 'user_message', role: 'user', text, isMeta: !human, subtype: human ? undefined : 'injected' });
            if (human) acc.humanPrompt(seq, text, timestamp);
            else acc.injectedUser();
          } else if (role === 'assistant') {
            acc.noteModel(model);
            const seq = await acc.event({ ...common, kind: 'assistant_message', role: 'assistant', text, model });
            if (text.trim()) acc.assistantText(seq, text, 'unknown');
          } else {
            await acc.event({ ...common, kind: 'system', role, text, isMeta: true });
          }
        } else if (ptype === 'reasoning') {
          const summary = Array.isArray(p.summary) ? p.summary.map((x) => str(asRecord(x)?.text) ?? '').filter(Boolean).join('\n') : '';
          if (!summary && p.encrypted_content) encryptedReasoning++;
          await acc.event({ ...common, kind: 'thinking', role: 'assistant', text: summary || undefined, subtype: summary ? 'reasoning_summary' : 'encrypted', model });
          acc.assistantPartial();
        } else if (ptype === 'function_call' || ptype === 'custom_tool_call' || ptype === 'local_shell_call') {
          const name = str(p.name) ?? (ptype === 'local_shell_call' ? 'local_shell' : 'tool');
          const id = str(p.call_id) ?? str(p.id);
          const args = parseArgs(p.arguments ?? p.input ?? p.action);
          const rawInput = typeof p.input === 'string' ? p.input : typeof p.arguments === 'string' ? p.arguments : compactJson(p.action ?? {}, 6000);
          const command = commandOf(args) ?? (ptype === 'local_shell_call' ? commandOf({ action: p.action }) : undefined);
          const files = name === 'apply_patch' || /\*\*\* Begin Patch/.test(rawInput) ? patchFiles(rawInput) : [];
          const seq = await acc.event({ ...common, kind: 'tool_call', role: 'assistant', toolName: name, toolUseId: id, text: command ? `$ ${command}` : rawInput, command, filePath: files[0]?.path, model });
          acc.toolCall(seq, id, name, { filePath: files[0]?.path, op: files[0]?.op, command, timestamp });
          for (const f of files.slice(1)) acc.extraFileOp({ eventSeq: seq, path: f.path, op: f.op, toolName: name, toolUseId: id, timestamp });
        } else if (ptype === 'function_call_output' || ptype === 'custom_tool_call_output' || ptype === 'local_shell_call_output') {
          const id = str(p.call_id);
          const { text, isError } = outputInfo(p.output);
          await acc.event({ ...common, kind: 'tool_result', role: 'tool', toolUseId: id, text, isError });
          acc.toolResult(id, isError);
        } else if (ptype === 'web_search_call' || ptype === 'tool_search_call') {
          const name = ptype.replace(/_call$/, '');
          // web_search_call has no separate output record, so it is not tracked as a pending call.
          const id = ptype === 'tool_search_call' ? str(p.call_id) ?? str(p.id) : undefined;
          const seq = await acc.event({ ...common, kind: 'tool_call', role: 'assistant', toolName: name, toolUseId: id, text: compactJson(p.action ?? p.arguments ?? p.query ?? {}, 2000), model });
          acc.toolCall(seq, id, name, { timestamp });
          if (!id) acc.toolResult(undefined, false);
        } else if (ptype === 'tool_search_output') {
          const id = str(p.call_id);
          await acc.event({ ...common, kind: 'tool_result', role: 'tool', toolUseId: id, text: compactJson(p.output ?? p.tools ?? {}, 4000) });
          acc.toolResult(id, false);
        } else if (ptype === 'agent_message') {
          await acc.event({ ...common, kind: 'system', role: 'agent', text: messageText(p.content) || str(p.message) || str(p.text), isMeta: true });
        } else if (ptype === 'additional_tools') {
          await acc.event({ ...common, kind: 'meta' });
        } else {
          await acc.event({ ...common, kind: 'unknown', text: `Unrecognized Codex response item "${ptype}"` });
        }
      } else if (type === 'event_msg') {
        if (ptype === 'error' || ptype === 'stream_error') {
          const text = str(p.message) ?? compactJson(p, 800);
          await acc.event({ ...common, kind: 'error', text, isError: true });
          acc.apiError(text);
        } else if (ptype === 'task_complete' || ptype === 'task_started' || ptype === 'turn_aborted') {
          await acc.event({ ...common, kind: 'system', text: ptype === 'task_complete' ? clip(str(p.last_agent_message) ?? '', 500) || undefined : undefined });
          if (ptype === 'turn_aborted') acc.assistantPartial();
        } else {
          await acc.event({ ...common, kind: 'meta' });
        }
      } else if (type === 'token_usage_record' || type === 'world_state' || type === 'compacted' || type === 'inter_agent_communication_metadata') {
        await acc.event({ ...common, kind: 'meta' });
      } else {
        await acc.event({ ...common, kind: 'unknown', text: `Unrecognized Codex record type "${type}"` });
      }
    }

    const done = await acc.finish();
    done.title = done.firstUserPrompt ? clip(done.firstUserPrompt.split('\n')[0], 90) : undefined;
    Object.assign(done.providerMeta, { recordTypeCounts: typeCounts, encryptedReasoningItems: encryptedReasoning, compressed: /\.zst$/i.test(ctx.archivePath) });
    return done;
  },
};
