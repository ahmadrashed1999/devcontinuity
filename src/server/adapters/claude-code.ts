import fs from 'node:fs';
import path from 'node:path';
import { homeDir } from '../config';
import { readJsonl } from '../parsers/jsonl';
import { isSensitiveFile, pathKey } from '../security/paths';
import { redactSecrets } from '../security/redact';
import {
  AgentAdapter,
  AgentInventory,
  AssetGroup,
  DiscoveredSession,
  FileOpKind,
  NormalizedTodo,
  ParseContext,
  SessionAccumulator,
  SessionSink,
  asRecord,
  clip,
  compactJson,
  str,
  toDate,
} from './types';

type Rec = Record<string, unknown>;

/** Record types we understand but that carry bookkeeping rather than conversation. Anything not listed here or handled below is stored as `unknown`. */
const META_TYPES = new Set([
  'last-prompt', 'atis-latch', 'custom-title', 'ai-title', 'agent-name', 'api-request', 'api-request-blob', 'api-request-shape',
  'bridge-session', 'pr-link', 'queue-operation', 'mode', 'permission-mode', 'frame-link', 'relocated', 'tools-used',
  'artifact-autoreact-ledger', 'artifact-comment-monitor', 'cost-state', 'tag', 'content-replacement', 'worktree-state',
]);
/** Meta records Claude Code rewrites over and over with identical content. Consecutive duplicates are collapsed (and counted); originals stay in the archive. */
const COLLAPSIBLE = new Set(['custom-title', 'ai-title', 'agent-name', 'atis-latch', 'bridge-session', 'mode', 'permission-mode', 'last-prompt', 'tools-used', 'relocated']);

const FILE_TOOLS: Record<string, { op: FileOpKind; key: string }> = {
  Read: { op: 'read', key: 'file_path' },
  Write: { op: 'write', key: 'file_path' },
  Edit: { op: 'edit', key: 'file_path' },
  MultiEdit: { op: 'edit', key: 'file_path' },
  NotebookEdit: { op: 'notebook_edit', key: 'notebook_path' },
};
const SHELL_TOOLS = new Set(['Bash', 'PowerShell', 'BashOutput']);

const INJECTED_PREFIX = /^<(?:system-reminder|task-notification|bash-input|bash-stdout|bash-stderr|user-prompt-submit-hook|teammate-message|local-command-caveat)/;
const SLASH_PREFIX = /^<(?:command-name|command-message|command-args|local-command-stdout|local-command-stderr)/;

function classifyUserText(rec: Rec, text: string, subagentFile: boolean): 'human' | 'injected' | 'slash' | 'compact' | 'interrupt' {
  if (rec.isCompactSummary) return 'compact';
  const t = text.trimStart();
  if (t.startsWith('[Request interrupted by user')) return 'interrupt';
  if (subagentFile) return 'injected';
  const origin = str(asRecord(rec.origin)?.kind);
  if (origin && origin !== 'human') return 'injected';
  if (SLASH_PREFIX.test(t)) return 'slash';
  if (origin === 'human') return 'human';
  if (rec.isMeta || rec.sourceToolUseID || rec.promptSource === 'system' || rec.isVisibleInTranscriptOnly) return 'injected';
  if (INJECTED_PREFIX.test(t) || t.startsWith('Caveat: The messages below')) return 'injected';
  return 'human';
}

function resultText(content: unknown, tur: Rec | undefined): string {
  let out = '';
  if (typeof content === 'string') out = content;
  else if (Array.isArray(content)) {
    out = content
      .map((b) => {
        const o = asRecord(b);
        if (!o) return typeof b === 'string' ? b : '';
        if (o.type === 'text') return str(o.text) ?? '';
        if (o.type === 'image') return '[image]';
        if (o.type === 'tool_reference') return `[tool reference: ${str(o.tool_name) ?? str(o.name) ?? 'tool'}]`;
        return `[${String(o.type)}]`;
      })
      .filter(Boolean)
      .join('\n');
  }
  if (!out.trim() && tur) {
    const so = str(tur.stdout);
    const se = str(tur.stderr);
    out = [so, se ? `[stderr]\n${se}` : ''].filter(Boolean).join('\n');
  }
  return out;
}

