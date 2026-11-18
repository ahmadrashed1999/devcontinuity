import { MAX_EVENT_TEXT } from '../config';
import { redactSecrets } from '../security/redact';

/** Agents with an adapter. `live` imports what agents report themselves (hooks, OpenTelemetry, MCP). */
export type AgentId = 'claude-code' | 'opencode' | 'codex' | 'cursor' | 'cline' | 'copilot' | 'continue' | 'antigravity' | 'aider' | 'zed' | 'chatgpt' | 'claude-ai' | 'live' | 'generic';

export type EventKind =
  | 'user_message'
  | 'assistant_message'
  | 'thinking'
  | 'tool_call'
  | 'tool_result'
  | 'system'
  | 'summary'
  | 'error'
  | 'attachment'
  | 'file_snapshot'
  | 'meta'
  | 'unknown';

export type EndState =
  | 'completed_turn'
  | 'interrupted_tool'
  | 'interrupted_response'
  | 'awaiting_assistant'
  | 'api_error'
  | 'empty'
  | 'unknown';

/** One unit of the unified internal session representation. Provider-specific detail goes in `meta`. */
export interface NormalizedEvent {
  seq: number;
  lineNo?: number;
  blockIndex?: number;
  kind: EventKind;
  role?: string;
  rawType?: string;
  subtype?: string;
  timestamp?: Date;
  uuid?: string;
  parentUuid?: string;
  text?: string;
  truncated?: boolean;
  toolName?: string;
  toolUseId?: string;
  isError?: boolean;
  isSidechain?: boolean;
  isMeta?: boolean;
  model?: string;
  filePath?: string;
  command?: string;
  rawOffset?: number;
  rawLength?: number;
  meta?: Record<string, unknown>;
}

export type FileOpKind = 'read' | 'write' | 'edit' | 'notebook_edit' | 'delete' | 'snapshot';

export interface NormalizedFileOp {
  eventSeq: number;
  path: string;
  op: FileOpKind;
  toolName?: string;
  toolUseId?: string;
  timestamp?: Date;
  /** undefined = no tool result recorded, outcome unknown. */
  succeeded?: boolean;
  linesAdded?: number;
  linesRemoved?: number;
}

export interface NormalizedTodo {
  key: string;
  content: string;
  /** Status exactly as the agent reported it. */
  status: string;
  priority?: string;
}

export interface GitOpRecord {
  kind: 'commit' | 'push' | 'pr' | 'branch';
  sha?: string;
  branch?: string;
  prNumber?: number;
  prUrl?: string;
  action?: string;
  seq: number;
  timestamp?: Date;
}

export interface PromptRecord {
  seq: number;
  key: string;
  text: string;
  timestamp?: Date;
  /** The assistant finished a turn (final text) after this prompt. Says nothing about whether the work is correct. */
  answered: boolean;
  finalResponse?: string;
  finalSeq?: number;
  filesModified: string[];
  commits: string[];
  toolErrors: number;
}

export interface NormalizedSession {
  agent: AgentId;
  externalId: string;
  title?: string;
  cwd?: string;
  gitBranch?: string;
  startedAt?: Date;
  endedAt?: Date;
  models: string[];
  primaryModel?: string;
  agentVersion?: string;
  isSubagent: boolean;
  parentExternalId?: string;
  subagentId?: string;
  endState: EndState;
  endStateDetail?: string;
  eventCount: number;
  userMessageCount: number;
  assistantMessageCount: number;
  toolCallCount: number;
  toolErrorCount: number;
  fileOpCount: number;
  commandCount: number;
  malformedLines: number;
  unknownRecordCount: number;
  firstUserPrompt?: string;
  lastUserPrompt?: string;
  lastAssistantText?: string;
  prompts: PromptRecord[];
  todos: NormalizedTodo[];
  gitOps: GitOpRecord[];
  plans: { text: string; seq: number; timestamp?: Date }[];
  providerMeta: Record<string, unknown>;
}

export interface SessionSink {
  events(batch: NormalizedEvent[]): Promise<void>;
  fileOps(batch: NormalizedFileOp[]): Promise<void>;
}

export interface DiscoveredSession {
  agent: AgentId;
  externalId: string;
  /** Original location. Read once to create the safe copy and never written to. */
  sourcePath: string;
  /** Stable unique key for re-import detection. */
  sourceKey: string;
  size: number;
  mtime: Date;
  /** Path relative to the agent root, used to lay out the archive. */
  relPath: string;
  projectHint?: string;
  isSubagent?: boolean;
  parentExternalId?: string;
  subagentId?: string;
  /** The agent that produced this session when it differs from the adapter id (live capture, Cline forks). Stored as Session.agent. */
  reportedAgent?: string;
  /** Extra original files that belong to this session. Safe-copied next to the main archive copy, never parsed in place. */
  companions?: string[];
  extra?: Record<string, unknown>;
}

