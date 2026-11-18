import fs from 'node:fs';
import path from 'node:path';
import { pathKey } from '../security/paths';
import { editorForPath, editorUserDirs } from './editors';
import { AgentAdapter, AgentInventory, DiscoveredSession, FileOpKind, ParseContext, SessionAccumulator, SessionSink, asRecord, clip, compactJson, str, toDate } from './types';

type Rec = Record<string, unknown>;

/** Cline and its forks share the same on-disk task layout. */
export const CLINE_EXTENSIONS: { id: string; agent: string; label: string }[] = [
  { id: 'saoudrizwan.claude-dev', agent: 'cline', label: 'Cline' },
  { id: 'rooveterinaryinc.roo-cline', agent: 'roo-code', label: 'Roo Code' },
  { id: 'kilocode.kilo-code', agent: 'kilo-code', label: 'Kilo Code' },
];

const FILE_TOOLS: Record<string, FileOpKind> = { read_file: 'read', write_to_file: 'write', replace_in_file: 'edit', apply_diff: 'edit', insert_content: 'edit', search_and_replace: 'edit', edit_file: 'edit' };
const COMMAND_TOOLS = new Set(['execute_command']);
const MAX_JSON_BYTES = 300 * 1024 * 1024;

function readJson(file: string): unknown {
  try {
    const st = fs.statSync(file);
    if (st.size > MAX_JSON_BYTES) return undefined;
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch {
    return undefined;
  }
}

function extensionOf(root: string) {
  const base = path.basename(root).toLowerCase();
  return CLINE_EXTENSIONS.find((e) => e.id === base) ?? CLINE_EXTENSIONS[0];
}

/**
 * Cline wraps what the human typed in <task>/<feedback>/<answer> tags and appends large generated
 * blocks (<environment_details>, task_progress instructions). Returns the human part, if any.
 */
export function clineHumanText(raw: string): { human?: string; rest: string } {
  const text = raw.replace(/<environment_details>[\s\S]*?<\/environment_details>/g, '').trim();
  for (const tag of ['task', 'feedback', 'answer', 'user_message']) {
    const m = text.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
    if (m && m[1].trim()) return { human: m[1].trim(), rest: text };
  }
  return { rest: text };
}

const isBoilerplate = (t: string) => !t.trim() || /^#\s*task_progress\b/i.test(t.trim()) || /^\[TASK RESUMPTION\]/.test(t.trim());

function blockText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => (typeof b === 'string' ? b : str(asRecord(b)?.text) ?? '')).filter(Boolean).join('\n');
}

