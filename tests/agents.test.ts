import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { antigravityAdapter, splitSteps, agyDate } from '../src/server/adapters/antigravity';
import { clineAdapter, clineHumanText } from '../src/server/adapters/cline';
import { continueAdapter } from '../src/server/adapters/continue';
import { copilotAdapter, replayChatSession } from '../src/server/adapters/copilot';
import { fileUriToPath } from '../src/server/adapters/editors';
import { liveAdapter } from '../src/server/adapters/live';
import { disposeWorkingCopies } from '../src/server/adapters/sqlite-util';
import type { DiscoveredSession, NormalizedEvent, NormalizedFileOp, SessionSink } from '../src/server/adapters/types';
import { normalizeLive } from '../src/server/live/normalize';
import { ingestOtlpLogs } from '../src/server/live/otlp';
import { liveDir, type LiveRecord } from '../src/server/live/store';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-agents-'));
afterAll(() => {
  disposeWorkingCopies();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function write(rel: string, content: string | Buffer): string {
  const p = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

function memorySink() {
  const events: NormalizedEvent[] = [];
  const fileOps: NormalizedFileOp[] = [];
  const sink: SessionSink = { events: async (b) => void events.push(...b), fileOps: async (b) => void fileOps.push(...b) };
  return { sink, events, fileOps };
}

const rec = (payload: unknown, source: LiveRecord['source'] = 'hook', agent = 'gemini-cli'): LiveRecord => ({ v: 1, at: '2026-11-18T10:00:00.000Z', source, agent, session: 's1', payload });

describe('editor helpers', () => {
  it('turns file URIs into local paths', () => {
    if (process.platform === 'win32') expect(fileUriToPath('file:///c%3A/work/my%20app')).toBe('c:\\work\\my app');
    else expect(fileUriToPath('file:///home/me/app')).toBe('/home/me/app');
    expect(fileUriToPath('vscode-remote://x')).toBeUndefined();
  });
});

describe('Cline adapter', () => {
  it('reads a task: human prompts, tools, file ops, completion and usage', async () => {
    const root = path.join(tmp, 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev');
    const dir = path.join(root, 'tasks', '1700000000000');
    const cwd = path.join(tmp, 'proj');
    write(path.relative(tmp, path.join(dir, 'api_conversation_history.json')), JSON.stringify([
      { role: 'user', ts: 1700000000100, content: [{ type: 'text', text: '<task>\nFix the login bug\n</task>' }, { type: 'text', text: '\n# task_progress RECOMMENDED\nuse a list' }, { type: 'text', text: '<environment_details>\n# Open Tabs\nx\n</environment_details>' }] },
      { role: 'assistant', ts: 1700000000200, modelInfo: { modelId: 'gemini-3.1-pro' }, metrics: { tokens: { prompt: 100, completion: 10 }, cost: 0.5 }, content: [{ type: 'text', text: 'Looking at auth.' }, { type: 'tool_use', id: 't1', name: 'replace_in_file', input: { path: 'src/auth.ts', diff: '...', task_progress: '- [x] Find bug\n- [ ] Fix bug' } }] },
      { role: 'user', ts: 1700000000300, content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'ok' }] }, { type: 'text', text: '<environment_details>x</environment_details>' }] },
      { role: 'assistant', ts: 1700000000400, content: [{ type: 'tool_use', id: 't2', name: 'attempt_completion', input: { result: 'Fixed the login bug.' } }] },
      { role: 'user', ts: 1700000000500, content: [{ type: 'text', text: '<feedback>\nstill broken on mobile\n</feedback>' }] },
    ]));
    write(path.relative(tmp, path.join(dir, 'ui_messages.json')), JSON.stringify([{ ts: 1700000000600, type: 'ask', ask: 'api_req_failed', text: 'Rate limit exceeded' }]));
    write(path.relative(tmp, path.join(root, 'state', 'taskHistory.json')), JSON.stringify([{ id: '1700000000000', task: 'Fix the login bug', cwdOnTaskInitialization: cwd, totalCost: 1.25, tokensIn: 900, tokensOut: 90 }]));

    const inv = await clineAdapter.scan(root);
    expect(inv.sessions).toHaveLength(1);
    const d = inv.sessions[0];
    expect(d.reportedAgent).toBe('cline');
    expect(d.companions?.map((c) => path.basename(c))).toEqual(['ui_messages.json']);
    const { sink, events, fileOps } = memorySink();
    const s = await clineAdapter.parse(d, sink, { archivePath: d.sourcePath, companions: d.companions });
    expect(s.prompts.map((p) => p.text)).toEqual(['Fix the login bug', 'still broken on mobile']);
    expect(s.prompts[0].answered).toBe(true);
    expect(s.prompts[0].finalResponse).toBe('Fixed the login bug.');
    expect(fileOps[0]).toMatchObject({ path: path.join(cwd, 'src/auth.ts'), op: 'edit', succeeded: true });
    expect(s.todos).toEqual([{ key: 'Find bug', content: 'Find bug', status: 'completed' }, { key: 'Fix bug', content: 'Fix bug', status: 'pending' }]);
    expect(s.endState).toBe('api_error');
    expect(s.primaryModel).toBe('gemini-3.1-pro');
    expect((s.providerMeta.usage as { costUsd: number }).costUsd).toBe(1.25);
    expect(events.some((e) => e.text?.includes('environment_details'))).toBe(false);
  });

  it('extracts what the human typed from Cline wrappers', () => {
    expect(clineHumanText('<task>hi there</task>\n<environment_details>x</environment_details>').human).toBe('hi there');
    expect(clineHumanText('[read_file] Result: abc').human).toBeUndefined();
  });
});

