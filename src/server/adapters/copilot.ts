import fs from 'node:fs';
import path from 'node:path';
import { pathKey } from '../security/paths';
import { editorForPath, editorUserDirs, fileUriToPath } from './editors';
import { AgentAdapter, AgentInventory, DiscoveredSession, ParseContext, SessionAccumulator, SessionSink, asRecord, clip, compactJson, str, toDate } from './types';

type Rec = Record<string, unknown>;

const MAX_BYTES = 300 * 1024 * 1024;

/**
 * VS Code stores chat sessions either as one JSON document (older versions) or as an append-only
 * mutation log: line 1 is a snapshot (kind 0), later lines set a value (kind 1), append to an
 * array, optionally truncating it first (kind 2), or delete a key (kind 3). Replaying it gives the
 * same document as the older format.
 */
export function replayChatSession(text: string): { state: Rec | undefined; errors: string[] } {
  const errors: string[] = [];
  let state: Rec | undefined;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let rec: Rec;
    try {
      rec = JSON.parse(line) as Rec;
    } catch (e) {
      errors.push(`line ${i + 1}: ${(e as Error).message}`);
      continue;
    }
    if (rec.kind === 0) {
      state = asRecord(rec.v) ?? {};
      continue;
    }
    if (!state || !Array.isArray(rec.k) || rec.k.length === 0) continue;
    try {
      let parent: Rec | unknown[] = state;
      for (const key of rec.k.slice(0, -1)) parent = (parent as Rec)[key as string] as Rec;
      const last = rec.k[rec.k.length - 1] as string;
      const target = parent as Rec;
      if (rec.kind === 1) target[last] = rec.v;
      else if (rec.kind === 2) {
        const arr = (Array.isArray(target[last]) ? target[last] : (target[last] = [])) as unknown[];
        if (typeof rec.i === 'number') arr.length = Math.min(arr.length, rec.i);
        if (Array.isArray(rec.v)) arr.push(...rec.v);
      } else if (rec.kind === 3) delete target[last];
    } catch (e) {
      errors.push(`line ${i + 1}: cannot apply ${String(rec.kind)} at ${JSON.stringify(rec.k)}: ${(e as Error).message}`);
    }
  }
  return { state, errors };
}

function mdValue(v: unknown): string {
  if (typeof v === 'string') return v;
  return str(asRecord(v)?.value) ?? '';
}

function firstUriPath(v: unknown): string | undefined {
  const uris = asRecord(asRecord(v)?.uris);
  if (!uris) return undefined;
  for (const k of Object.keys(uris)) {
    const p = fileUriToPath(k);
    if (p) return p;
  }
  return undefined;
}

function uriPath(u: unknown): string | undefined {
  const o = asRecord(u);
  return str(o?.fsPath) ?? fileUriToPath(o?.external) ?? (typeof u === 'string' ? fileUriToPath(u) : undefined);
}

function workspaceFolder(dir: string): string | undefined {
  try {
    const w = JSON.parse(fs.readFileSync(path.join(dir, 'workspace.json'), 'utf8')) as Rec;
    return fileUriToPath(w.folder) ?? fileUriToPath(w.workspace);
  } catch {
    return undefined;
  }
}

