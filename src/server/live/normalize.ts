import type { FileOpKind } from '../adapters/types';
import type { LiveRecord } from './store';

type Rec = Record<string, unknown>;

/** One agent-neutral step derived from a live record. */
export type LiveOp =
  | { op: 'prompt'; text: string }
  | { op: 'assistant'; text: string; final: boolean; model?: string }
  | { op: 'thinking'; text: string }
  | { op: 'tool_call'; id?: string; name: string; input?: unknown; command?: string; filePath?: string; fileOp?: FileOpKind }
  | { op: 'tool_result'; id?: string; name?: string; input?: unknown; command?: string; filePath?: string; fileOp?: FileOpKind; output?: unknown; isError: boolean }
  | { op: 'turn_end'; reason?: string; isError?: boolean; interrupted?: boolean }
  | { op: 'error'; text: string }
  | { op: 'usage'; model?: string; inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; costUsd?: number }
  | { op: 'summary'; text: string; title?: string; status?: string; filesChanged?: string[]; nextSteps?: string[] }
  | { op: 'meta'; name: string; text?: string };

export interface NormalizedLive {
  ops: LiveOp[];
  timestamp?: Date;
  cwd?: string;
  model?: string;
  title?: string;
  transcriptPath?: string;
  /** Event name as the agent called it (kept on every event for filtering). */
  event: string;
}

const s = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);
const rec = (v: unknown): Rec | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined);
const num = (v: unknown): number | undefined => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
};
const date = (v: unknown): Date | undefined => {
  if (v == null || v === '') return undefined;
  const n = num(v);
  const d = n != null ? new Date(n > 1e14 ? n / 1e6 : n < 1e11 ? n * 1000 : n) : new Date(String(v));
  return Number.isNaN(d.getTime()) ? undefined : d;
};

const WRITE_TOOLS = /^(write|write_file|write_to_file|create_file|create_new_file|notebookedit)$/i;
const EDIT_TOOLS = /^(edit|multiedit|replace|edit_file|replace_in_file|str_replace|apply_patch|patch|search_replace)$/i;
const READ_TOOLS = /^(read|read_file|read_many_files|view|cat)$/i;
const SHELL_TOOLS = /^(bash|shell|run_shell_command|execute_command|run_terminal_cmd|run_command|exec_command|local_shell|terminal)$/i;

/** File path, file-op kind and shell command from a tool name + input, for any agent. */
export function toolFacts(name: string, input: unknown): { filePath?: string; fileOp?: FileOpKind; command?: string } {
  const i = rec(input) ?? {};
  const filePath = s(i.file_path) ?? s(i.filePath) ?? s(i.absolute_path) ?? s(i.path) ?? s(i.target_file) ?? s(i.notebook_path);
  const short = name.replace(/^mcp__.*__/, '');
  const fileOp: FileOpKind | undefined = WRITE_TOOLS.test(short) ? 'write' : EDIT_TOOLS.test(short) ? 'edit' : READ_TOOLS.test(short) ? 'read' : undefined;
  const command = SHELL_TOOLS.test(short) ? (s(i.command) ?? s(i.cmd) ?? (Array.isArray(i.command) ? i.command.join(' ') : undefined)) : undefined;
  return { filePath: fileOp ? filePath : undefined, fileOp: filePath ? fileOp : undefined, command };
}

function toolError(resp: unknown): boolean {
  const r = rec(resp);
  if (!r) return typeof resp === 'string' && /^error[:\s]/i.test(resp);
  return r.is_error === true || r.isError === true || r.success === false || r.error != null || (num(r.exit_code ?? r.exitCode) ?? 0) !== 0;
}