describe('Copilot Chat adapter', () => {
  it('replays the mutation log (set, append with truncate, delete)', () => {
    const log = [
      { kind: 0, v: { requests: [], customTitle: 'x' } },
      { kind: 2, k: ['requests'], v: [{ requestId: 'r1', response: [] }] },
      { kind: 2, k: ['requests', 0, 'response'], v: [{ value: 'a' }, { value: 'b' }] },
      { kind: 2, k: ['requests', 0, 'response'], v: [{ value: 'B' }], i: 1 },
      { kind: 1, k: ['requests', 0, 'result'], v: { ok: 1 } },
      { kind: 3, k: ['customTitle'] },
    ].map((l) => JSON.stringify(l)).join('\n');
    const { state, errors } = replayChatSession(log);
    expect(errors).toEqual([]);
    expect(state).toEqual({ requests: [{ requestId: 'r1', response: [{ value: 'a' }, { value: 'B' }], result: { ok: 1 } }] });
  });

  it('maps requests, tool invocations, edits and errors', async () => {
    const proj = 'file:///c%3A/work/site';
    const file = write('ws/abc/chatSessions/s1.jsonl', [
      { kind: 0, v: { version: 3, creationDate: 1776355794505, customTitle: 'Dashboard', sessionId: 's1', requests: [] } },
      { kind: 2, k: ['requests'], v: [{ requestId: 'r1', timestamp: 1776355832557, message: { text: 'make the dashboard' }, agent: { name: 'agent' }, response: [
        { value: 'Reading ' },
        { kind: 'toolInvocationSerialized', toolId: 'copilot_readFile', toolCallId: 'c1', isComplete: true, invocationMessage: { value: 'Reading [](x)', uris: { [`${proj}/index.html`]: {} } }, pastTenseMessage: { value: 'Read index.html' } },
        { kind: 'textEditGroup', uri: { fsPath: 'c:\\work\\site\\index.html' }, edits: [[{ text: 'a\nb' }]] },
        { value: 'Done.' },
      ], result: { metadata: { resolvedModel: 'claude-haiku-4-5', promptTokens: 1000, outputTokens: 50 } }, modelState: { value: 1 } }] },
      { kind: 2, k: ['requests'], v: [{ requestId: 'r2', timestamp: 1776355900000, message: { text: 'now deploy it' }, response: [], result: { errorDetails: { message: 'Rate limited' } } }] },
    ].map((l) => JSON.stringify(l)).join('\n'));
    write('ws/abc/workspace.json', JSON.stringify({ folder: proj }));
    const inv = await copilotAdapter.scan(path.join(tmp, 'ws'));
    expect(inv.sessions).toHaveLength(1);
    const { sink, events, fileOps } = memorySink();
    const s = await copilotAdapter.parse(inv.sessions[0], sink, { archivePath: file });
    expect(s.title).toBe('Dashboard');
    expect(s.prompts.map((p) => p.text)).toEqual(['make the dashboard', 'now deploy it']);
    expect(s.prompts[0].answered).toBe(true);
    expect(s.toolCallCount).toBe(1);
    expect(fileOps.map((f) => f.op).sort()).toEqual(['edit', 'read']);
    expect(s.endState).toBe('api_error');
    expect(events.find((e) => e.kind === 'tool_result')?.text).toBe('Read index.html');
    if (process.platform === 'win32') expect(s.cwd).toBe('c:\\work\\site');
  });
});

