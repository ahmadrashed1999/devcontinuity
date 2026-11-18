import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { readJsonl } from '../src/server/parsers/jsonl';
import { redactSecrets, redactDeep } from '../src/server/security/redact';
import { isSensitiveFile, safeJoin, validateLocalPath, pathKey, isInside } from '../src/server/security/paths';
import { parseStatus } from '../src/server/git/git';
import { toFtsQuery } from '../src/server/search';
import { deriveTasks, statusFromAgentClaim } from '../src/server/intelligence/tasks';
import { claudeCodeAdapter, encodeClaudeProjectDir } from '../src/server/adapters/claude-code';
import { codexAdapter } from '../src/server/adapters/codex';
import { genericAdapter, findItems } from '../src/server/adapters/generic';
import type { DiscoveredSession, NormalizedEvent, NormalizedFileOp, SessionSink } from '../src/server/adapters/types';
import { createZip, extractZipSafely } from '../src/server/zip';
import { locateProject } from '../src/server/import/projects';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-test-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

function write(name: string, content: string | Buffer): string {
  const p = path.join(tmp, name);
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

function discovered(file: string, agent: DiscoveredSession['agent'] = 'claude-code'): DiscoveredSession {
  return { agent, externalId: path.basename(file).replace(/\.\w+$/, ''), sourcePath: file, sourceKey: `${agent}:${file}`, size: fs.statSync(file).size, mtime: new Date(), relPath: path.basename(file) };
}

describe('JSONL reader', () => {
  it('handles BOM, CRLF, blank lines, malformed lines and a truncated tail without losing lines', async () => {
    const file = write('mixed.jsonl', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"a":1}\r\n\r\n{bad json}\n{"b":"ü"}\n{"c":')]));
    const lines = [];
    for await (const l of readJsonl(file)) lines.push(l);
    expect(lines.map((l) => l.value ?? null)).toEqual([{ a: 1 }, null, { b: 'ü' }, null]);
    expect(lines[1].error).toMatch(/Malformed/);
    expect(lines[3].unterminated).toBe(true);
    expect(lines[3].error).toMatch(/Truncated/);
  });

  it('records byte offsets that point back at the original record', async () => {
    const content = '{"x":1}\n{"y":"ä€"}\n';
    const file = write('offsets.jsonl', content);
    const buf = fs.readFileSync(file);
    for await (const l of readJsonl(file)) expect(JSON.parse(buf.subarray(l.offset, l.offset + l.length).toString('utf8'))).toEqual(l.value);
  });

  it('skips and reports oversized lines instead of buffering them', async () => {
    const file = write('big.jsonl', `{"ok":1}\n{"big":"${'x'.repeat(5000)}"}\n{"ok":2}\n`);
    const out = [];
    for await (const l of readJsonl(file, { maxLineBytes: 1000 })) out.push(l);
    expect(out.map((l) => (l.error ? 'ERR' : (l.value as { ok: number }).ok))).toEqual([1, 'ERR', 2]);
  });
});

describe('secret redaction', () => {
  it('redacts common credential formats', () => {
    const input = ['ANTHROPIC_API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123', 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'AKIAABCDEFGHIJKLMNOP', 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz.123', 'postgres://user:hunter2pass@db.local/x', '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----', '"password": "S3cretValue!"'].join('\n');
    const out = redactSecrets(input);
    for (const secret of ['sk-ant-api03', 'ghp_abc', 'AKIAABCD', 'abcdefghijklmnopqrstuvwxyz.123', 'hunter2pass', 'BEGIN RSA', 'S3cretValue']) expect(out).not.toContain(secret);
    expect(out).toContain('[REDACTED:');
  });
  it('leaves ordinary code alone and works deeply', () => {
    expect(redactSecrets('const token = getToken(); if (password.length > 8) {}')).toBe('const token = getToken(); if (password.length > 8) {}');
    expect(redactDeep({ a: ['x sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123'] }).a[0]).toContain('[REDACTED');
  });
});

describe('path safety', () => {
  it('blocks zip-slip style entries', () => {
    const base = path.join(tmp, 'extract');
    expect(() => safeJoin(base, '../evil.txt')).toThrow();
    expect(() => safeJoin(base, 'a/../../evil.txt')).toThrow();
    expect(() => safeJoin(base, 'C:/Windows/evil.txt')).toThrow();
    expect(() => safeJoin(base, '/etc/passwd')).toThrow();
    expect(safeJoin(base, 'ok/file.txt')).toBe(path.join(base, 'ok', 'file.txt'));
  });
  it('rejects relative, UNC and NUL paths and recognises sensitive files', () => {
    expect(() => validateLocalPath('relative/dir')).toThrow();
    expect(() => validateLocalPath('\\\\server\\share')).toThrow();
    expect(() => validateLocalPath('C:\\a\0b')).toThrow();
    expect(isSensitiveFile('C:/Users/x/.claude/.credentials.json')).toBe(true);
    expect(isSensitiveFile('C:/Users/x/.codex/auth.json')).toBe(true);
    expect(isSensitiveFile('C:/Users/x/.claude/shell-snapshots/snap.sh')).toBe(true);
    expect(isSensitiveFile('C:/Users/x/.claude/projects/p/s.jsonl')).toBe(false);
    expect(pathKey('C:\\Work\\App\\')).toBe('c:/work/app');
    expect(isInside('C:\\work\\app\\src', 'c:/WORK/app')).toBe(true);
    expect(isInside('C:\\work\\application', 'C:\\work\\app')).toBe(false);
  });
  it('extracts archives safely and never overwrites existing files', async () => {
    const zip = path.join(tmp, 'safe.zip');
    await createZip(zip, [{ name: 'dir/a.txt', content: 'hello' }]);
    const out = path.join(tmp, 'safe-out');
    const r = await extractZipSafely(zip, out);
    expect(r.files).toHaveLength(1);
    expect(fs.readFileSync(path.join(out, 'dir', 'a.txt'), 'utf8')).toBe('hello');
    await expect(extractZipSafely(zip, out)).rejects.toThrow();
    await expect(createZip(zip, [])).rejects.toThrow(/exists/);
  });
});

describe('task rules', () => {
  it('never turns an agent claim into completed', () => {
    expect(statusFromAgentClaim('completed')).toBe('requires_verification');
    expect(statusFromAgentClaim('done')).toBe('requires_verification');
    expect(statusFromAgentClaim('in_progress')).toBe('in_progress');
    expect(statusFromAgentClaim('weird')).toBe('pending');
  });
});

describe('Claude Code adapter', () => {
  const line = (o: object) => JSON.stringify(o);
  const base = { sessionId: 's1', cwd: 'C:\\work\\app', version: '2.1.0', gitBranch: 'main', userType: 'external', isSidechain: false };

  it('parses a session, pairs tools, tracks files and detects an interrupted end', async () => {
    const file = write('claude/s1.jsonl', [
      line({ ...base, type: 'user', uuid: 'u1', timestamp: '2026-11-01T10:00:00Z', message: { role: 'user', content: 'Add a login page with validation' } }),
      line({ ...base, type: 'assistant', uuid: 'a1', timestamp: '2026-11-01T10:00:05Z', message: { model: 'claude-x', role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'thinking', thinking: '', signature: 'abc' }, { type: 'tool_use', id: 't1', name: 'Write', input: { file_path: 'C:\\work\\app\\login.tsx', content: 'x' } }] } }),
      line({ ...base, type: 'user', uuid: 'u2', timestamp: '2026-11-01T10:00:06Z', sourceToolAssistantUUID: 'a1', toolUseResult: { filePath: 'C:\\work\\app\\login.tsx' }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'File written' }] } }),
      line({ ...base, type: 'assistant', uuid: 'a2', timestamp: '2026-11-01T10:00:09Z', message: { model: 'claude-x', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'The login page is done.' }] } }),
      line({ ...base, type: 'user', uuid: 'u3', timestamp: '2026-11-01T10:01:00Z', message: { role: 'user', content: 'Now run the tests and fix failures' } }),
      line({ ...base, type: 'assistant', uuid: 'a3', timestamp: '2026-11-01T10:01:04Z', message: { model: 'claude-x', role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'npm test', description: 'Run tests' } }] } }),
      line({ type: 'custom-title', customTitle: 'Login work', sessionId: 's1' }),
      line({ type: 'brand-new-record-type', foo: 1, sessionId: 's1' }),
      '{"type":"user","truncat',
    ].join('\n'));
    const { sink, events, fileOps } = memorySink();
    const s = await claudeCodeAdapter.parse(discovered(file), sink, { archivePath: file });
    expect(s.title).toBe('Login work');
    expect(s.cwd).toBe('C:\\work\\app');
    expect(s.userMessageCount).toBe(2);
    expect(s.toolCallCount).toBe(2);
    expect(s.commandCount).toBe(1);
    expect(s.models).toEqual(['claude-x']);
    expect(s.endState).toBe('interrupted_tool');
    expect(s.malformedLines).toBe(1);
    expect(s.unknownRecordCount).toBe(1);
    expect(events.map((e) => e.seq)).toEqual([...events.keys()]);
    expect(events.find((e) => e.kind === 'thinking')?.subtype).toBe('signature_only');
    expect(fileOps).toEqual([expect.objectContaining({ path: 'C:\\work\\app\\login.tsx', op: 'write', succeeded: true })]);
    expect(s.prompts[0]).toMatchObject({ answered: true, filesModified: ['C:\\work\\app\\login.tsx'] });
    expect(s.prompts[1].answered).toBe(false);

    const tasks = deriveTasks('sid', 'key', s);
    expect(tasks.map((t) => t.status)).toEqual(['requires_verification', 'in_progress']);
    expect(tasks.every((t) => t.status !== 'completed')).toBe(true);
    expect(tasks[0].evidence.map((e) => e.type)).toEqual(expect.arrayContaining(['user_request', 'assistant_response', 'files_modified']));
  });

  it('classifies injected context, interrupts and API errors', async () => {
    const file = write('claude/s2.jsonl', [
      line({ ...base, type: 'user', uuid: 'u1', timestamp: '2026-11-01T10:00:00Z', message: { role: 'user', content: 'Fix the checkout total rounding bug' } }),
      line({ ...base, type: 'user', uuid: 'u2', isMeta: true, timestamp: '2026-11-01T10:00:01Z', message: { role: 'user', content: '<system-reminder>context</system-reminder>' } }),
      line({ ...base, type: 'assistant', uuid: 'a1', timestamp: '2026-11-01T10:00:05Z', isApiErrorMessage: true, message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: "You've hit your session limit" }] } }),
    ].join('\n'));
    const { sink } = memorySink();
    const s = await claudeCodeAdapter.parse(discovered(file), sink, { archivePath: file });
    expect(s.userMessageCount).toBe(1);
    expect(s.endState).toBe('api_error');
    expect(s.endStateDetail).toContain('session limit');
    expect(deriveTasks('x', 'y', s)[0].status).toBe('blocked');

    const f2 = write('claude/s3.jsonl', [line({ ...base, type: 'user', uuid: 'u1', message: { role: 'user', content: 'Refactor the payment module' } }), line({ ...base, type: 'user', uuid: 'u2', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } })].join('\n'));
    const s3 = await claudeCodeAdapter.parse(discovered(f2), memorySink().sink, { archivePath: f2 });
    expect(s3.endState).toBe('interrupted_response');
    expect(s3.userMessageCount).toBe(1);
  });

  it('encodes project folders the way Claude Code does', () => {
    expect(encodeClaudeProjectDir('C:\\work\\flutter\\my_app')).toBe('C--work-flutter-my-app');
  });
});