/** Claude Code, Gemini CLI, Qwen Code, Copilot CLI and other agents that copy Claude Code's hook payloads. */
function pascalHook(p: Rec, ev: string): LiveOp[] {
  const name = s(p.tool_name) ?? 'tool';
  const id = s(p.tool_use_id) ?? s(p.tool_call_id);
  switch (ev) {
    case 'UserPromptSubmit':
    case 'BeforeAgent':
      return s(p.prompt) ? [{ op: 'prompt', text: s(p.prompt)! }] : [];
    case 'PreToolUse':
    case 'BeforeTool':
      return [{ op: 'tool_call', id, name, input: p.tool_input, ...toolFacts(name, p.tool_input) }];
    case 'PostToolUse':
    case 'AfterTool':
    case 'PostToolUseFailure':
      return [{ op: 'tool_result', id, name, input: p.tool_input, ...toolFacts(name, p.tool_input), output: p.tool_response ?? p.tool_output ?? p.error, isError: ev === 'PostToolUseFailure' || toolError(p.tool_response ?? p.tool_output) }];
    case 'Stop':
    case 'SubagentStop':
    case 'AfterAgent': {
      const text = s(p.prompt_response) ?? s(p.last_assistant_message) ?? s(p.response);
      return text ? [{ op: 'assistant', text, final: true }] : [{ op: 'turn_end', reason: ev }];
    }
    case 'Notification':
      return [{ op: 'meta', name: ev, text: s(p.message) ?? s(p.notification_type) }];
    case 'SessionStart':
      return [{ op: 'meta', name: ev, text: s(p.source) }];
    case 'SessionEnd':
      return [{ op: 'meta', name: ev, text: s(p.reason) }];
    default:
      return [{ op: 'meta', name: ev }];
  }
}

/**
 * Kiro CLI agent hooks (experimental): camelCase event names with Claude Code-style fields
 * (prompt, tool_name, tool_input, tool_response), mapped onto the PascalCase handler.
 */
export const KIRO_EVENTS: Record<string, string> = { agentSpawn: 'SessionStart', userPromptSubmit: 'UserPromptSubmit', preToolUse: 'PreToolUse', postToolUse: 'PostToolUse', stop: 'Stop' };

/**
 * GitHub Copilot CLI hooks (experimental): the event name comes from the hook command's argument,
 * the payload is camelCase ({ prompt }, { toolName, toolArgs (JSON text), toolResult: { resultType, textResultForLlm } }).
 */
export function copilotCliHook(p: Rec, ev: string): LiveOp[] {
  const name = s(p.toolName) ?? 'tool';
  let input: unknown = p.toolArgs;
  if (typeof input === 'string') {
    try {
      input = JSON.parse(input);
    } catch {
      /* keep the text */
    }
  }
  switch (ev) {
    case 'userPromptSubmitted':
      return s(p.prompt) ? [{ op: 'prompt', text: s(p.prompt)! }] : [];
    case 'preToolUse':
      return [{ op: 'tool_call', name, input, ...toolFacts(name, input) }];
    case 'postToolUse': {
      const res = rec(p.toolResult) ?? {};
      const kind = s(res.resultType);
      return [{ op: 'tool_result', name, input, ...toolFacts(name, input), output: res.textResultForLlm ?? p.toolResult, isError: kind === 'failure' || kind === 'denied' }];
    }
    case 'errorOccurred': {
      const e = rec(p.error) ?? {};
      return [{ op: 'error', text: `${s(e.name) ?? 'Error'}: ${s(e.message) ?? 'unknown error'}` }];
    }
    case 'sessionStart':
      return [{ op: 'meta', name: ev, text: s(p.initialPrompt) ?? s(p.source) }];
    case 'sessionEnd':
      return [{ op: 'turn_end', reason: s(p.reason) }];
    default:
      return [{ op: 'meta', name: ev }];
  }
}

/** Cursor hooks (camelCase event names). */
function cursorHook(p: Rec, ev: string): LiveOp[] {
  switch (ev) {
    case 'beforeSubmitPrompt':
      return s(p.prompt) ? [{ op: 'prompt', text: s(p.prompt)! }] : [];
    case 'afterAgentResponse':
      return s(p.text) ? [{ op: 'assistant', text: s(p.text)!, final: false }] : [];
    case 'afterAgentThought':
      return s(p.text) ? [{ op: 'thinking', text: s(p.text)! }] : [];
    case 'beforeShellExecution':
      return [{ op: 'tool_call', name: 'shell', command: s(p.command), input: { command: p.command } }];
    case 'afterShellExecution':
      return [{ op: 'tool_result', name: 'shell', command: s(p.command), input: { command: p.command }, output: p.output, isError: (num(p.exit_code) ?? 0) !== 0 }];
    case 'beforeMCPExecution':
      return [{ op: 'tool_call', name: s(p.tool_name) ?? 'mcp', input: p.tool_input }];
    case 'afterMCPExecution':
      return [{ op: 'tool_result', name: s(p.tool_name) ?? 'mcp', input: p.tool_input, output: p.result_json, isError: toolError(p.result_json) }];
    case 'beforeReadFile':
      return [{ op: 'tool_result', name: 'read_file', filePath: s(p.file_path), fileOp: 'read', input: { file_path: p.file_path }, isError: false }];
    case 'afterFileEdit':
      return [{ op: 'tool_result', name: 'edit_file', filePath: s(p.file_path), fileOp: 'edit', input: { file_path: p.file_path, edits: p.edits }, isError: false }];
    case 'stop': {
      const status = s(p.status);
      return [{ op: 'turn_end', reason: status, isError: status === 'error', interrupted: status === 'aborted' }];
    }
    default:
      return [{ op: 'meta', name: ev }];
  }
}