describe('Continue adapter', () => {
  it('reads messages, tool calls and results', async () => {
    const file = write('continue/sessions/abc.json', JSON.stringify({
      sessionId: 'abc', title: 'New Session', workspaceDirectory: 'file:///c%3A/work/app', chatModelTitle: 'Qwen',
      history: [
        { message: { role: 'user', content: [{ type: 'text', text: 'rename the util' }], id: 'u1' } },
        { message: { role: 'assistant', content: '', toolCalls: [{ id: 'k1', function: { name: 'edit_existing_file', arguments: '{"filepath":"src/util.ts","changes":"x"}' } }] }, promptLogs: [{ modelTitle: 'Qwen 2.5' }] },
        { message: { role: 'tool', content: 'File edited', toolCallId: 'k1' } },
        { message: { role: 'assistant', content: 'Renamed it.' } },
      ],
    }));
    const { sink, fileOps } = memorySink();
    const d: DiscoveredSession = { agent: 'continue', externalId: 'abc', sourcePath: file, sourceKey: 'continue:x', size: 1, mtime: new Date(), relPath: 'abc.json' };
    const s = await continueAdapter.parse(d, sink, { archivePath: file });
    expect(s.title).toBe('rename the util');
    expect(s.toolCallCount).toBe(1);
    expect(fileOps[0]).toMatchObject({ path: 'src/util.ts', op: 'edit', succeeded: true });
    expect(s.endState).toBe('completed_turn');
    expect(s.primaryModel).toBe('Qwen 2.5');
  });
});