export interface AssetGroup {
  kind: string;
  label: string;
  count: number;
  bytes: number;
  /** Directory (relative to the root) that is copied into the archive, when applicable. */
  relDir?: string;
  archived: boolean;
  note?: string;
}

export interface AgentInventory {
  agent: AgentId;
  label: string;
  root: string;
  exists: boolean;
  sessions: DiscoveredSession[];
  projectDirs: { name: string; sessions: number; subagents: number; bytes: number; lastWrite?: Date }[];
  assets: AssetGroup[];
  notes: string[];
  /** Things that cannot be recovered from this machine, stated plainly. */
  unrecoverable: string[];
  errors: string[];
}

export interface ParseContext {
  /** The safe copy to read from. Adapters never parse the original. */
  archivePath: string;
  /**
   * For sources that are not line-oriented (SQLite databases, JSON documents): append one original
   * record to a normalized JSONL in the archive and get back its byte range for raw lookups.
   */
  writeRaw?: (record: unknown) => { offset: number; length: number };
  /** Archive copies of DiscoveredSession.companions, same order. Missing entries were not copied (sensitive or unreadable). */
  companions?: (string | undefined)[];
}

export interface AgentCapabilities {
  toolCalls: boolean;
  toolResults: boolean;
  thinking: boolean;
  subagents: boolean;
  fileSnapshots: boolean;
  todos: boolean;
  gitMetadata: boolean;
  /** How confident we are in this adapter on this machine. */
  maturity: 'verified' | 'tested-with-fixtures' | 'experimental';
  notes: string;
}

export interface AgentAdapter {
  id: AgentId;
  label: string;
  capabilities: AgentCapabilities;
  defaultRoots(): string[];
  scan(root: string): Promise<AgentInventory>;
  parse(session: DiscoveredSession, sink: SessionSink, ctx: ParseContext): Promise<NormalizedSession>;
}