export const clineAdapter: AgentAdapter = {
  id: 'cline',
  label: 'Cline / Roo Code / Kilo Code',
  capabilities: {
    toolCalls: true,
    toolResults: true,
    thinking: true,
    subagents: false,
    fileSnapshots: false,
    todos: true,
    gitMetadata: false,
    maturity: 'verified',
    notes: 'Reads tasks from the extension storage of VS Code, Cursor, Windsurf, Antigravity and other VS Code forks: the API conversation (prompts, tool calls and results), the UI log (completion, errors) and the task index (folder, cost, tokens).',
  },

  defaultRoots() {
    const out: string[] = [];
    for (const e of editorUserDirs()) {
      for (const ext of CLINE_EXTENSIONS) {
        const dir = path.join(e.dir, 'globalStorage', ext.id);
        if (fs.existsSync(dir)) out.push(dir);
      }
    }
    return out;
  },

  async scan(root: string): Promise<AgentInventory> {
    const ext = extensionOf(root);
    const editor = editorForPath(root);
    const label = `${ext.label}${editor ? ` (${editor})` : ''}`;
    const inv: AgentInventory = { agent: 'cline', label, root, exists: fs.existsSync(root), sessions: [], projectDirs: [], assets: [], notes: [], unrecoverable: [], errors: [] };
    if (!inv.exists) return inv;
    const tasksDir = path.join(root, 'tasks');
    if (!fs.existsSync(tasksDir)) {
      inv.notes.push('No tasks folder yet.');
      return inv;
    }
    const history = readJson(path.join(root, 'state', 'taskHistory.json'));
    const index = new Map<string, Rec>();
    if (Array.isArray(history)) for (const h of history) if (asRecord(h)?.id) index.set(String(asRecord(h)!.id), h as Rec);
    let bytes = 0;
    for (const id of fs.readdirSync(tasksDir)) {
      const dir = path.join(tasksDir, id);
      const api = path.join(dir, 'api_conversation_history.json');
      if (!fs.existsSync(api)) continue;
      const companions = ['ui_messages.json', 'task_metadata.json'].map((n) => path.join(dir, n)).filter((f) => fs.existsSync(f));
      const stats = [api, ...companions].map((f) => fs.statSync(f));
      const size = stats.reduce((a, s) => a + s.size, 0);
      const mtime = new Date(Math.max(...stats.map((s) => s.mtimeMs)));
      bytes += size;
      const h = index.get(id);
      inv.sessions.push({
        agent: 'cline',
        reportedAgent: ext.agent,
        externalId: id,
        sourcePath: api,
        sourceKey: `cline:${pathKey(api)}`,
        size,
        mtime,
        relPath: path.join('tasks', id, 'api_conversation_history.json'),
        projectHint: str(h?.cwdOnTaskInitialization),
        companions,
        extra: h ? { task: h.task, cwd: h.cwdOnTaskInitialization, totalCost: h.totalCost, tokensIn: h.tokensIn, tokensOut: h.tokensOut, cacheReads: h.cacheReads, cacheWrites: h.cacheWrites, modelId: h.modelId } : undefined,
      });
    }
    inv.assets.push({ kind: 'transcripts', label: `${ext.label} tasks`, count: inv.sessions.length, bytes, archived: true });
    if (fs.existsSync(path.join(root, 'checkpoints'))) inv.assets.push({ kind: 'checkpoints', label: 'Workspace checkpoints (shadow Git)', count: 0, bytes: 0, archived: false, note: 'Not copied: they are full Git repositories of your workspace.' });
    return inv;
  },

  async parse(d: DiscoveredSession, sink: SessionSink, ctx: ParseContext) {
    const acc = new SessionAccumulator(sink, { agent: 'cline', externalId: d.externalId, isSubagent: false });
    const s = acc.session;
    const extra = d.extra ?? {};
    const cwd = str(extra.cwd);
    s.cwd = cwd;
    if (typeof extra.task === 'string') s.title = clip(extra.task.split('\n')[0], 120);
    const companion = (name: string) => ctx.companions?.find((c) => c && path.basename(c) === name);

    const conv = readJson(ctx.archivePath);
    if (!Array.isArray(conv)) {
      await acc.malformed(1, 'api_conversation_history.json is not a JSON array (or is too large).', undefined, { offset: 0, length: 0 });
      return acc.finish();
    }
    const abs = (p?: string) => (p && cwd && !path.isAbsolute(p) ? path.join(cwd, p) : p);
    let cost = 0;
    let tokensIn = 0;
    let tokensOut = 0;
    let first = true;

    for (const item of conv) {
      const m = asRecord(item);
      if (!m) continue;
      const r = ctx.writeRaw?.(item);
      const raw = r ? { rawOffset: r.offset, rawLength: r.length } : {};
      const timestamp = toDate(m.ts);
      const role = str(m.role);
      const blocks: unknown[] = Array.isArray(m.content) ? m.content : [{ type: 'text', text: blockText(m.content) }];
      const model = str(asRecord(m.modelInfo)?.modelId);
      const metrics = asRecord(m.metrics);
      if (metrics) {
        cost += Number(metrics.cost) || 0;
        tokensIn += Number(asRecord(metrics.tokens)?.prompt) || 0;
        tokensOut += Number(asRecord(metrics.tokens)?.completion) || 0;
      }

      if (role === 'user') {
        const texts: string[] = [];
        for (const b of blocks) {
          const o = asRecord(b) ?? {};
          if (o.type === 'tool_result') {
            const id = str(o.tool_use_id) ?? str(o.call_id);
            const isError = o.is_error === true;
            await acc.event({ ...raw, kind: 'tool_result', role: 'tool', toolUseId: id, text: blockText(o.content), isError, timestamp });
            acc.toolResult(id, isError);
          } else if (o.type === 'text' && typeof o.text === 'string') texts.push(o.text);
          else if (o.type === 'image') await acc.event({ ...raw, kind: 'attachment', role: 'user', text: '[image]', timestamp });
        }
        const joined = texts.filter((t) => !isBoilerplate(t)).join('\n');
        const { human, rest } = clineHumanText(joined);
        if (human || (first && rest.trim())) {
          const text = human ?? rest;
          const seq = await acc.event({ ...raw, kind: 'user_message', role: 'user', text, timestamp });
          acc.humanPrompt(seq, text, timestamp);
        } else if (rest.trim()) {
          await acc.event({ ...raw, kind: 'user_message', role: 'user', text: rest, isMeta: true, subtype: 'injected', timestamp });
          acc.injectedUser();
        }
        first = false;
      } else if (role === 'assistant') {
        acc.noteModel(model);
        for (const b of blocks) {
          const o = asRecord(b) ?? {};
          if (o.type === 'text' && typeof o.text === 'string') {
            const seq = await acc.event({ ...raw, kind: 'assistant_message', role: 'assistant', text: o.text, model, timestamp });
            if (o.text.trim()) acc.assistantText(seq, o.text, 'interim');
          } else if (o.type === 'thinking' || o.type === 'reasoning' || o.type === 'redacted_thinking') {
            await acc.event({ ...raw, kind: 'thinking', role: 'assistant', text: str(o.thinking) ?? str(o.text) ?? '[redacted thinking]', model, timestamp });
            acc.assistantPartial();
          } else if (o.type === 'tool_use') {
            const name = str(o.name) ?? 'tool';
            const id = str(o.id) ?? str(o.call_id);
            const input = asRecord(o.input) ?? {};
            const command = COMMAND_TOOLS.has(name) ? str(input.command) : undefined;
            const op = FILE_TOOLS[name];
            const filePath = abs(str(input.path) ?? str(input.file_path));
            if (name === 'attempt_completion') {
              const text = str(input.result) ?? '';
              const seq = await acc.event({ ...raw, kind: 'assistant_message', role: 'assistant', subtype: 'attempt_completion', toolName: name, toolUseId: id, text, model, timestamp });
              if (text) acc.assistantText(seq, text, 'final');
              acc.turnEndedByTool(name);
              continue;
            }
            const seq = await acc.event({ ...raw, kind: 'tool_call', role: 'assistant', toolName: name, toolUseId: id, text: command ? `$ ${command}` : compactJson(input, 6000), command, filePath, model, timestamp });
            acc.toolCall(seq, id, name, { filePath: op ? filePath : undefined, op, command, timestamp });
            const progress = str(input.task_progress);
            if (progress) {
              const todos = progress.split('\n').map((l) => l.match(/^\s*-\s*\[( |x|X)\]\s*(.+)$/)).filter((x): x is RegExpMatchArray => !!x);
              if (todos.length) acc.setTodos(todos.map((t) => ({ key: t[2].trim(), content: t[2].trim(), status: t[1] === ' ' ? 'pending' : 'completed' })));
            }
          }
        }
      }
    }

    // The UI log records how the task ended (completion, error, mistake limit), which the API history does not.
    const uiFile = companion('ui_messages.json');
    const ui = uiFile ? readJson(uiFile) : undefined;
    if (Array.isArray(ui) && ui.length) {
      const msgs = ui.map((x) => asRecord(x) ?? {});
      for (const u of msgs) acc.noteTime(toDate(u.ts));
      const last = [...msgs].reverse().find((u) => u.ask || (u.say && !['api_req_started', 'checkpoint_created', 'api_req_retried', 'reasoning'].includes(String(u.say))));
      const kind = String(last?.ask ?? last?.say ?? '');
      if (kind === 'api_req_failed' || kind === 'mistake_limit_reached' || kind === 'error') {
        const text = str(last?.text) ?? kind;
        await acc.event({ kind: 'error', rawType: 'ui_message', subtype: kind, text, isError: true, timestamp: toDate(last?.ts) });
        acc.apiError(`${kind}: ${clip(text, 300)}`);
      } else if (kind === 'resume_task') {
        s.providerMeta.resumable = true;
      }
      s.providerMeta.uiMessageCount = msgs.length;
    }

    const done = await acc.finish();
    Object.assign(done.providerMeta, {
      extension: d.reportedAgent,
      usage: { costUsd: Number(extra.totalCost) || cost || null, inputTokens: Number(extra.tokensIn) || tokensIn || null, outputTokens: Number(extra.tokensOut) || tokensOut || null, cacheReadTokens: Number(extra.cacheReads) || null, cacheWriteTokens: Number(extra.cacheWrites) || null },
    });
    if (!done.title && done.firstUserPrompt) done.title = clip(done.firstUserPrompt.split('\n')[0], 120);
    return done;
  },
};