describe('Antigravity adapter', () => {
  it('rebuilds step order from the search index and keeps brain plans', async () => {
    const root = path.join(tmp, 'agy');
    fs.mkdirSync(path.join(root, 'brain', 'c1'), { recursive: true });
    fs.writeFileSync(path.join(root, 'brain', 'c1', 'implementation_plan.md'), '# Plan\n- step one');
    const db = new DatabaseSync(path.join(root, 'conversation_summaries.db'));
    db.exec('CREATE TABLE conversation_summaries (conversation_id text PRIMARY KEY, title text, preview text, step_count integer, last_modified_time datetime, workspace_uris text, status text, parent_conversation_id text, agent_name text, killed numeric, project_id text)');
    db.exec('CREATE TABLE conversations_fts_content (id INTEGER PRIMARY KEY, c0, c1, c2, c3, c4, c5, c6, c7, c8, c9, c10, c11, c12, c13, c14)');
    const ins = db.prepare('INSERT INTO conversation_summaries VALUES (?,?,?,?,?,?,?,?,?,?,?)');
    ins.run('c1', 'Video Studio', '', 4, '2026-11-15 22:53:20.6088136+00:00', '["file:///c%3A/work/vreel"]', 'CASCADE_RUN_STATUS_IDLE', '', '', 0, 'p');
    ins.run('c2', '', '', 1, '2026-11-15 20:09:40.1+00:00', '["file:///c%3A/work/vreel"]', 'CASCADE_RUN_STATUS_IDLE', 'c1', 'builder', 0, 'p');
    const user = 'Build the app\nAnd test it';
    const agent = 'Starting.Done building.';
    const off = (pairs: [number, number][]) => Buffer.from(JSON.stringify(pairs));
    db.prepare('INSERT INTO conversations_fts_content (c0,c1,c2,c3,c8,c9,c13,c14) VALUES (?,?,?,?,?,?,?,?)').run('c1', 0, 0, 3, off([[0, 0], [2, 14]]), off([[1, 0], [3, 9]]), user, agent);
    db.close();

    const inv = await antigravityAdapter.scan(root);
    expect(inv.sessions.map((s) => s.externalId).sort()).toEqual(['c1', 'c2']);
    const main = inv.sessions.find((s) => s.externalId === 'c1')!;
    const sub = inv.sessions.find((s) => s.externalId === 'c2')!;
    expect(sub).toMatchObject({ isSubagent: true, parentExternalId: 'c1', subagentId: 'builder' });
    const { sink, events } = memorySink();
    const s = await antigravityAdapter.parse(main, sink, { archivePath: main.sourcePath, companions: main.companions });
    expect(events.filter((e) => e.kind === 'user_message' || e.kind === 'assistant_message').map((e) => e.text)).toEqual(['Build the app', 'Starting.', 'And test it', 'Done building.']);
    expect(s.title).toBe('Video Studio');
    expect(s.plans[0].text).toContain('step one');
    expect(s.endState).toBe('completed_turn');
    expect(s.endedAt?.toISOString()).toBe('2026-11-15T22:53:20.608Z');
  });

  it('parses Go timestamps and treats the zero time as unknown', () => {
    expect(agyDate('0001-01-01 00:00:00+00:00')).toBeUndefined();
    expect(splitSteps('abc', Buffer.from('not json'))).toEqual([{ step: -1, text: 'abc' }]);
  });
});