function patchStats(tur: Rec | undefined): { linesAdded?: number; linesRemoved?: number } {
  const patch = tur?.structuredPatch;
  if (!Array.isArray(patch)) return {};
  let added = 0;
  let removed = 0;
  for (const hunk of patch) {
    const lines = asRecord(hunk)?.lines;
    if (!Array.isArray(lines)) continue;
    for (const l of lines) {
      if (typeof l !== 'string') continue;
      if (l.startsWith('+')) added++;
      else if (l.startsWith('-')) removed++;
    }
  }
  return { linesAdded: added, linesRemoved: removed };
}

function attachmentInfo(att: Rec): { text?: string; filePath?: string; isError?: boolean } {
  const t = att.type;
  switch (t) {
    case 'queued_command':
      return { text: typeof att.prompt === 'string' ? att.prompt : compactJson(att.prompt, 2000) };
    case 'edited_text_file':
    case 'file':
    case 'compact_file_reference':
      return { filePath: str(att.filename) };
    case 'directory':
      return { filePath: str(att.path) };
    case 'plan_mode':
    case 'plan_mode_exit':
      return { filePath: str(att.planFilePath) };
    case 'hook_non_blocking_error':
      return { text: `${str(att.hookName) ?? 'hook'}: ${str(att.stderr) ?? str(att.stdout) ?? ''}`, isError: true };
    case 'hook_cancelled':
      return { text: `${str(att.hookName) ?? 'hook'} cancelled${att.timedOut ? ' (timed out)' : ''}` };
    case 'hook_system_message':
      return { text: typeof att.content === 'string' ? att.content : compactJson(att.content, 2000) };
    case 'remote_session_change':
      return { text: [str(att.commit) && `commit ${att.commit}`, str(att.pr) && `pr ${att.pr}`].filter(Boolean).join(' ') || undefined };
    default:
      return {};
  }
}

interface WalkEntry {
  full: string;
  rel: string;
  size: number;
  mtime: Date;
}

function walk(dir: string, base: string, out: WalkEntry[], errors: string[], depth = 0): void {
  if (depth > 12) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    errors.push(`Cannot read ${dir}: ${(e as Error).message}`);
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) walk(full, base, out, errors, depth + 1);
    else if (e.isFile()) {
      try {
        const st = fs.statSync(full);
        out.push({ full, rel: path.relative(base, full), size: st.size, mtime: st.mtime });
      } catch (err) {
        errors.push(`Cannot stat ${full}: ${(err as Error).message}`);
      }
    }
  }
}

