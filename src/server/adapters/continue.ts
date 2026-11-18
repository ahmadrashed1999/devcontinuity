import fs from 'node:fs';
import path from 'node:path';
import { homeDir } from '../config';
import { pathKey } from '../security/paths';
import { fileUriToPath } from './editors';
import { extractText } from './generic';
import { AgentAdapter, AgentInventory, DiscoveredSession, FileOpKind, ParseContext, SessionAccumulator, SessionSink, asRecord, clip, compactJson, str, toDate } from './types';

type Rec = Record<string, unknown>;

const FILE_TOOLS: Record<string, FileOpKind> = { read_file: 'read', create_new_file: 'write', edit_existing_file: 'edit', single_find_and_replace: 'edit', multi_edit: 'edit' };
const MAX_BYTES = 200 * 1024 * 1024;

function parseArgs(v: unknown): Rec {
  if (typeof v !== 'string') return asRecord(v) ?? {};
  try {
    return asRecord(JSON.parse(v)) ?? {};
  } catch {
    return {};
  }
}

export const continueAdapter: AgentAdapter = {
  id: 'continue',
  label: 'Continue',
  capabilities: {
    toolCalls: true,
    toolResults: true,
    thinking: true,
    subagents: false,
    fileSnapshots: false,
    todos: false,
    gitMetadata: false,
    maturity: 'tested-with-fixtures',
    notes: 'Reads Continue (VS Code / JetBrains) chat and agent sessions from ~/.continue/sessions, with the session index for dates and workspace.',
  },

  defaultRoots() {
    const env = process.env.CONTINUE_GLOBAL_DIR?.trim();
    return [path.join(env || path.join(homeDir(), '.continue'), 'sessions')];
  },

  async scan(root: string): Promise<AgentInventory> {
    const inv: AgentInventory = { agent: 'continue', label: 'Continue', root, exists: fs.existsSync(root), sessions: [], projectDirs: [], assets: [], notes: [], unrecoverable: [], errors: [] };
    if (!inv.exists) return inv;
    const index = new Map<string, Rec>();
    try {
      const list = JSON.parse(fs.readFileSync(path.join(root, 'sessions.json'), 'utf8'));
      if (Array.isArray(list)) for (const x of list) if (asRecord(x)?.sessionId) index.set(String(asRecord(x)!.sessionId), x as Rec);
    } catch {
      /* index is optional */
    }
    for (const n of fs.readdirSync(root)) {
      if (!/\.json$/i.test(n) || n === 'sessions.json') continue;
      const file = path.join(root, n);
      const st = fs.statSync(file);
      const id = n.replace(/\.json$/i, '');
      const meta = index.get(id);
      const cwd = fileUriToPath(meta?.workspaceDirectory) ?? str(meta?.workspaceDirectory);
      inv.sessions.push({ agent: 'continue', externalId: id, sourcePath: file, sourceKey: `continue:${pathKey(file)}`, size: st.size, mtime: st.mtime, relPath: n, projectHint: cwd, extra: { cwd, dateCreated: meta?.dateCreated } });
    }
    inv.assets.push({ kind: 'transcripts', label: 'Sessions', count: inv.sessions.length, bytes: inv.sessions.reduce((a, s) => a + s.size, 0), archived: true });
    return inv;
  },

  async parse(d: DiscoveredSession, sink: SessionSink, ctx: ParseContext) {
    const acc = new SessionAccumulator(sink, { agent: 'continue', externalId: d.externalId, isSubagent: false });
    const s = acc.session;
    if (fs.statSync(ctx.archivePath).size > MAX_BYTES) throw new Error('Continue session file is too large to load.');
    let doc: Rec | undefined;
    try {
      doc = asRecord(JSON.parse(fs.readFileSync(ctx.archivePath, 'utf8').replace(/^﻿/, '')));
    } catch (e) {
      await acc.malformed(1, `Not valid JSON: ${(e as Error).message}`, undefined, { offset: 0, length: 0 });
      return acc.finish();
    }
    if (!doc) return acc.finish();
    s.title = str(doc.title);
    s.cwd = fileUriToPath(doc.workspaceDirectory) ?? str(doc.workspaceDirectory) ?? str(d.extra?.cwd);
    const created = toDate(Number(d.extra?.dateCreated));
    acc.noteTime(created);
    const history = Array.isArray(doc.history) ? doc.history : [];

    for (const itemRaw of history) {
      const item = asRecord(itemRaw) ?? {};
      const m = asRecord(item.message) ?? {};
      const r = ctx.writeRaw?.(item);
      const raw = r ? { rawOffset: r.offset, rawLength: r.length } : {};
      const role = str(m.role);
      const logs = Array.isArray(item.promptLogs) ? item.promptLogs.map((x) => asRecord(x) ?? {}) : [];
      const model = str(logs[0]?.modelTitle) ?? str(asRecord(logs[0]?.completionOptions)?.model) ?? str(doc.chatModelTitle);
      const text = extractText(m.content);
      if (role === 'user') {
        const seq = await acc.event({ ...raw, kind: 'user_message', role, text, uuid: str(m.id) });
        if (text.trim()) acc.humanPrompt(seq, text, undefined, str(m.id));
      } else if (role === 'assistant') {
        acc.noteModel(model);
        const calls = Array.isArray(m.toolCalls) ? m.toolCalls : [];
        if (text.trim()) {
          const seq = await acc.event({ ...raw, kind: 'assistant_message', role, text, model, uuid: str(m.id) });
          acc.assistantText(seq, text, calls.length ? 'interim' : 'unknown');
        }
        for (const c of calls) {
          const tc = asRecord(c) ?? {};
          const fn = asRecord(tc.function) ?? {};
          const name = str(fn.name) ?? 'tool';
          const args = parseArgs(fn.arguments);
          const id = str(tc.id);
          const command = name === 'run_terminal_command' ? str(args.command) : undefined;
          const filePath = str(args.filepath) ?? str(args.filePath) ?? str(args.path);
          const op = FILE_TOOLS[name];
          const seq = await acc.event({ ...raw, kind: 'tool_call', role, toolName: name, toolUseId: id, text: command ? `$ ${command}` : compactJson(args, 6000), command, filePath, model });
          acc.toolCall(seq, id, name, { filePath: op ? filePath : undefined, op, command });
        }
      } else if (role === 'tool') {
        const id = str(m.toolCallId);
        await acc.event({ ...raw, kind: 'tool_result', role, toolUseId: id, text });
        acc.toolResult(id, false);
      } else if (role === 'thinking') {
        await acc.event({ ...raw, kind: 'thinking', role: 'assistant', text });
        acc.assistantPartial();
      } else {
        await acc.event({ ...raw, kind: 'system', role, text, isMeta: true });
      }
    }
    const done = await acc.finish();
    Object.assign(done.providerMeta, { mode: doc.mode ?? null, chatModelTitle: doc.chatModelTitle ?? null });
    if (!done.title || done.title === 'New Session') done.title = done.firstUserPrompt ? clip(done.firstUserPrompt.split('\n')[0], 120) : done.title;
    return done;
  },
};