describe('live capture: normalizing every agent dialect', () => {
  it('Claude Code / Gemini CLI style hooks', () => {
    expect(normalizeLive(rec({ hook_event_name: 'BeforeAgent', prompt: 'add tests', cwd: '/w' })).ops).toEqual([{ op: 'prompt', text: 'add tests' }]);
    const pre = normalizeLive(rec({ hook_event_name: 'BeforeTool', tool_name: 'write_file', tool_input: { file_path: '/w/a.ts', content: 'x' } })).ops[0];
    expect(pre).toMatchObject({ op: 'tool_call', name: 'write_file', filePath: '/w/a.ts', fileOp: 'write' });
    const post = normalizeLive(rec({ hook_event_name: 'PostToolUse', tool_use_id: 't9', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: { exit_code: 1 } })).ops[0];
    expect(post).toMatchObject({ op: 'tool_result', id: 't9', command: 'npm test', isError: true });
    expect(normalizeLive(rec({ hook_event_name: 'AfterAgent', prompt_response: 'All done' })).ops).toEqual([{ op: 'assistant', text: 'All done', final: true }]);
  });

  it('Cursor hooks', () => {
    expect(normalizeLive(rec({ hook_event_name: 'beforeSubmitPrompt', prompt: 'hi', conversation_id: 'c', workspace_roots: ['/r'] }, 'hook', 'cursor'))).toMatchObject({ cwd: '/r', ops: [{ op: 'prompt', text: 'hi' }] });
    expect(normalizeLive(rec({ hook_event_name: 'afterFileEdit', file_path: '/r/x.ts', edits: [] }, 'hook', 'cursor')).ops[0]).toMatchObject({ op: 'tool_result', fileOp: 'edit', filePath: '/r/x.ts' });
    expect(normalizeLive(rec({ hook_event_name: 'stop', status: 'aborted' }, 'hook', 'cursor')).ops[0]).toMatchObject({ op: 'turn_end', interrupted: true });
  });

  it('Windsurf hooks', () => {
    expect(normalizeLive(rec({ agent_action_name: 'pre_user_prompt', trajectory_id: 't', tool_info: { user_prompt: 'go' } }, 'hook', 'windsurf')).ops).toEqual([{ op: 'prompt', text: 'go' }]);
    expect(normalizeLive(rec({ agent_action_name: 'post_run_command', tool_info: { command_line: 'ls', cwd: '/p' } }, 'hook', 'windsurf'))).toMatchObject({ cwd: '/p', ops: [{ op: 'tool_result', command: 'ls', isError: false }] });
    expect(normalizeLive(rec({ agent_action_name: 'pre_write_code', tool_info: {} }, 'hook', 'windsurf')).ops).toEqual([]);
  });

  it('OpenTelemetry events', () => {
    const usage = normalizeLive(rec({ name: 'claude_code.api_request', time: 1.7e18, attributes: { model: 'claude-x', input_tokens: 10, output_tokens: 5, cost_usd: 0.01 } }, 'otlp', 'claude-code'));
    expect(usage.ops[0]).toMatchObject({ op: 'usage', model: 'claude-x', inputTokens: 10, outputTokens: 5, costUsd: 0.01 });
    expect(usage.timestamp?.getUTCFullYear()).toBe(2023);
    const tool = normalizeLive(rec({ name: 'gemini_cli.tool_call', attributes: { function_name: 'run_shell_command', function_args: '{"command":"ls"}', success: false } }, 'otlp'));
    expect(tool.ops[0]).toMatchObject({ op: 'tool_result', command: 'ls', isError: true });
  });

  it('turns a mixed stream into one session, pairing tools without ids', async () => {
    const lines: LiveRecord[] = [
      rec({ hook_event_name: 'SessionStart', source: 'startup', cwd: '/w' }),
      rec({ hook_event_name: 'BeforeAgent', prompt: 'create a.ts', cwd: '/w' }),
      rec({ hook_event_name: 'BeforeTool', tool_name: 'write_file', tool_input: { file_path: '/w/a.ts' } }),
      rec({ hook_event_name: 'AfterTool', tool_name: 'write_file', tool_input: { file_path: '/w/a.ts' }, tool_response: { llmContent: 'ok' } }),
      rec({ name: 'gemini_cli.api_response', attributes: { model: 'gemini-3-pro', input_token_count: 50, output_token_count: 7 } }, 'otlp'),
      rec({ hook_event_name: 'AfterAgent', prompt_response: 'Created a.ts' }),
      rec({ kind: 'summary', title: 'Create a.ts', text: 'Added the file', status: 'done', filesChanged: ['/w/a.ts'] }, 'mcp'),
    ];
    const file = write('live/gemini-cli/s1.jsonl', `${lines.map((l) => JSON.stringify(l)).join('\n')}\n{"broken`);
    const { sink, events, fileOps } = memorySink();
    const d: DiscoveredSession = { agent: 'live', reportedAgent: 'gemini-cli', externalId: 's1', sourcePath: file, sourceKey: 'live:x', size: 1, mtime: new Date(), relPath: 'x' };
    const s = await liveAdapter.parse(d, sink, { archivePath: file });
    expect(s.cwd).toBe('/w');
    expect(s.toolCallCount).toBe(1);
    expect(fileOps).toEqual([expect.objectContaining({ path: '/w/a.ts', op: 'write', succeeded: true })]);
    expect(s.prompts[0]).toMatchObject({ text: 'create a.ts', answered: true, filesModified: ['/w/a.ts'] });
    expect(s.primaryModel).toBe('gemini-3-pro');
    expect(s.providerMeta.usage).toMatchObject({ inputTokens: 50, outputTokens: 7 });
    expect(s.plans[0].text).toContain('Files changed');
    expect(s.malformedLines).toBe(1);
    expect(s.title).toBe('Create a.ts');
    expect(events.every((e) => e.rawOffset != null)).toBe(true);
  });

  it('records "after only" tool events as a call plus its result', async () => {
    const file = write('live/windsurf/w1.jsonl', [rec({ agent_action_name: 'post_write_code', tool_info: { file_path: '/p/b.ts', edits: [] } }, 'hook', 'windsurf')].map((l) => JSON.stringify(l)).join('\n'));
    const { sink, fileOps } = memorySink();
    const s = await liveAdapter.parse({ agent: 'live', reportedAgent: 'windsurf', externalId: 'w1', sourcePath: file, sourceKey: 'live:w', size: 1, mtime: new Date(), relPath: 'w' }, sink, { archivePath: file });
    expect(s.toolCallCount).toBe(1);
    expect(s.toolErrorCount).toBe(0);
    expect(fileOps[0]).toMatchObject({ path: '/p/b.ts', op: 'edit', succeeded: true });
  });
});