function dirStats(dir: string, errors: string[]): { count: number; bytes: number } | null {
  if (!fs.existsSync(dir)) return null;
  const files: WalkEntry[] = [];
  walk(dir, dir, files, errors);
  return { count: files.length, bytes: files.reduce((a, f) => a + f.size, 0) };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const claudeCodeAdapter: AgentAdapter = {
  id: 'claude-code',
  label: 'Claude Code',
  capabilities: {
    toolCalls: true,
    toolResults: true,
    thinking: true,
    subagents: true,
    fileSnapshots: true,
    todos: true,
    gitMetadata: true,
    maturity: 'verified',
    notes: 'Parses JSONL transcripts under projects/, including subagent transcripts, file-history records, plans and project memory.',
  },

  defaultRoots() {
    const roots = [process.env.CLAUDE_CONFIG_DIR?.trim(), path.join(homeDir(), '.claude')].filter((r): r is string => !!r);
    return [...new Set(roots.map((r) => path.resolve(r)))];
  },

  async scan(root: string): Promise<AgentInventory> {
    const inv: AgentInventory = { agent: 'claude-code', label: 'Claude Code', root, exists: fs.existsSync(root), sessions: [], projectDirs: [], assets: [], notes: [], unrecoverable: [], errors: [] };
    if (!inv.exists) {
      inv.unrecoverable.push(`The Claude Code directory ${root} does not exist on this machine.`);
      return inv;
    }
    const projectsDir = path.join(root, 'projects');
    const other = { toolResults: { count: 0, bytes: 0 }, memory: { count: 0, bytes: 0 }, misc: { count: 0, bytes: 0 } };
    let emptyProjectDirs = 0;

    if (fs.existsSync(projectsDir)) {
      let dirs: fs.Dirent[] = [];
      try {
        dirs = fs.readdirSync(projectsDir, { withFileTypes: true }).filter((d) => d.isDirectory());
      } catch (e) {
        inv.errors.push(`Cannot read ${projectsDir}: ${(e as Error).message}`);
      }
      for (const d of dirs) {
        const pdir = path.join(projectsDir, d.name);
        const files: WalkEntry[] = [];
        walk(pdir, root, files, inv.errors);
        let sessions = 0;
        let subagents = 0;
        let bytes = 0;
        let lastWrite: Date | undefined;
        for (const f of files) {
          bytes += f.size;
          if (!lastWrite || f.mtime > lastWrite) lastWrite = f.mtime;
          const parts = path.relative(pdir, f.full).split(path.sep);
          const name = parts[parts.length - 1];
          if (name.endsWith('.jsonl')) {
            const isSub = parts.includes('subagents');
            const base = name.replace(/\.jsonl$/, '');
            if (isSub) {
              subagents++;
              const parent = parts.find((p) => UUID_RE.test(p));
              inv.sessions.push({ agent: 'claude-code', externalId: base, sourcePath: f.full, sourceKey: `claude-code:${pathKey(f.full)}`, size: f.size, mtime: f.mtime, relPath: f.rel, projectHint: d.name, isSubagent: true, parentExternalId: parent, subagentId: base.replace(/^agent-/, '') });
            } else if (parts.length === 1) {
              sessions++;
              inv.sessions.push({ agent: 'claude-code', externalId: base, sourcePath: f.full, sourceKey: `claude-code:${pathKey(f.full)}`, size: f.size, mtime: f.mtime, relPath: f.rel, projectHint: d.name });
            } else {
              other.misc.count++;
              other.misc.bytes += f.size;
              inv.notes.push(`Unexpected JSONL location (archived, not imported as a session): ${f.rel}`);
            }
          } else if (parts.includes('tool-results')) {
            other.toolResults.count++;
            other.toolResults.bytes += f.size;
          } else if (parts.includes('memory')) {
            other.memory.count++;
            other.memory.bytes += f.size;
          } else {
            other.misc.count++;
            other.misc.bytes += f.size;
          }
        }
        if (sessions === 0) emptyProjectDirs++;
        inv.projectDirs.push({ name: d.name, sessions, subagents, bytes, lastWrite });
      }
    } else {
      inv.unrecoverable.push('projects/ is missing: no Claude Code transcripts are stored in this directory.');
    }

    const sessionBytes = inv.sessions.reduce((a, s) => a + s.size, 0);
    const assets: AssetGroup[] = [
      { kind: 'transcripts', label: 'Session transcripts (JSONL, incl. subagents)', count: inv.sessions.length, bytes: sessionBytes, relDir: 'projects', archived: true },
      { kind: 'tool-results', label: 'Persisted tool results (large outputs, screenshots)', ...other.toolResults, relDir: 'projects', archived: true },
      { kind: 'memory', label: 'Project memory notes', ...other.memory, relDir: 'projects', archived: true },
      { kind: 'project-misc', label: 'Other per-session files (titles, metadata)', ...other.misc, relDir: 'projects', archived: true },
    ];
    const optional: [string, string, string][] = [
      ['file-history', 'File snapshots (pre-edit backups)', 'file-history'],
      ['plans', 'Saved plans', 'plans'],
      ['todos', 'Todo lists', 'todos'],
      ['paste-cache', 'Pasted content cache', 'paste-cache'],
    ];
    for (const [kind, label, rel] of optional) {
      const st = dirStats(path.join(root, rel), inv.errors);
      if (st) assets.push({ kind, label, ...st, relDir: rel, archived: true });
      else {
        assets.push({ kind, label, count: 0, bytes: 0, archived: false, note: 'Not present on this machine.' });
        inv.unrecoverable.push(`${rel}/ does not exist in ${root}; nothing to recover from it.`);
      }
    }
    const history = path.join(root, 'history.jsonl');
    if (fs.existsSync(history)) {
      const size = fs.statSync(history).size;
      assets.push({ kind: 'history', label: 'Prompt history (history.jsonl)', count: 1, bytes: size, relDir: 'history.jsonl', archived: true });
      if (size < 4096) inv.notes.push(`history.jsonl is only ${size} bytes, so it holds very little prompt history.`);
    } else inv.unrecoverable.push('history.jsonl is missing.');

    for (const rel of ['shell-snapshots', 'session-env']) {
      const st = dirStats(path.join(root, rel), inv.errors);
      if (st) assets.push({ kind: rel, label: `${rel} (environment captures)`, ...st, archived: false, note: 'Deliberately not copied: may contain environment variables and secrets.' });
    }
    assets.push({ kind: 'credentials', label: 'Credential and account files', count: 0, bytes: 0, archived: false, note: 'Never read, copied or indexed (.credentials.json, .claude.json and its backups).' });
    inv.assets = assets;

    if (emptyProjectDirs > 0) {
      inv.unrecoverable.push(`${emptyProjectDirs} project folder(s) contain no transcript files (only titles, memory or nothing). Their conversations cannot be recovered locally.`);
    }
    inv.unrecoverable.push('Conversations that lived only in the Claude web/desktop apps or in remote (cloud) sessions are not on this disk.');
    inv.unrecoverable.push("The model's hidden runtime state and signature-only (encrypted) thinking blocks cannot be reconstructed; only what was written to the transcript is available.");
    return inv;
  },

  async parse(d: DiscoveredSession, sink: SessionSink, ctx: ParseContext) {
    const acc = new SessionAccumulator(sink, { agent: 'claude-code', externalId: d.externalId, isSubagent: !!d.isSubagent, parentExternalId: d.parentExternalId, subagentId: d.subagentId });
    const s = acc.session;
    const typeCounts: Record<string, number> = {};
    const unknownTypes: Record<string, number> = {};
    const lastMeta = new Map<string, string>();
    const versions = new Set<string>();
    const prLinks = new Map<string, Rec>();
    const todos = new Map<string, NormalizedTodo>();
    const toolNames = new Map<string, string>();
    let collapsed = 0;
    let customTitle: string | undefined;
    let aiTitle: string | undefined;
    // Token usage per API response. Claude Code repeats a response's usage on every content block of
    // that message, so it is counted once per message id.
    const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 0 };
    const usageSeen = new Set<string>();
    let summaryTitle: string | undefined;
    let lastPrompt: string | undefined;
    let signatureOnlyThinking = 0;
    let compactions = 0;
    let truncatedTail = false;

    for await (const line of readJsonl(ctx.archivePath)) {
      const raw = { rawOffset: line.offset, rawLength: line.length, lineNo: line.lineNo };
      if (line.error) {
        if (line.unterminated) truncatedTail = true;
        await acc.malformed(line.lineNo, line.error, line.preview, { offset: line.offset, length: line.length });
        continue;
      }
      const rec = asRecord(line.value);
      if (!rec) {
        await acc.event({ ...raw, kind: 'unknown', rawType: '<non-object>', text: compactJson(line.value, 500) });
        continue;
      }
      const type = str(rec.type) ?? '<no-type>';
      typeCounts[type] = (typeCounts[type] ?? 0) + 1;
      const timestamp = toDate(rec.timestamp);
      const common = { ...raw, rawType: type, timestamp, uuid: str(rec.uuid), parentUuid: str(rec.parentUuid), isSidechain: rec.isSidechain === true };
      acc.noteCwd(str(rec.cwd));
      if (str(rec.gitBranch)) s.gitBranch = str(rec.gitBranch);
      if (str(rec.version)) versions.add(rec.version as string);

      if (type === 'user') {
        const msg = asRecord(rec.message);
        const content = msg?.content;
        const tur = asRecord(rec.toolUseResult);
        const handleText = async (text: string, blockIndex?: number) => {
          const cls = classifyUserText(rec, text, !!d.isSubagent);
          if (cls === 'compact') {
            compactions++;
            await acc.event({ ...common, blockIndex, kind: 'summary', role: 'user', subtype: 'compact_summary', text });
            return;
          }
          const seq = await acc.event({ ...common, blockIndex, kind: 'user_message', role: 'user', text, isMeta: cls !== 'human', subtype: cls === 'human' ? undefined : cls === 'injected' && d.isSubagent ? 'delegated_prompt' : cls });
          if (cls === 'human') acc.humanPrompt(seq, text, timestamp, str(rec.uuid));
          else if (cls === 'interrupt') acc.userInterrupt();
          else {
            acc.injectedUser();
            if (d.isSubagent && !s.firstUserPrompt && text.trim()) s.firstUserPrompt = clip(redactSecrets(text.trim()), 2000);
          }
        };
        if (typeof content === 'string') await handleText(content);
        else if (Array.isArray(content)) {
          const texts: string[] = [];
          let firstTextIdx: number | undefined;
          for (let i = 0; i < content.length; i++) {
            const b = asRecord(content[i]);
            if (!b) continue;
            if (b.type === 'text') {
              if (firstTextIdx == null) firstTextIdx = i;
              if (str(b.text)) texts.push(b.text as string);
            } else if (b.type === 'tool_result') {
              const id = str(b.tool_use_id);
              const isError = b.is_error === true;
              const stats = patchStats(tur);
              const meta: Rec = {};
              if (tur?.interrupted === true) meta.interrupted = true;
              if (str(tur?.backgroundTaskId)) meta.backgroundTaskId = tur?.backgroundTaskId;
              if (stats.linesAdded != null) Object.assign(meta, stats);
              const seq = await acc.event({ ...common, blockIndex: i, kind: 'tool_result', role: 'tool', toolUseId: id, toolName: id ? toolNames.get(id) : undefined, isError, text: resultText(b.content, tur), filePath: str(tur?.filePath), meta: Object.keys(meta).length ? meta : undefined });
              acc.toolResult(id, isError, stats);
              if (rec.toolEndsTurn === true) acc.turnEndedByTool(id ? toolNames.get(id) : undefined);
              const git = asRecord(tur?.gitOperation);
              if (git) {
                const c = asRecord(git.commit);
                if (c) acc.gitOp({ kind: 'commit', sha: str(c.sha), branch: str(c.branch), action: str(c.kind), seq, timestamp });
                const p = asRecord(git.push);
                if (p) acc.gitOp({ kind: 'push', branch: str(p.branch), seq, timestamp });
                const pr = asRecord(git.pr);
                if (pr) acc.gitOp({ kind: 'pr', prNumber: typeof pr.number === 'number' ? pr.number : undefined, prUrl: str(pr.url), action: str(pr.action), seq, timestamp });
                const br = asRecord(git.branch);
                if (br) acc.gitOp({ kind: 'branch', branch: str(br.ref), action: str(br.action), seq, timestamp });
              }
            } else if (b.type === 'image') {
              await acc.event({ ...common, blockIndex: i, kind: 'attachment', role: 'user', subtype: 'image', text: '[image attached by user]' });
            } else {
              await acc.event({ ...common, blockIndex: i, kind: 'unknown', role: 'user', subtype: `user_block:${String(b.type)}` });
            }
          }
          if (texts.length) await handleText(texts.join('\n'), firstTextIdx);
        } else {
          await acc.event({ ...common, kind: 'unknown', role: 'user', subtype: 'user_without_content' });
        }
        continue;
      }

      if (type === 'assistant') {
        const msg = asRecord(rec.message);
        const model = str(msg?.model);
        acc.noteModel(model);
        const u = asRecord(msg?.usage);
        const mid = str(msg?.id) ?? str(rec.uuid);
        if (u && (!mid || !usageSeen.has(mid))) {
          if (mid) usageSeen.add(mid);
          const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
          usage.inputTokens += n(u.input_tokens);
          usage.outputTokens += n(u.output_tokens);
          usage.cacheReadTokens += n(u.cache_read_input_tokens);
          usage.cacheWriteTokens += n(u.cache_creation_input_tokens);
          usage.requests++;
        }
        const stop = msg?.stop_reason;
        const content = Array.isArray(msg?.content) ? (msg?.content as unknown[]) : [];
        if (rec.isApiErrorMessage === true) {
          const text = content.map((b) => str(asRecord(b)?.text) ?? '').join('\n') || compactJson(rec.error ?? rec.apiError, 500);
          await acc.event({ ...common, kind: 'error', role: 'assistant', subtype: 'api_error', text, isError: true, model, meta: { status: rec.apiErrorStatus ?? null } });
          acc.apiError(text);
          continue;
        }
        if (content.length === 0) {
          await acc.event({ ...common, kind: 'meta', role: 'assistant', subtype: 'empty_assistant', model });
          continue;
        }
        for (let i = 0; i < content.length; i++) {
          const b = asRecord(content[i]);
          if (!b) continue;
          if (b.type === 'text') {
            const text = str(b.text) ?? '';
            const seq = await acc.event({ ...common, blockIndex: i, kind: 'assistant_message', role: 'assistant', text, model, meta: stop ? { stopReason: stop } : undefined });
            if (text.trim()) acc.assistantText(seq, text, stop === 'end_turn' || stop === 'stop_sequence' ? 'final' : stop == null ? 'unknown' : 'interim');
          } else if (b.type === 'thinking' || b.type === 'redacted_thinking') {
            const text = str(b.thinking);
            if (!text) signatureOnlyThinking++;
            await acc.event({ ...common, blockIndex: i, kind: 'thinking', role: 'assistant', text, model, subtype: text ? undefined : 'signature_only' });
            acc.assistantPartial();
          } else if (b.type === 'tool_use' || b.type === 'server_tool_use') {
            const name = str(b.name) ?? 'unknown';
            const id = str(b.id);
            const input = asRecord(b.input) ?? {};
            const fileTool = FILE_TOOLS[name];
            const filePath = fileTool ? str(input[fileTool.key]) : str(input.path) ?? str(input.file_path);
            const command = SHELL_TOOLS.has(name) ? str(input.command) : undefined;
            let text: string;
            if (command) text = [str(input.description), `$ ${command}`].filter(Boolean).join('\n');
            else if (name === 'Agent' || name === 'Task') text = [str(input.subagent_type) && `[${input.subagent_type}]`, str(input.description), str(input.prompt)].filter(Boolean).join('\n');
            else text = compactJson(input, 6000);
            const meta: Rec = {};
            if (name === 'Agent' || name === 'Task') meta.subagentType = input.subagent_type ?? null;
            if (input.run_in_background === true) meta.background = true;
            const seq = await acc.event({ ...common, blockIndex: i, kind: 'tool_call', role: 'assistant', toolName: name, toolUseId: id, text, filePath, command, model, meta: Object.keys(meta).length ? meta : undefined });
            if (id) toolNames.set(id, name);
            acc.toolCall(seq, id, name, { filePath: fileTool ? filePath : undefined, op: fileTool?.op, command, timestamp });

            if (name === 'TodoWrite' && Array.isArray(input.todos)) {
              todos.clear();
              for (const t of input.todos) {
                const o = asRecord(t);
                const c = str(o?.content);
                if (c) todos.set(c, { key: c, content: c, status: str(o?.status) ?? 'pending', priority: str(o?.priority) });
              }
            } else if (name === 'TaskCreate' && str(input.subject)) {
              const key = id ?? `task-${seq}`;
              todos.set(key, { key, content: [input.subject, str(input.description)].filter(Boolean).join(' — '), status: 'pending' });
            } else if (name === 'TaskUpdate' && str(input.status)) {
              const target = todos.get(String(input.taskId)) ?? [...todos.values()][Number(input.taskId) - 1];
              if (target) target.status = input.status as string;
            } else if (name === 'ExitPlanMode' && str(input.plan)) {
              s.plans.push({ text: input.plan as string, seq, timestamp });
            }
          } else {
            await acc.event({ ...common, blockIndex: i, kind: 'unknown', role: 'assistant', subtype: `assistant_block:${String(b.type)}`, model });
          }
        }
        continue;
      }

      if (type === 'system') {
        const subtype = str(rec.subtype);
        if (subtype === 'api_error') {
          const text = str(rec.content) ?? compactJson(rec.error, 800);
          await acc.event({ ...common, kind: 'error', role: 'system', subtype, text, isError: true, meta: { retryAttempt: rec.retryAttempt ?? null, maxRetries: rec.maxRetries ?? null } });
          acc.apiError(text);
        } else {
          if (subtype === 'compact_boundary') compactions++;
          await acc.event({ ...common, kind: 'system', role: 'system', subtype, text: str(rec.content), isMeta: rec.isMeta === true });
        }
        continue;
      }

      if (type === 'attachment') {
        const att = asRecord(rec.attachment) ?? {};
        const info = attachmentInfo(att);
        await acc.event({ ...common, kind: 'attachment', subtype: str(att.type), text: info.text, filePath: info.filePath, isError: info.isError });
        continue;
      }

      if (type === 'summary') {
        summaryTitle = str(rec.summary) ?? summaryTitle;
        await acc.event({ ...common, kind: 'summary', subtype: 'session_summary', text: str(rec.summary) });
        continue;
      }

      if (type === 'file-history-snapshot' || type === 'file-history-delta') {
        if (type === 'file-history-delta') {
          const backup = asRecord(rec.backup);
          const p = str(rec.trackingPath);
          const seq = await acc.event({ ...common, kind: 'file_snapshot', subtype: 'delta', filePath: p, meta: { backupFileName: backup?.backupFileName ?? null, version: backup?.version ?? null, backupTime: backup?.backupTime ?? null } });
          if (p && str(backup?.backupFileName)) acc.extraFileOp({ eventSeq: seq, path: p, op: 'snapshot', timestamp: toDate(backup?.backupTime) ?? timestamp, succeeded: true });
        } else {
          const snap = asRecord(rec.snapshot);
          const tracked = asRecord(snap?.trackedFileBackups) ?? {};
          await acc.event({ ...common, timestamp: toDate(snap?.timestamp) ?? timestamp, kind: 'file_snapshot', subtype: 'snapshot', meta: { trackedFiles: Object.keys(tracked).length, messageId: rec.messageId ?? null } });
        }
        continue;
      }

      if (META_TYPES.has(type)) {
        if (type === 'custom-title') customTitle = str(rec.customTitle) ?? customTitle;
        else if (type === 'ai-title') aiTitle = str(rec.aiTitle) ?? aiTitle;
        else if (type === 'last-prompt') lastPrompt = str(rec.lastPrompt) ?? lastPrompt;
        else if (type === 'agent-name') s.providerMeta.agentName = rec.agentName;
        else if (type === 'relocated') s.providerMeta.relocatedCwd = rec.relocatedCwd;
        else if (type === 'permission-mode') s.providerMeta.permissionMode = rec.permissionMode;
        else if (type === 'cost-state') {
          s.providerMeta.cost = { totalCostUSD: rec.totalCostUSD, totalLinesAdded: rec.totalLinesAdded, totalLinesRemoved: rec.totalLinesRemoved, totalDurationMs: rec.totalDuration, totalApiDurationMs: rec.totalAPIDuration };
        } else if (type === 'pr-link' && str(rec.prUrl)) {
          if (!prLinks.has(rec.prUrl as string)) {
            prLinks.set(rec.prUrl as string, { number: rec.prNumber, url: rec.prUrl, repository: rec.prRepository });
            acc.gitOp({ kind: 'pr', prNumber: typeof rec.prNumber === 'number' ? rec.prNumber : undefined, prUrl: rec.prUrl as string, action: 'linked', seq: acc.nextSeq, timestamp });
          }
        }
        if (COLLAPSIBLE.has(type)) {
          const key = type === 'bridge-session' ? String(rec.bridgeSessionId) : JSON.stringify(rec);
          if (lastMeta.get(type) === key) {
            collapsed++;
            continue;
          }
          lastMeta.set(type, key);
        }
        let text: string | undefined;
        if (type === 'custom-title') text = str(rec.customTitle);
        else if (type === 'ai-title') text = str(rec.aiTitle);
        else if (type === 'queue-operation') text = typeof rec.content === 'string' ? rec.content : undefined;
        else if (type === 'pr-link') text = str(rec.prUrl);
        await acc.event({ ...common, kind: 'meta', subtype: type === 'queue-operation' ? `queue:${String(rec.operation)}` : undefined, text });
        continue;
      }

      unknownTypes[type] = (unknownTypes[type] ?? 0) + 1;
      await acc.event({ ...common, kind: 'unknown', text: `Unrecognized record type "${type}" with keys: ${Object.keys(rec).slice(0, 30).join(', ')}` });
    }

    acc.setTodos([...todos.values()]);
    const done = await acc.finish();
    if (!done.lastUserPrompt && lastPrompt && !d.isSubagent) done.lastUserPrompt = clip(redactSecrets(lastPrompt), 4000);
    done.title = customTitle ?? aiTitle ?? summaryTitle ?? (done.firstUserPrompt ? clip(done.firstUserPrompt.split('\n')[0], 90) : undefined);
    done.agentVersion = [...versions].pop();
    if (truncatedTail && done.endStateDetail) done.endStateDetail += ' The final line of the file was cut off mid-write.';
    Object.assign(done.providerMeta, {
      recordTypeCounts: typeCounts,
      unknownRecordTypes: unknownTypes,
      collapsedDuplicateMetaRecords: collapsed,
      versions: [...versions],
      compactions,
      signatureOnlyThinkingBlocks: signatureOnlyThinking,
      pullRequests: [...prLinks.values()],
      titles: { custom: customTitle ?? null, ai: aiTitle ?? null },
      truncatedTail,
      // Same shape as the other adapters; cost comes from Claude Code's own cost records when present.
      usage: usage.requests ? { ...usage, costUsd: (done.providerMeta.cost as { totalCostUSD?: number } | undefined)?.totalCostUSD ?? null } : null,
    });
    return done;
  },
};

/** Claude Code encodes a working directory as a folder name by replacing every non-alphanumeric character with "-". */
export function encodeClaudeProjectDir(p: string): string {
  return p.replace(/[^a-zA-Z0-9]/g, '-');
}

/** Files under a Claude root that should be copied to the archive in addition to transcripts. */
export function claudeArchivableDirs(): string[] {
  return ['projects', 'file-history', 'plans', 'todos', 'paste-cache'];
}

export function isArchivable(file: string): boolean {
  return !isSensitiveFile(file);
}