export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function toDate(v: unknown): Date | undefined {
  if (v == null) return undefined;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? undefined : v;
  if (typeof v === 'number') {
    const ms = v < 1e11 ? v * 1000 : v;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
  if (typeof v === 'string' && v) {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
  return undefined;
}

export function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

export function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** Compact, bounded JSON rendering for tool inputs and unknown payloads. */
export function compactJson(v: unknown, max = 4000): string {
  let s: string;
  try {
    s = typeof v === 'string' ? v : JSON.stringify(v);
  } catch {
    s = String(v);
  }
  return clip(s ?? '', max);
}

const TRIVIAL_PROMPT = /^(?:y|yes|yep|ok|okay|no|continue|go on|go ahead|proceed|do it|thanks?|thank you|next|retry|again|نعم|لا|كمل|استمر|تمام|اكمل)[.!\s]*$/i;

export function isTrivialPrompt(text: string): boolean {
  const t = text.trim();
  return t.length < 12 || TRIVIAL_PROMPT.test(t);
}

type ConvState = 'none' | 'human' | 'tool_result' | 'assistant_final' | 'assistant_final_tool' | 'assistant_text_unknown' | 'assistant_partial' | 'tool_call' | 'error' | 'interrupted';

const BATCH = 250;
const INT32_MAX = 2_147_483_647;

/**
 * Shared bookkeeping for every adapter: sequencing, redaction, clipping, counters, prompt/turn
 * tracking, tool call ↔ result pairing and end-state detection. Adapters translate provider
 * records into calls on this class, so all agents produce the same unified representation.
 */
export class SessionAccumulator {
  private seq = 0;
  private buffer: NormalizedEvent[] = [];
  private fileOpList: NormalizedFileOp[] = [];
  private pendingTools = new Map<string, { name?: string; fileOpIdx?: number; mutates?: boolean; path?: string }>();
  private modelTally = new Map<string, number>();
  private cwdTally = new Map<string, number>();
  private conv: ConvState = 'none';
  private lastError?: string;
  private endingTool?: string;
  private current?: PromptRecord;
  private s: NormalizedSession;

  constructor(
    private sink: SessionSink,
    base: Pick<NormalizedSession, 'agent' | 'externalId'> & Partial<NormalizedSession>,
  ) {
    this.s = {
      models: [],
      isSubagent: false,
      endState: 'unknown',
      eventCount: 0,
      userMessageCount: 0,
      assistantMessageCount: 0,
      toolCallCount: 0,
      toolErrorCount: 0,
      fileOpCount: 0,
      commandCount: 0,
      malformedLines: 0,
      unknownRecordCount: 0,
      prompts: [],
      todos: [],
      gitOps: [],
      plans: [],
      providerMeta: {},
      ...base,
    };
  }

  get session(): NormalizedSession {
    return this.s;
  }

  get nextSeq(): number {
    return this.seq;
  }

  noteCwd(cwd?: string) {
    if (cwd) this.cwdTally.set(cwd, (this.cwdTally.get(cwd) ?? 0) + 1);
  }

  noteModel(model?: string) {
    if (model && !model.startsWith('<')) this.modelTally.set(model, (this.modelTally.get(model) ?? 0) + 1);
  }

  noteTime(ts?: Date) {
    if (!ts) return;
    if (!this.s.startedAt || ts < this.s.startedAt) this.s.startedAt = ts;
    if (!this.s.endedAt || ts > this.s.endedAt) this.s.endedAt = ts;
  }

  malformed(lineNo: number, error: string, preview: string | undefined, raw: { offset: number; length: number }) {
    this.s.malformedLines++;
    return this.event({ kind: 'unknown', rawType: '<malformed>', subtype: 'malformed', lineNo, text: `${error}${preview ? `\n${preview}` : ''}`, isError: true, rawOffset: raw.offset, rawLength: raw.length });
  }

  /** Records an event. Text is redacted and clipped here, once, for every adapter. */
  async event(e: Omit<NormalizedEvent, 'seq'>): Promise<number> {
    const seq = this.seq++;
    const ev: NormalizedEvent = { ...e, seq };
    if (ev.text != null) {
      const original = ev.text;
      const red = redactSecrets(original.length > MAX_EVENT_TEXT + 500 ? original.slice(0, MAX_EVENT_TEXT + 500) : original);
      if (red.length > MAX_EVENT_TEXT || original.length > MAX_EVENT_TEXT + 500) {
        ev.text = red.slice(0, MAX_EVENT_TEXT);
        ev.truncated = true;
      } else {
        ev.text = red;
      }
      if (!ev.text) ev.text = undefined;
    }
    if (ev.command) ev.command = clip(redactSecrets(ev.command), 4000);
    if (ev.rawOffset != null && ev.rawOffset > INT32_MAX) {
      ev.rawOffset = undefined;
      ev.rawLength = undefined;
    }
    this.noteTime(ev.timestamp);
    this.s.eventCount++;
    if (ev.kind === 'unknown' && ev.subtype !== 'malformed') this.s.unknownRecordCount++;
    this.buffer.push(ev);
    if (this.buffer.length >= BATCH) await this.flush();
    return seq;
  }

  /** A real prompt typed by the human (not tool results, hooks, or injected context). */
  humanPrompt(seq: number, text: string, timestamp?: Date, key?: string) {
    this.closePrompt();
    this.s.userMessageCount++;
    const clean = clip(redactSecrets(text.trim()), 4000);
    if (!this.s.firstUserPrompt) this.s.firstUserPrompt = clean;
    this.s.lastUserPrompt = clean;
    this.current = { seq, key: key ?? String(seq), text: clean, timestamp, answered: false, filesModified: [], commits: [], toolErrors: 0 };
    this.s.prompts.push(this.current);
    this.conv = 'human';
  }

  /** Non-human user-role content (injected context, notifications). Counts as conversation but not as a prompt. */
  injectedUser() {
    if (this.conv === 'none') this.conv = 'human';
  }

  assistantText(seq: number, text: string, finality: 'final' | 'interim' | 'unknown') {
    this.s.assistantMessageCount++;
    const clean = clip(redactSecrets(text.trim()), 6000);
    if (clean) this.s.lastAssistantText = clean;
    if (finality === 'final') {
      this.conv = 'assistant_final';
      if (this.current) {
        this.current.answered = true;
        this.current.finalResponse = clip(clean, 1200);
        this.current.finalSeq = seq;
      }
    } else {
      this.conv = finality === 'unknown' ? 'assistant_text_unknown' : 'assistant_partial';
      if (this.current) {
        this.current.finalResponse = clip(clean, 1200);
        this.current.finalSeq = seq;
      }
    }
  }

  assistantPartial() {
    if (this.conv !== 'tool_call') this.conv = 'assistant_partial';
  }

  toolCall(seq: number, id: string | undefined, name: string | undefined, info: { filePath?: string; op?: FileOpKind; command?: string; timestamp?: Date } = {}) {
    this.s.toolCallCount++;
    if (info.command) this.s.commandCount++;
    let fileOpIdx: number | undefined;
    if (info.filePath && info.op) {
      fileOpIdx = this.fileOpList.length;
      this.fileOpList.push({ eventSeq: seq, path: info.filePath, op: info.op, toolName: name, toolUseId: id, timestamp: info.timestamp });
      this.s.fileOpCount++;
    }
    if (id) this.pendingTools.set(id, { name, fileOpIdx, mutates: !!info.op && info.op !== 'read', path: info.filePath });
    this.conv = 'tool_call';
  }

  toolResult(id: string | undefined, isError: boolean, extra: { linesAdded?: number; linesRemoved?: number } = {}) {
    if (isError) {
      this.s.toolErrorCount++;
      if (this.current) this.current.toolErrors++;
    }
    const pending = id ? this.pendingTools.get(id) : undefined;
    if (pending && id) {
      this.pendingTools.delete(id);
      if (pending.fileOpIdx != null) {
        const op = this.fileOpList[pending.fileOpIdx];
        op.succeeded = !isError;
        if (extra.linesAdded != null) op.linesAdded = extra.linesAdded;
        if (extra.linesRemoved != null) op.linesRemoved = extra.linesRemoved;
        if (!isError && pending.mutates && pending.path && this.current && !this.current.filesModified.includes(pending.path) && this.current.filesModified.length < 60) {
          this.current.filesModified.push(pending.path);
        }
      }
    }
    this.conv = 'tool_result';
  }

  /** The user explicitly stopped the assistant mid-turn. */
  userInterrupt() {
    this.conv = 'interrupted';
  }

  /** Some tools end the turn themselves (a subagent handing its result back, for example). That is a normal turn end. */
  turnEndedByTool(toolName?: string) {
    this.conv = 'assistant_final_tool';
    this.endingTool = toolName;
    if (this.current) this.current.answered = true;
  }

  extraFileOp(op: NormalizedFileOp) {
    this.fileOpList.push(op);
    this.s.fileOpCount++;
  }

  gitOp(op: GitOpRecord) {
    this.s.gitOps.push(op);
    if (op.kind === 'commit' && op.sha && this.current) this.current.commits.push(op.sha);
  }

  apiError(detail: string) {
    this.lastError = clip(redactSecrets(detail), 500);
    this.conv = 'error';
  }

  setTodos(todos: NormalizedTodo[]) {
    this.s.todos = todos;
  }

  private closePrompt() {
    if (this.current && !this.current.answered && this.conv === 'assistant_text_unknown') this.current.answered = true;
  }

  private async flush() {
    if (this.buffer.length === 0) return;
    const batch = this.buffer;
    this.buffer = [];
    await this.sink.events(batch);
  }

  async finish(): Promise<NormalizedSession> {
    this.closePrompt();
    await this.flush();
    for (let i = 0; i < this.fileOpList.length; i += 500) await this.sink.fileOps(this.fileOpList.slice(i, i + 500));

    const s = this.s;
    const models = [...this.modelTally.entries()].sort((a, b) => b[1] - a[1]);
    s.models = models.map(([m]) => m);
    s.primaryModel = s.primaryModel ?? models[0]?.[0];
    if (!s.cwd) s.cwd = [...this.cwdTally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];

    const pending = [...this.pendingTools.values()].map((p) => p.name).filter(Boolean);
    if (s.userMessageCount + s.assistantMessageCount + s.toolCallCount === 0) {
      s.endState = 'empty';
      s.endStateDetail = 'No conversation records were found in this source.';
    } else if (this.conv === 'error') {
      s.endState = 'api_error';
      s.endStateDetail = this.lastError;
    } else if (this.conv === 'tool_call') {
      s.endState = 'interrupted_tool';
      s.endStateDetail = `The transcript ends after a tool call with no recorded result${pending.length ? ` (${[...new Set(pending)].slice(0, 5).join(', ')})` : ''}.`;
    } else if (this.conv === 'assistant_final') {
      s.endState = 'completed_turn';
      s.endStateDetail = 'The last assistant turn ended normally. This does not verify that the work itself is correct.';
    } else if (this.conv === 'assistant_final_tool') {
      s.endState = 'completed_turn';
      s.endStateDetail = `The last turn ended through a turn-ending tool${this.endingTool ? ` (${this.endingTool})` : ''}. This does not verify that the work itself is correct.`;
    } else if (this.conv === 'interrupted') {
      s.endState = 'interrupted_response';
      s.endStateDetail = 'The user interrupted the assistant before it finished.';
    } else if (this.conv === 'assistant_text_unknown') {
      s.endState = 'completed_turn';
      s.endStateDetail = 'The transcript ends with assistant text; no stop reason was recorded, so a normal turn end is inferred.';
    } else if (this.conv === 'human' || this.conv === 'tool_result') {
      s.endState = 'awaiting_assistant';
      s.endStateDetail = this.conv === 'human' ? 'The last user message has no recorded assistant response.' : 'The transcript ends after a tool result; the assistant never continued.';
    } else if (this.conv === 'assistant_partial') {
      s.endState = 'interrupted_response';
      s.endStateDetail = 'The transcript ends in the middle of an assistant turn.';
    }
    return s;
  }
}