/** Windsurf Cascade hooks (agent_action_name). */
function windsurfHook(p: Rec, ev: string): LiveOp[] {
  const t = rec(p.tool_info) ?? {};
  switch (ev) {
    case 'pre_user_prompt':
      return s(t.user_prompt) ? [{ op: 'prompt', text: s(t.user_prompt)! }] : [];
    case 'post_cascade_response':
      return s(t.response) ? [{ op: 'assistant', text: s(t.response)!, final: true }] : [{ op: 'turn_end' }];
    case 'post_read_code':
      return [{ op: 'tool_result', name: 'read_code', filePath: s(t.file_path), fileOp: 'read', input: t, isError: false }];
    case 'post_write_code':
      return [{ op: 'tool_result', name: 'write_code', filePath: s(t.file_path), fileOp: 'edit', input: t, isError: false }];
    case 'post_run_command':
      return [{ op: 'tool_result', name: 'run_command', command: s(t.command_line), input: t, output: t.output, isError: (num(t.exit_code) ?? 0) !== 0 }];
    case 'post_mcp_tool_use':
      return [{ op: 'tool_result', name: `${s(t.mcp_server_name) ?? 'mcp'}/${s(t.mcp_tool_name) ?? 'tool'}`, input: t.mcp_tool_arguments, output: t.mcp_result, isError: toolError(t.mcp_result) }];
    case 'pre_read_code':
    case 'pre_write_code':
    case 'pre_run_command':
    case 'pre_mcp_tool_use':
      return []; // the post_ event carries everything; pre_ events only matter for blocking
    default:
      return [{ op: 'meta', name: ev }];
  }
}

/** OpenTelemetry log records from Claude Code, Codex and Gemini CLI (already flattened by otlp.ts). */
function otelEvent(p: Rec): { ops: LiveOp[]; ev: string; model?: string } {
  const a = rec(p.attributes) ?? {};
  const full = s(p.name) ?? s(a['event.name']) ?? 'event';
  const ev = full.replace(/^[a-z_]+\./, '');
  const model = s(a.model) ?? s(a['gen_ai.request.model']);
  switch (ev) {
    case 'user_prompt':
      return { ev: full, ops: s(a.prompt) ? [{ op: 'prompt', text: s(a.prompt)! }] : [{ op: 'meta', name: full, text: `Prompt (${num(a.prompt_length) ?? '?'} chars; prompt text logging is off)` }] };
    case 'tool_result':
    case 'tool_call': {
      const name = s(a.tool_name) ?? s(a.function_name) ?? 'tool';
      let input: unknown = a.tool_parameters ?? a.function_args ?? a.arguments;
      if (typeof input === 'string') {
        try {
          input = JSON.parse(input);
        } catch {
          /* keep string */
        }
      }
      const ok = a.success === true || a.success === 'true';
      return { ev: full, ops: [{ op: 'tool_result', name, input, ...toolFacts(name, input), output: a.output ?? a.error, isError: !ok && a.success != null }] };
    }
    case 'api_request':
    case 'api_response':
      return {
        ev: full,
        model,
        ops: [
          {
            op: 'usage',
            model,
            inputTokens: num(a.input_tokens ?? a.input_token_count),
            outputTokens: num(a.output_tokens ?? a.output_token_count),
            cacheReadTokens: num(a.cache_read_tokens ?? a.cached_content_token_count),
            cacheWriteTokens: num(a.cache_creation_tokens),
            costUsd: num(a.cost_usd),
          },
          ...(s(a.response_text) ? [{ op: 'assistant' as const, text: s(a.response_text)!, final: false, model }] : []),
        ],
      };
    case 'api_error':
      return { ev: full, model, ops: [{ op: 'error', text: `${s(a.error) ?? 'API error'}${a.status_code ? ` (HTTP ${String(a.status_code)})` : ''}` }] };
    default:
      return { ev: full, model, ops: [{ op: 'meta', name: full, text: typeof p.body === 'string' ? p.body : undefined }] };
  }
}