describe('OTLP ingest', () => {
  it('splits an export by agent and session into the live spool', () => {
    const before = fs.existsSync(path.join(liveDir(), 'claude-code', 'sess-A.jsonl')) ? fs.readFileSync(path.join(liveDir(), 'claude-code', 'sess-A.jsonl'), 'utf8').split('\n').filter(Boolean).length : 0;
    const body = {
      resourceLogs: [{
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'claude-code' } }] },
        scopeLogs: [{ logRecords: [
          { timeUnixNano: '1700000000000000000', body: { stringValue: 'claude_code.user_prompt' }, attributes: [{ key: 'event.name', value: { stringValue: 'user_prompt' } }, { key: 'session.id', value: { stringValue: 'sess-A' } }, { key: 'prompt', value: { stringValue: 'hello' } }] },
          { attributes: [{ key: 'event.name', value: { stringValue: 'api_request' } }, { key: 'session.id', value: { stringValue: 'sess-A' } }, { key: 'input_tokens', value: { intValue: '12' } }] },
        ] }],
      }],
    };
    expect(ingestOtlpLogs(body)).toEqual({ stored: 2, agents: ['claude-code'] });
    const lines = fs.readFileSync(path.join(liveDir(), 'claude-code', 'sess-A.jsonl'), 'utf8').split('\n').filter(Boolean);
    expect(lines.length - before).toBe(2);
    const last = JSON.parse(lines[lines.length - 1]) as LiveRecord;
    expect(last).toMatchObject({ source: 'otlp', agent: 'claude-code', session: 'sess-A' });
    expect((last.payload as { attributes: Record<string, unknown> }).attributes.input_tokens).toBe(12);
  });
});

