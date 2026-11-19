#!/usr/bin/env node
/**
 * Builds a fictional demo workspace so DevContinuity can be shown (and screenshotted) without
 * anyone's real history. It writes agent history files in each agent's own on-disk format into
 * a fake home folder, plus live-capture streams, then imports them with the normal importer.
 *
 *   npm run demo              # creates ./demo (home, projects, data) and imports it
 *   npm run demo -- --serve   # ...then serves it at http://localhost:3299
 *   DEMO_DIR=/tmp/dc-demo npm run demo   # put it elsewhere (shorter paths in screenshots)
 *
 * Nothing outside the demo folder is touched.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const demo = path.resolve(process.env.DEMO_DIR?.trim() || path.join(root, 'demo'));
const home = path.join(demo, 'home');
const data = path.join(demo, 'data');
const appData = path.join(home, 'AppData', 'Roaming');
const code = path.join(demo, 'code');

fs.rmSync(demo, { recursive: true, force: true });
fs.mkdirSync(code, { recursive: true });

// ---------- deterministic randomness so screenshots are reproducible ----------
let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
const pick = (a) => a[Math.floor(rnd() * a.length)];
const id = () => crypto.randomUUID();
const NOW = Date.now();
const at = (daysAgo, minutes = 0) => new Date(NOW - daysAgo * 86_400_000 - (rnd() * 8 + 1) * 3_600_000 + minutes * 60_000);
const iso = (d) => d.toISOString();
const write = (file, content) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};

// ---------- fictional projects (real folders with Git history) ----------
const PROJECTS = {
  'acme-shop-api': { lang: 'TypeScript API', files: ['src/routes/checkout.ts', 'src/services/payments.ts', 'src/middleware/rateLimit.ts', 'tests/checkout.test.ts'], prompts: ['Add rate limiting to the public checkout endpoints', 'Fix the rounding bug in order totals with multiple currencies', 'Write integration tests for the Stripe webhook handler', 'Refactor the payments service to support refunds', 'Add idempotency keys to POST /orders'] },
  'acme-mobile': { lang: 'Flutter app', files: ['lib/screens/cart_screen.dart', 'lib/state/cart_bloc.dart', 'lib/widgets/product_card.dart', 'test/cart_test.dart'], prompts: ['Build the cart screen with swipe-to-delete', 'Add offline caching for the product catalog', 'Fix the RTL layout on the checkout screen', 'Add Arabic translations for onboarding', 'Make product cards accessible to screen readers'] },
  'docs-portal': { lang: 'Next.js site', files: ['app/docs/[slug]/page.tsx', 'components/Search.tsx', 'lib/markdown.ts', 'app/layout.tsx'], prompts: ['Add full-text search to the docs', 'Generate the API reference from the OpenAPI spec', 'Add a dark mode toggle', 'Fix broken anchors in the changelog page'] },
  'ml-forecast': { lang: 'Python pipeline', files: ['pipeline/train.py', 'pipeline/features.py', 'notebooks/eda.ipynb', 'tests/test_features.py'], prompts: ['Add a weekly seasonality feature to the demand model', 'Speed up feature generation with polars', 'Write tests for the holiday calendar features', 'Track experiments with MLflow'] },
};
const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_NAME: 'Demo', GIT_AUTHOR_EMAIL: 'demo@example.com', GIT_COMMITTER_NAME: 'Demo', GIT_COMMITTER_EMAIL: 'demo@example.com' } });
for (const [name, p] of Object.entries(PROJECTS)) {
  const dir = path.join(code, name);
  for (const f of p.files) write(path.join(dir, f), `// ${name}: ${f}\n`);
  write(path.join(dir, 'README.md'), `# ${name}\n\n${p.lang} (demo project).\n`);
  write(path.join(dir, 'package.json'), JSON.stringify({ name, private: true, scripts: { test: 'echo ok' } }, null, 2));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'Initial commit');
  fs.appendFileSync(path.join(dir, p.files[0]), '// work in progress\n');
}
const projectNames = Object.keys(PROJECTS);
const cwdOf = (name) => path.join(code, name);
const fileOf = (name) => path.join(cwdOf(name), pick(PROJECTS[name].files));

// Sessions per agent per day: busier recently, a few quiet days.
const schedule = (perDay, days = 14) => Array.from({ length: days }, (_, d) => Math.max(0, Math.round(perDay * (0.4 + rnd() * 1.2) * (d < 4 ? 1.3 : 1) - (rnd() < 0.2 ? perDay : 0))));

// ---------- Claude Code: ~/.claude/projects/<encoded>/<id>.jsonl ----------
const enc = (p) => p.replace(/[^A-Za-z0-9]/g, '-');
const claudeEnds = ['completed', 'completed', 'completed', 'completed', 'interrupted_tool', 'limit'];
schedule(2.2).forEach((n, day) => {
  for (let i = 0; i < n; i++) {
    const project = pick(projectNames);
    const cwd = cwdOf(project);
    const sid = id();
    const base = { sessionId: sid, cwd, version: '2.3.1', gitBranch: 'main', userType: 'external', isSidechain: false };
    const t0 = at(day);
    let m = 0;
    const L = [];
    const prompt = pick(PROJECTS[project].prompts);
    const end = pick(claudeEnds);
    L.push({ ...base, type: 'user', uuid: id(), timestamp: iso(t0), message: { role: 'user', content: prompt } });
    const steps = 2 + Math.floor(rnd() * 4);
    for (let s = 0; s < steps; s++) {
      const tid = id();
      const file = fileOf(project);
      const bash = rnd() < 0.35;
      const tool = bash ? { name: 'Bash', input: { command: pick(['npm test', 'git status', 'npx tsc --noEmit', 'pytest -q', 'flutter test']) } } : { name: pick(['Edit', 'Write', 'Read']), input: { file_path: file, old_string: 'a', new_string: 'b' } };
      L.push({ ...base, type: 'assistant', uuid: id(), timestamp: new Date(t0.getTime() + ++m * 20_000).toISOString(), message: { model: 'claude-sonnet-4-5', role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: tid, ...tool }], usage: { input_tokens: 2000 + Math.floor(rnd() * 9000), output_tokens: 200 + Math.floor(rnd() * 900) } } });
      if (end === 'interrupted_tool' && s === steps - 1) break;
      L.push({ ...base, type: 'user', uuid: id(), timestamp: new Date(t0.getTime() + ++m * 20_000).toISOString(), toolUseResult: bash ? { stdout: 'ok' } : { filePath: file }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tid, content: bash ? 'All tests passed' : 'File updated' }] } });
    }
    if (end === 'completed') L.push({ ...base, type: 'assistant', uuid: id(), timestamp: new Date(t0.getTime() + ++m * 20_000).toISOString(), message: { model: 'claude-sonnet-4-5', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: `Done: ${prompt.toLowerCase()}. Tests pass and the change is ready for review.` }] } });
    if (end === 'limit') L.push({ ...base, type: 'assistant', uuid: id(), isApiErrorMessage: true, timestamp: new Date(t0.getTime() + ++m * 20_000).toISOString(), message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: "You've hit your session limit · resets 5pm" }] } });
    L.push({ type: 'custom-title', customTitle: prompt, sessionId: sid });
    write(path.join(home, '.claude', 'projects', enc(cwd), `${sid}.jsonl`), `${L.map((x) => JSON.stringify(x)).join('\n')}\n`);
  }
});

// The headline scenario: Claude Code stops on its usage limit in acme-shop-api 25 minutes ago, with
// nothing newer in that project, so the Overview offers to continue it in another agent.
{
  const cwd = cwdOf('acme-shop-api');
  const sid = '7c1d2e3f-0a4b-4c5d-8e6f-a1b2c3d4e5f6';
  const base = { sessionId: sid, cwd, version: '2.3.1', gitBranch: 'feature/rate-limit', userType: 'external', isSidechain: false };
  const t0 = new Date(NOW - 41 * 60_000);
  const ts = (k) => new Date(t0.getTime() + k * 60_000).toISOString();
  const prompt = 'Add rate limiting to the public checkout endpoints';
  const L = [{ ...base, type: 'user', uuid: id(), timestamp: ts(0), message: { role: 'user', content: `${prompt}. Use a sliding window per API key, 60 requests per minute, and return 429 with Retry-After.` } }];
  const steps = [
    ['Read', { file_path: path.join(cwd, 'src/routes/checkout.ts') }, 'export const checkoutRouter = …'],
    ['Write', { file_path: path.join(cwd, 'src/middleware/rateLimit.ts'), content: 'export function rateLimit() {}' }, 'File created'],
    ['Edit', { file_path: path.join(cwd, 'src/routes/checkout.ts'), old_string: 'router.post(', new_string: 'router.post(rateLimit(), ' }, 'File updated'],
    ['Bash', { command: 'npm test -- checkout' }, '2 failing: expected 429, got 200 (tests/checkout.test.ts)'],
    ['Edit', { file_path: path.join(cwd, 'src/middleware/rateLimit.ts'), old_string: 'window', new_string: 'slidingWindow' }, 'File updated'],
  ];
  steps.forEach(([name, input, out], i) => {
    const tid = id();
    L.push({ ...base, type: 'assistant', uuid: id(), timestamp: ts(2 + i * 3), message: { model: 'claude-sonnet-4-5', role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: tid, name, input }], usage: { input_tokens: 9000 + i * 1500, output_tokens: 600 } } });
    L.push({ ...base, type: 'user', uuid: id(), timestamp: ts(3 + i * 3), toolUseResult: name === 'Bash' ? { stdout: out } : { filePath: input.file_path }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tid, content: out, is_error: out.includes('failing') }] } });
  });
  L.push({ ...base, type: 'assistant', uuid: id(), isApiErrorMessage: true, timestamp: ts(16), message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: "You've hit your session limit · resets 5pm" }] } });
  L.push({ type: 'custom-title', customTitle: prompt, sessionId: sid });
  write(path.join(home, '.claude', 'projects', enc(cwd), `${sid}.jsonl`), `${L.map((x) => JSON.stringify(x)).join('\n')}\n`);
}

// ---------- Codex: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl ----------
schedule(1.3).forEach((n, day) => {
  for (let i = 0; i < n; i++) {
    const project = pick(projectNames);
    const cwd = cwdOf(project);
    const t = at(day);
    const sid = id();
    const prompt = pick(PROJECTS[project].prompts);
    const f = path.relative(cwd, fileOf(project)).replace(/\\/g, '/');
    const ts = (k) => new Date(t.getTime() + k * 15_000).toISOString();
    const L = [
      { timestamp: ts(0), type: 'session_meta', payload: { id: sid, cwd, cli_version: '0.98.0' } },
      { timestamp: ts(1), type: 'turn_context', payload: { model: 'gpt-5.1-codex', cwd } },
      { timestamp: ts(2), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] } },
      { timestamp: ts(3), type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', call_id: 'c1', input: `*** Begin Patch\n*** Update File: ${f}\n@@\n-old\n+new\n*** End Patch` } },
      { timestamp: ts(4), type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c1', output: '{"output":"Success","metadata":{"exit_code":0}}' } },
      { timestamp: ts(5), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `Implemented: ${prompt}.` }] } },
    ];
    const d = t;
    const dir = path.join(home, '.codex', 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
    write(path.join(dir, `rollout-${iso(d).replace(/[:.]/g, '-')}-${sid}.jsonl`), `${L.map((x) => JSON.stringify(x)).join('\n')}\n`);
  }
});

// ---------- Cline (VS Code extension storage) ----------
const clineRoot = path.join(appData, 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev');
const clineHistory = [];
for (const [k, day] of [[0, 1], [1, 3], [2, 6], [3, 9]].map(([a, b]) => [a, b])) {
  const project = projectNames[k % projectNames.length];
  const cwd = cwdOf(project);
  const t = at(day);
  const tid = String(t.getTime());
  const prompt = pick(PROJECTS[project].prompts);
  const file = path.relative(cwd, fileOf(project)).replace(/\\/g, '/');
  write(path.join(clineRoot, 'tasks', tid, 'api_conversation_history.json'), JSON.stringify([
    { role: 'user', ts: t.getTime(), content: [{ type: 'text', text: `<task>\n${prompt}\n</task>` }, { type: 'text', text: '<environment_details>\n# Open Tabs\n</environment_details>' }] },
    { role: 'assistant', ts: t.getTime() + 20_000, modelInfo: { modelId: 'claude-sonnet-4-5' }, metrics: { tokens: { prompt: 12000, completion: 600 }, cost: 0.05 }, content: [{ type: 'text', text: 'Looking at the code first.' }, { type: 'tool_use', id: 't1', name: 'replace_in_file', input: { path: file, diff: '...', task_progress: '- [x] Read the code\n- [x] Make the change\n- [ ] Add tests' } }] },
    { role: 'user', ts: t.getTime() + 30_000, content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'ok' }] }] },
    { role: 'assistant', ts: t.getTime() + 60_000, content: [{ type: 'tool_use', id: 't2', name: 'attempt_completion', input: { result: `Finished: ${prompt}.` } }] },
  ]));
  write(path.join(clineRoot, 'tasks', tid, 'ui_messages.json'), JSON.stringify([{ ts: t.getTime() + 61_000, type: 'say', say: 'completion_result', text: 'Finished.' }]));
  clineHistory.push({ id: tid, task: prompt, cwdOnTaskInitialization: cwd, totalCost: 0.05 + rnd() * 0.4, tokensIn: 12000, tokensOut: 600, modelId: 'claude-sonnet-4-5' });
}
write(path.join(clineRoot, 'state', 'taskHistory.json'), JSON.stringify(clineHistory));

// ---------- GitHub Copilot Chat (VS Code workspace storage) ----------
for (const [k, day] of [[0, 0], [1, 2], [2, 4], [3, 5], [1, 8], [0, 11]]) {
  const project = projectNames[k];
  const cwd = cwdOf(project);
  const ws = path.join(appData, 'Code', 'User', 'workspaceStorage', crypto.createHash('md5').update(project).digest('hex'));
  write(path.join(ws, 'workspace.json'), JSON.stringify({ folder: `file:///${cwd.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_m, d) => `${d.toLowerCase()}%3A`)}` }));
  const t = at(day);
  const prompt = pick(PROJECTS[project].prompts);
  const file = fileOf(project);
  write(path.join(ws, 'chatSessions', `${id()}.json`), JSON.stringify({
    version: 3, creationDate: t.getTime(), lastMessageDate: t.getTime() + 90_000, customTitle: prompt, requests: [{
      requestId: `request_${id()}`, timestamp: t.getTime(), message: { text: prompt }, agent: { name: 'agent' },
      response: [
        { value: 'Let me look at the relevant files. ' },
        { kind: 'toolInvocationSerialized', toolId: 'copilot_readFile', toolCallId: id(), isComplete: true, invocationMessage: { value: 'Reading file', uris: { [`file:///${file.replace(/\\/g, '/')}`]: {} } }, pastTenseMessage: { value: `Read ${path.basename(file)}` } },
        { kind: 'textEditGroup', uri: { fsPath: file }, edits: [[{ text: 'updated\ncode' }]] },
        { value: `Done. I updated \`${path.basename(file)}\`.` },
      ],
      result: { metadata: { resolvedModel: 'gpt-5-mini', promptTokens: 9000, outputTokens: 400 } }, modelState: { value: 1 },
    }],
  }));
}

// ---------- Continue ----------
for (const day of [3, 10]) {
  const project = pick(projectNames);
  const sid = id();
  write(path.join(home, '.continue', 'sessions', `${sid}.json`), JSON.stringify({ sessionId: sid, title: pick(PROJECTS[project].prompts), workspaceDirectory: `file:///${cwdOf(project).replace(/\\/g, '/')}`, chatModelTitle: 'Qwen 2.5 Coder', history: [
    { message: { role: 'user', content: [{ type: 'text', text: pick(PROJECTS[project].prompts) }], id: id() } },
    { message: { role: 'assistant', content: 'Here is a plan and the change, applied to the file.' }, promptLogs: [{ modelTitle: 'Qwen 2.5 Coder (Ollama)' }] },
  ] }));
  void day;
}
const sessionsIndex = fs.existsSync(path.join(home, '.continue', 'sessions')) ? fs.readdirSync(path.join(home, '.continue', 'sessions')).map((n, i) => ({ sessionId: n.replace('.json', ''), title: 'demo', dateCreated: String(at(i === 0 ? 3 : 10).getTime()), workspaceDirectory: '' })) : [];
write(path.join(home, '.continue', 'sessions', 'sessions.json'), JSON.stringify(sessionsIndex));

// ---------- Antigravity: its conversation index ----------
{
  const dir = path.join(home, '.gemini', 'antigravity');
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'conversation_summaries.db'));
  db.exec('CREATE TABLE conversation_summaries (conversation_id text PRIMARY KEY, title text, preview text, step_count integer, last_modified_time datetime, workspace_uris text, status text, parent_conversation_id text, agent_name text, killed numeric, project_id text)');
  db.exec('CREATE TABLE conversations_fts_content (id INTEGER PRIMARY KEY, c0, c1, c2, c3, c4, c5, c6, c7, c8, c9, c10, c11, c12, c13, c14)');
  const ins = db.prepare('INSERT INTO conversation_summaries VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  const fts = db.prepare('INSERT INTO conversations_fts_content (c0,c1,c2,c3,c8,c9,c13,c14) VALUES (?,?,?,?,?,?,?,?)');
  for (const [k, day] of [[2, 0], [0, 2], [3, 5], [1, 7]]) {
    const project = projectNames[k];
    const cid = id();
    const title = pick(PROJECTS[project].prompts);
    const user = `${title}\nKeep the existing API stable.`;
    const agent = 'I will start by reading the project structure.Implemented the change and verified it in the browser.';
    const t = at(day);
    ins.run(cid, title, title, 12, t.toISOString().replace('T', ' ').replace('Z', '+00:00'), JSON.stringify([`file:///${cwdOf(project).replace(/\\/g, '/')}`]), 'CASCADE_RUN_STATUS_IDLE', '', '', 0, 'demo');
    const nl = Buffer.byteLength(title) + 1;
    fts.run(cid, 0, 0, 3, Buffer.from(JSON.stringify([[0, 0], [2, nl]])), Buffer.from(JSON.stringify([[1, 0], [3, Buffer.byteLength('I will start by reading the project structure.')]])), user, agent);
    write(path.join(dir, 'brain', cid, 'implementation_plan.md'), `# Plan: ${title}\n\n1. Read the existing code\n2. Implement the change\n3. Verify in the browser\n`);
  }
  db.close();
}

// ---------- Live capture: Gemini CLI, Windsurf, Cursor (hook records) ----------
const live = (agent, session, payload, when) => {
  const file = path.join(data, 'live', agent, `${session}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify({ v: 1, at: iso(when), source: 'hook', agent, session, cwd: payload.cwd, payload })}\n`);
};
schedule(0.8).forEach((n, day) => {
  for (let i = 0; i < n; i++) {
    const project = pick(projectNames);
    const cwd = cwdOf(project);
    const t = at(day);
    const s = `gem-${id().slice(0, 8)}`;
    const prompt = pick(PROJECTS[project].prompts);
    const file = fileOf(project);
    live('gemini-cli', s, { hook_event_name: 'BeforeAgent', session_id: s, cwd, prompt }, t);
    live('gemini-cli', s, { hook_event_name: 'BeforeTool', session_id: s, cwd, tool_name: 'replace', tool_input: { file_path: file } }, new Date(t.getTime() + 20_000));
    live('gemini-cli', s, { hook_event_name: 'AfterTool', session_id: s, cwd, tool_name: 'replace', tool_input: { file_path: file }, tool_response: { llmContent: 'ok' } }, new Date(t.getTime() + 25_000));
    live('gemini-cli', s, { hook_event_name: 'AfterAgent', session_id: s, cwd, prompt_response: `Done: ${prompt.toLowerCase()}.` }, new Date(t.getTime() + 60_000));
  }
});
for (const day of [0, 1, 4, 8]) {
  const project = pick(projectNames);
  const cwd = cwdOf(project);
  const t = at(day);
  const s = `traj-${id().slice(0, 8)}`;
  live('windsurf', s, { agent_action_name: 'pre_user_prompt', trajectory_id: s, cwd, tool_info: { user_prompt: pick(PROJECTS[project].prompts) } }, t);
  live('windsurf', s, { agent_action_name: 'post_write_code', trajectory_id: s, cwd, tool_info: { file_path: fileOf(project), edits: [] } }, new Date(t.getTime() + 30_000));
  live('windsurf', s, { agent_action_name: 'post_run_command', trajectory_id: s, tool_info: { command_line: 'npm test', cwd, exit_code: 0 } }, new Date(t.getTime() + 50_000));
  live('windsurf', s, { agent_action_name: 'post_cascade_response', trajectory_id: s, cwd, tool_info: { response: 'All set. The change is in place and tests pass.' } }, new Date(t.getTime() + 70_000));
}
for (const day of [0, 2, 6]) {
  const project = pick(projectNames);
  const cwd = cwdOf(project);
  const t = at(day);
  const s = `cur-${id().slice(0, 8)}`;
  live('cursor', s, { hook_event_name: 'beforeSubmitPrompt', conversation_id: s, workspace_roots: [cwd], prompt: pick(PROJECTS[project].prompts) }, t);
  live('cursor', s, { hook_event_name: 'afterFileEdit', conversation_id: s, workspace_roots: [cwd], file_path: fileOf(project), edits: [] }, new Date(t.getTime() + 30_000));
  live('cursor', s, { hook_event_name: 'afterAgentResponse', conversation_id: s, workspace_roots: [cwd], text: 'Implemented and verified.' }, new Date(t.getTime() + 60_000));
  live('cursor', s, { hook_event_name: 'stop', conversation_id: s, workspace_roots: [cwd], status: day === 2 ? 'aborted' : 'completed' }, new Date(t.getTime() + 61_000));
}

// ---------- import with the normal pipeline, isolated from the real install ----------
const env = { ...process.env, USERPROFILE: home, HOME: home, APPDATA: appData, LOCALAPPDATA: path.join(home, 'AppData', 'Local'), XDG_DATA_HOME: path.join(home, '.local', 'share'), XDG_CONFIG_HOME: path.join(home, '.config'), DEVCONTINUITY_DATA_DIR: data, CLAUDE_CONFIG_DIR: '', CODEX_HOME: '', CONTINUE_GLOBAL_DIR: '' };
for (const k of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'CONTINUE_GLOBAL_DIR']) delete env[k];
const node = (args) => {
  const r = spawnSync(process.execPath, args, { cwd: root, env, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
};
node([path.join('scripts', 'setup.mjs')]);
node([path.join('node_modules', 'tsx', 'dist', 'cli.mjs'), path.join('scripts', 'dc.ts'), 'import']);
node([path.join('node_modules', 'tsx', 'dist', 'cli.mjs'), path.join('scripts', 'dc.ts'), 'connect', 'windsurf', '--yes']);
console.log(`\nDemo ready: home ${home}, data ${data}`);

if (process.argv.includes('--serve')) {
  const next = path.join(root, 'node_modules', 'next', 'dist', 'bin', 'next');
  console.log('Serving the demo at http://localhost:3299 (Ctrl+C to stop)');
  spawn(process.execPath, [next, 'start', '-p', '3299'], { cwd: root, env, stdio: 'inherit' });
}