/** Generic records posted to /api/ingest/event or logged through the MCP log_event/log_summary tools. */
function genericEvent(p: Rec): LiveOp[] {
  const kind = s(p.kind) ?? s(p.type) ?? 'meta';
  const text = s(p.text) ?? s(p.content) ?? s(p.message) ?? '';
  switch (kind) {
    case 'prompt':
    case 'user':
    case 'user_message':
      return text ? [{ op: 'prompt', text }] : [];
    case 'assistant':
    case 'assistant_message':
    case 'response':
      return text ? [{ op: 'assistant', text, final: p.final !== false, model: s(p.model) }] : [];
    case 'thinking':
      return text ? [{ op: 'thinking', text }] : [];
    case 'tool_call':
    case 'tool':
    case 'tool_result': {
      const name = s(p.tool) ?? s(p.name) ?? 'tool';
      const facts = { ...toolFacts(name, p.input), ...(s(p.command) ? { command: s(p.command) } : {}), ...(s(p.file) ? { filePath: s(p.file), fileOp: (s(p.fileOp) as FileOpKind) ?? 'edit' } : {}) };
      if (kind === 'tool_call') return [{ op: 'tool_call', id: s(p.id), name, input: p.input, ...facts }];
      return [{ op: 'tool_result', id: s(p.id), name, input: p.input, ...facts, output: p.output ?? text, isError: p.isError === true || p.error != null }];
    }
    case 'error':
      return [{ op: 'error', text: text || 'error' }];
    case 'summary':
      return [{ op: 'summary', text, title: s(p.title), status: s(p.status), filesChanged: Array.isArray(p.filesChanged) ? p.filesChanged.map(String) : undefined, nextSteps: Array.isArray(p.nextSteps) ? p.nextSteps.map(String) : undefined }];
    case 'usage':
      return [{ op: 'usage', model: s(p.model), inputTokens: num(p.inputTokens), outputTokens: num(p.outputTokens), costUsd: num(p.costUsd) }];
    case 'end':
    case 'turn_end':
      return [{ op: 'turn_end', reason: text || undefined }];
    default:
      return [{ op: 'meta', name: kind, text: text || undefined }];
  }
}

/** Translates one spool record into agent-neutral steps. Never throws: unknown shapes become meta steps. */
export function normalizeLive(r: LiveRecord): NormalizedLive {
  const p = rec(r.payload) ?? {};
  const base = { timestamp: date(p.timestamp ?? p.time ?? p.timeUnixNano ?? p.ts) ?? date(r.at), cwd: s(p.cwd) ?? (Array.isArray(p.workspace_roots) ? s(p.workspace_roots[0]) : undefined) ?? s(rec(p.tool_info)?.cwd) ?? r.cwd, transcriptPath: s(p.transcript_path) };
  if (r.source === 'otlp') {
    const o = otelEvent(p);
    return { ...base, ops: o.ops, event: o.ev, model: o.model };
  }
  const hookEv = s(p.hook_event_name) ?? s(p.hookEventName) ?? s(r.event);
  if (hookEv) {
    const ops = r.agent === 'copilot-cli' ? copilotCliHook(p, hookEv) : r.agent === 'kiro' ? pascalHook(p, KIRO_EVENTS[hookEv] ?? hookEv) : /^[a-z]/.test(hookEv) ? cursorHook(p, hookEv) : pascalHook(p, hookEv);
    return { ...base, ops, event: hookEv, model: s(p.model) };
  }
  const wsEv = s(p.agent_action_name);
  if (wsEv) return { ...base, ops: windsurfHook(p, wsEv), event: wsEv };
  return { ...base, ops: genericEvent(p), event: s(p.kind) ?? s(p.type) ?? 'event', model: s(p.model), title: s(p.sessionTitle) };
}