describe('connect / disconnect agent configs', () => {
  const home = path.join(tmp, 'home');
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, ROOT: process.env.DEVCONTINUITY_APP_ROOT, CODEX: process.env.CODEX_HOME };
  beforeAll(() => {
    fs.mkdirSync(home, { recursive: true });
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    delete process.env.CODEX_HOME;
    process.env.DEVCONTINUITY_APP_ROOT = path.resolve(__dirname, '..');
  });
  afterAll(() => {
    for (const [k, v] of [['HOME', saved.HOME], ['USERPROFILE', saved.USERPROFILE], ['DEVCONTINUITY_APP_ROOT', saved.ROOT], ['CODEX_HOME', saved.CODEX]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('adds its own Windsurf hooks next to existing ones, is idempotent, and removes only its own', async () => {
    const { applyConnect, planConnect } = await import('../src/server/live/connect');
    const hooksFile = path.join(home, '.codeium', 'windsurf', 'hooks.json');
    const theirs = { command: 'other-tool hook', show_output: false };
    fs.mkdirSync(path.dirname(hooksFile), { recursive: true });
    fs.writeFileSync(hooksFile, JSON.stringify({ hooks: { pre_user_prompt: [theirs] } }));

    const plan = planConnect('windsurf');
    expect(plan.changes.map((c) => path.basename(c.file)).sort()).toEqual(['hooks.json', 'mcp_config.json']);
    const r = applyConnect(plan);
    expect(fs.existsSync(path.join(r.backupDir, 'hooks.json'))).toBe(true);
    const after = JSON.parse(fs.readFileSync(hooksFile, 'utf8'));
    expect(after.hooks.pre_user_prompt).toHaveLength(2);
    expect(after.hooks.pre_user_prompt[0]).toEqual(theirs);
    expect(after.hooks.post_write_code[0].command).toMatch(/scripts\/hook\.mjs" windsurf$/);

    expect(planConnect('windsurf').changes).toEqual([]);

    applyConnect(planConnect('windsurf', { remove: true }));
    const removed = JSON.parse(fs.readFileSync(hooksFile, 'utf8'));
    expect(removed).toEqual({ hooks: { pre_user_prompt: [theirs] } });
  });

  it('adds and removes the Codex MCP block without touching the rest of config.toml', async () => {
    const { applyConnect, planConnect } = await import('../src/server/live/connect');
    const cfg = path.join(home, '.codex', 'config.toml');
    fs.mkdirSync(path.dirname(cfg), { recursive: true });
    const original = 'model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "x"\n';
    fs.writeFileSync(cfg, original);
    applyConnect(planConnect('codex'));
    const text = fs.readFileSync(cfg, 'utf8');
    expect(text).toContain('[mcp_servers.devcontinuity]');
    expect(text).toContain('[mcp_servers.other]');
    applyConnect(planConnect('codex', { remove: true }));
    expect(fs.readFileSync(cfg, 'utf8').trim()).toBe(original.trim());
  });

  it('nests Gemini CLI hooks the way Gemini expects', async () => {
    const { planConnect } = await import('../src/server/live/connect');
    const plan = planConnect('gemini-cli');
    const cfg = JSON.parse(plan.changes[0].after!);
    expect(cfg.hooks.BeforeTool[0]).toMatchObject({ matcher: '*', hooks: [{ type: 'command', name: 'devcontinuity' }] });
    expect(cfg.hooks.BeforeAgent[0].matcher).toBeUndefined();
    expect(cfg.mcpServers.devcontinuity.args[1]).toMatch(/scripts\/mcp\.ts$/);
    expect(cfg.telemetry).toBeUndefined();
  });

  it('points npm installations at stable copies in the data folder, and still recognises them', async () => {
    const { applyConnect, connectionStatus, planConnect } = await import('../src/server/live/connect');
    const { dataDir } = await import('../src/server/config');
    process.env.DEVCONTINUITY_PACKAGED = '1';
    try {
      const plan = planConnect('cursor');
      const hooks = JSON.parse(plan.changes.find((c) => c.file.endsWith('hooks.json'))!.after!);
      expect(hooks.hooks.stop[0].command).toMatch(/bin\/devcontinuity-hook\.mjs" cursor$/);
      const hookCopy = path.join(dataDir(), 'bin', 'devcontinuity-hook.mjs');
      expect(fs.readFileSync(hookCopy, 'utf8')).toContain(`const INSTALLED_DATA_DIR = ${JSON.stringify(dataDir())};`);
      const mcp = JSON.parse(plan.changes.find((c) => c.file.endsWith('mcp.json'))!.after!).mcpServers.devcontinuity;
      expect(mcp.args[0]).toMatch(/bin\/devcontinuity-mcp\.mjs$/);
      expect(fs.readFileSync(path.join(dataDir(), 'bin', 'devcontinuity-mcp.mjs'), 'utf8')).toContain("'devcontinuity', 'mcp'");
      applyConnect(plan);
      expect(connectionStatus().find((c) => c.agent === 'cursor')).toMatchObject({ hooks: true, mcp: true });
      applyConnect(planConnect('cursor', { remove: true }));
      expect(connectionStatus().find((c) => c.agent === 'cursor')).toMatchObject({ hooks: false, mcp: false });
    } finally {
      delete process.env.DEVCONTINUITY_PACKAGED;
    }
  });
});