export const copilotAdapter: AgentAdapter = {
  id: 'copilot',
  label: 'GitHub Copilot Chat',
  capabilities: {
    toolCalls: true,
    toolResults: true,
    thinking: true,
    subagents: false,
    fileSnapshots: false,
    todos: false,
    gitMetadata: false,
    maturity: 'verified',
    notes: 'Reads VS Code chat sessions (Copilot Chat, Ask/Edit/Agent modes) from every VS Code-family editor, including the newer mutation-log format. Tool results are recorded as summaries; full tool output is not stored by VS Code.',
  },

  defaultRoots() {
    const out: string[] = [];
    for (const e of editorUserDirs()) {
      for (const sub of ['workspaceStorage', path.join('globalStorage', 'emptyWindowChatSessions')]) {
        const dir = path.join(e.dir, sub);
        if (fs.existsSync(dir)) out.push(dir);
      }
    }
    return out;
  },

  async scan(root: string): Promise<AgentInventory> {
    const editor = editorForPath(root) ?? 'vscode';
    const inv: AgentInventory = { agent: 'copilot', label: `Copilot Chat (${editor})`, root, exists: fs.existsSync(root), sessions: [], projectDirs: [], assets: [], notes: [], unrecoverable: [], errors: [] };
    if (!inv.exists) return inv;
    let emptyChats = 0;
    const add = (file: string, rel: string, cwd?: string) => {
      const st = fs.statSync(file);
      if (st.size === 0) return;
      // VS Code writes a session file whenever the chat panel opens; files without a single request are noise.
      if (st.size < MAX_BYTES && !fs.readFileSync(file, 'utf8').includes('"requestId"')) {
        emptyChats++;
        return;
      }
      inv.sessions.push({ agent: 'copilot', reportedAgent: 'copilot', externalId: path.basename(file).replace(/\.jsonl?$/i, ''), sourcePath: file, sourceKey: `copilot:${pathKey(file)}`, size: st.size, mtime: st.mtime, relPath: rel, projectHint: cwd, extra: { cwd, editor } });
    };
    const isChat = (n: string) => /\.jsonl?$/i.test(n);
    if (path.basename(root) === 'emptyWindowChatSessions') {
      for (const n of fs.readdirSync(root).filter(isChat)) add(path.join(root, n), n);
    } else {
      for (const hash of fs.readdirSync(root)) {
        const chats = path.join(root, hash, 'chatSessions');
        if (!fs.existsSync(chats)) continue;
        const cwd = workspaceFolder(path.join(root, hash));
        const files = fs.readdirSync(chats).filter(isChat);
        for (const n of files) add(path.join(chats, n), path.join(hash, 'chatSessions', n), cwd);
        if (files.length) inv.projectDirs.push({ name: cwd ?? hash, sessions: files.length, subagents: 0, bytes: 0 });
      }
    }
    inv.assets.push({ kind: 'transcripts', label: 'Chat sessions', count: inv.sessions.length, bytes: inv.sessions.reduce((a, s) => a + s.size, 0), archived: true });
    if (emptyChats) inv.notes.push(`${emptyChats} chat file(s) with no messages were skipped.`);
    inv.unrecoverable.push('Inline completions (ghost text) are not logged by VS Code.');
    return inv;
  },

  async parse(d: DiscoveredSession, sink: SessionSink, ctx: ParseContext) {
    const acc = new SessionAccumulator(sink, { agent: 'copilot', externalId: d.externalId, isSubagent: false });
    const s = acc.session;
    s.cwd = str(d.extra?.cwd);
    const size = fs.statSync(ctx.archivePath).size;
    if (size > MAX_BYTES) throw new Error(`Chat session is too large to load (${size} bytes).`);
    const text = fs.readFileSync(ctx.archivePath, 'utf8').replace(/^﻿/, '');
    let state: Rec | undefined;
    if (/\.jsonl$/i.test(ctx.archivePath)) {
      const r = replayChatSession(text);
      state = r.state;
      for (const e of r.errors.slice(0, 50)) await acc.malformed(0, e, undefined, { offset: 0, length: 0 });
    } else {
      try {
        state = asRecord(JSON.parse(text));
      } catch (e) {
        await acc.malformed(1, `Not valid JSON: ${(e as Error).message}`, undefined, { offset: 0, length: 0 });
      }
    }
    if (!state) return acc.finish();

    s.title = str(state.customTitle);
    let promptTokens = 0;
    let outputTokens = 0;
    const requests = Array.isArray(state.requests) ? state.requests : [];
    for (const reqRaw of requests) {
      const req = asRecord(reqRaw);
      if (!req) continue;
      const r = ctx.writeRaw?.(req);
      const raw = r ? { rawOffset: r.offset, rawLength: r.length } : {};
      const timestamp = toDate(req.timestamp);
      const result = asRecord(req.result) ?? {};
      const meta = asRecord(result.metadata) ?? {};
      const model = str(meta.resolvedModel) ?? str(req.modelId);
      acc.noteModel(model);
      promptTokens += Number(meta.promptTokens) || 0;
      outputTokens += Number(meta.outputTokens) || 0;

      const prompt = str(asRecord(req.message)?.text) ?? '';
      const pseq = await acc.event({ ...raw, kind: 'user_message', role: 'user', text: prompt, uuid: str(req.requestId), timestamp, meta: { mode: str(asRecord(req.agent)?.name) } });
      if (prompt.trim()) acc.humanPrompt(pseq, prompt, timestamp, str(req.requestId));

      let buf = '';
      const flush = async (finality: 'final' | 'interim') => {
        if (!buf.trim()) return;
        const seq = await acc.event({ kind: 'assistant_message', role: 'assistant', text: buf, model, timestamp, uuid: str(req.requestId) });
        acc.assistantText(seq, buf, finality);
        buf = '';
      };
      const parts = Array.isArray(req.response) ? req.response : [];
      let toolN = 0;
      for (const pRaw of parts) {
        const p = asRecord(pRaw) ?? {};
        const kind = str(p.kind);
        if (!kind || kind === 'markdownContent' || kind === 'markdownVuln') buf += mdValue(p.value ?? p.content);
        else if (kind === 'inlineReference') {
          const ref = asRecord(p.inlineReference);
          const refPath = uriPath(ref) ?? uriPath(ref?.uri);
          const name = str(p.name) ?? str(ref?.name) ?? (refPath ? path.basename(refPath) : '');
          buf += name ? `\`${name}\`` : '';
        } else if (kind === 'thinking') {
          const t = Array.isArray(p.value) ? p.value.map(mdValue).join('') : mdValue(p.value);
          if (t.trim()) {
            await flush('interim');
            await acc.event({ kind: 'thinking', role: 'assistant', text: t, model, timestamp });
            acc.assistantPartial();
          }
        } else if (kind === 'toolInvocationSerialized' || kind === 'toolInvocation') {
          await flush('interim');
          const name = str(p.toolId) ?? 'tool';
          const id = str(p.toolCallId) ?? `${str(req.requestId)}#${toolN++}`;
          const tsd = asRecord(p.toolSpecificData) ?? {};
          const command = str(asRecord(tsd.commandLine)?.original) ?? str(asRecord(tsd.commandLine)?.toolEdited) ?? (typeof tsd.command === 'string' ? tsd.command : undefined);
          const filePath = firstUriPath(p.invocationMessage) ?? firstUriPath(p.pastTenseMessage);
          const isRead = /read|search|find|list|grep/i.test(name);
          const isEdit = /edit|write|create|replace|insert|patch/i.test(name);
          const seq = await acc.event({ kind: 'tool_call', role: 'assistant', toolName: name, toolUseId: id, text: command ? `$ ${command}` : mdValue(p.invocationMessage) || compactJson(tsd, 3000), command, filePath, model, timestamp });
          acc.toolCall(seq, id, name, { filePath: filePath && (isRead || isEdit) ? filePath : undefined, op: isEdit ? 'edit' : isRead ? 'read' : undefined, command, timestamp });
          if (p.isComplete !== false) {
            const isError = p.isConfirmed === false || asRecord(p.resultDetails)?.isError === true;
            await acc.event({ kind: 'tool_result', role: 'tool', toolName: name, toolUseId: id, text: mdValue(p.pastTenseMessage) || compactJson(p.resultDetails ?? {}, 4000), isError, timestamp });
            acc.toolResult(id, isError);
          }
        } else if (kind === 'textEditGroup') {
          const file = uriPath(p.uri);
          if (file) {
            const edits = Array.isArray(p.edits) ? p.edits.flat() : [];
            const added = edits.reduce((a: number, e) => a + (str(asRecord(e)?.text)?.split('\n').length ?? 0), 0);
            acc.extraFileOp({ eventSeq: acc.nextSeq, path: file, op: 'edit', toolName: 'textEditGroup', timestamp, succeeded: true, linesAdded: added || undefined });
          }
        }
        // progress, codeblockUri, undoStop, confirmation, elicitation, command, mcpServersStarting: UI-only.
      }

      const err = asRecord(result.errorDetails);
      const state2 = asRecord(req.modelState)?.value;
      if (err) {
        await flush('interim');
        const msg = str(err.message) ?? compactJson(err, 500);
        await acc.event({ kind: 'error', role: 'assistant', text: msg, isError: true, timestamp });
        acc.apiError(msg);
      } else if (req.isCanceled === true || state2 === 2) {
        await flush('interim');
        acc.userInterrupt();
      } else {
        await flush('final');
      }
    }

    const done = await acc.finish();
    done.startedAt = toDate(state.creationDate) ?? done.startedAt;
    done.endedAt = toDate(state.lastMessageDate) ?? done.endedAt;
    Object.assign(done.providerMeta, { editor: d.extra?.editor, usage: { inputTokens: promptTokens || null, outputTokens: outputTokens || null }, responder: state.responderUsername ?? null });
    if (!done.title && done.firstUserPrompt) done.title = clip(done.firstUserPrompt.split('\n')[0], 120);
    return done;
  },
};