describe('Codex adapter', () => {
  it('parses rollout records', async () => {
    const file = write('codex/rollout-2026-11-01-abc.jsonl', [
      JSON.stringify({ timestamp: '2026-11-01T10:00:00Z', type: 'session_meta', payload: { id: 'abc', cwd: 'C:\\work\\api', cli_version: '1.0' } }),
      JSON.stringify({ timestamp: '2026-11-01T10:00:01Z', type: 'turn_context', payload: { model: 'gpt-x', cwd: 'C:\\work\\api' } }),
      JSON.stringify({ timestamp: '2026-11-01T10:00:02Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Add rate limiting' }] } }),
      JSON.stringify({ timestamp: '2026-11-01T10:00:03Z', type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', call_id: 'c1', input: '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-x\n+y\n*** End Patch' } }),
      JSON.stringify({ timestamp: '2026-11-01T10:00:04Z', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c1', output: '{"output":"Success","metadata":{"exit_code":0}}' } }),
      JSON.stringify({ timestamp: '2026-11-01T10:00:05Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Rate limiting added.' }] } }),
    ].join('\n'));
    const { sink, fileOps } = memorySink();
    const s = await codexAdapter.parse(discovered(file, 'codex'), sink, { archivePath: file });
    expect(s.cwd).toBe('C:\\work\\api');
    expect(s.userMessageCount).toBe(1);
    expect(s.endState).toBe('completed_turn');
    expect(fileOps).toEqual([expect.objectContaining({ path: 'src/a.ts', op: 'edit', succeeded: true })]);
  });
});

describe('Generic adapter', () => {
  it('imports OpenAI-style JSON and keeps unknown items', async () => {
    const file = write('generic/chat.json', JSON.stringify({ title: 'Chat', messages: [{ role: 'user', content: 'hello there, build me an API' }, { role: 'assistant', content: [{ type: 'text', text: 'Sure' }], tool_calls: [{ id: 'x', function: { name: 'run', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'x', content: 'ok' }, { weird: true }] }));
    const r: unknown[] = [];
    const { sink, events } = memorySink();
    const s = await genericAdapter.parse(discovered(file, 'generic'), sink, { archivePath: file, writeRaw: (rec) => (r.push(rec), { offset: 0, length: 1 }) });
    expect(s.title).toBe('Chat');
    expect(s.userMessageCount).toBe(1);
    expect(s.toolCallCount).toBe(1);
    expect(events.some((e) => e.kind === 'unknown')).toBe(true);
    expect(findItems([1, 2])?.items).toHaveLength(2);
  });
});

describe('git status parsing', () => {
  it('parses porcelain v1 with branch info', () => {
    const r = parseStatus('## main...origin/main [ahead 2, behind 1]\n M src/a.ts\nA  src/b.ts\n D old.ts\nR  x.ts -> y.ts\n?? new file.ts\nUU conflict.ts\n');
    expect(r.branch).toBe('main');
    expect(r.upstream).toBe('origin/main');
    expect([r.ahead, r.behind]).toEqual([2, 1]);
    expect(r.changes.map((c) => c.kind)).toEqual(['modified', 'added', 'deleted', 'renamed', 'untracked', 'conflicted']);
    expect(r.changes[3]).toMatchObject({ path: 'y.ts', origPath: 'x.ts' });
  });
});

describe('search and projects', () => {
  it('builds safe FTS queries from arbitrary input', () => {
    expect(toFtsQuery('login page')).toBe('"login"* "page"*');
    expect(toFtsQuery('a" OR 1=1 --*')).toBe('"a"* "OR"* "1=1"* "--"*');
    expect(toFtsQuery('   ')).toBe('');
  });
  it('folds Claude worktrees into the main repository', () => {
    expect(locateProject('C:\\work\\app\\.claude\\worktrees\\feature-x')).toMatchObject({ root: 'C:\\work\\app', worktree: 'feature-x', basis: 'claude-worktree' });
  });
});
