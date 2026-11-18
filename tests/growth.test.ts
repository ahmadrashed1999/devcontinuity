import { describe, expect, it } from 'vitest';
import { demoAllows } from '../src/server/demo';

describe('read-only demo mode', () => {
  it('allows reads of the workspace and refuses every write', () => {
    expect(demoAllows('GET', ['sessions'])).toBe(true);
    expect(demoAllows('GET', ['search'])).toBe(true);
    expect(demoAllows('GET', ['sessions', 'abc', 'events'])).toBe(true);
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(demoAllows(m, ['import'])).toBe(false);
      expect(demoAllows(m, ['live', 'connect'])).toBe(false);
      expect(demoAllows(m, ['launch'])).toBe(false);
      expect(demoAllows(m, ['ask'])).toBe(false);
    }
  });

  it('refuses reads that would describe the host machine or hand out files', () => {
    expect(demoAllows('GET', ['inventory'])).toBe(false);
    expect(demoAllows('GET', ['agents', 'detect'])).toBe(false);
    expect(demoAllows('GET', ['providers'])).toBe(false);
    expect(demoAllows('GET', ['providers', 'x', 'models'])).toBe(false);
    expect(demoAllows('GET', ['backups', 'b1', 'download'])).toBe(false);
    expect(demoAllows('GET', ['projects', 'p1', 'github'])).toBe(false);
  });
});

describe('handoff on limit', () => {
  it('recognises usage, rate and billing limits but not other API errors', async () => {
    const { isLimitEnding } = await import('../src/server/handoff/limit');
    for (const d of ["You've hit your session limit · resets 5pm", 'Claude AI usage limit reached|1731974400', 'Rate limit exceeded (429)', 'insufficient_quota: You exceeded your current quota', 'Your credit balance is too low', 'stream error: 429 Too Many Requests', 'You have reached your weekly limit'])
      expect(isLimitEnding('api_error', d)).toBe(true);
    for (const d of ['Internal server error', 'overloaded_error', 'invalid_request_error: prompt is too long', null]) expect(isLimitEnding('api_error', d)).toBe(false);
    expect(isLimitEnding('completed_turn', 'usage limit')).toBe(false);
  });

  it('offers the preferred fallback first and never the agent that stopped', async () => {
    const { rankTargets } = await import('../src/server/handoff/limit');
    expect(rankTargets('claude-code', 'codex').slice(0, 2)).toEqual(['codex', 'opencode']);
    expect(rankTargets('codex', 'codex')[0]).not.toBe('codex');
    expect(rankTargets('claude-code', 'cursor')[0]).toBe('cursor');
    expect(rankTargets('claude-code', 'claude-code')).not.toContain('claude-code');
  });
});

describe('launching agents on macOS and Linux', () => {
  it('builds a bash script that only contains the agent, the folder and the prompt file', async () => {
    const { buildPosixLaunchScript, shq } = await import('../src/server/agents/launcher');
    expect(shq("o'brien")).toBe(`'o'\\''brien'`);
    const { script } = buildPosixLaunchScript({ agent: 'codex', exe: '/usr/local/bin/codex', kind: 'cli', dir: "/work/o'brien", promptFile: '/data/p.md', platform: 'linux' });
    expect(script).toContain(`cd '/work/o'\\''brien' || exit 1`);
    expect(script).toContain(`'/usr/local/bin/codex' "$p"`);
    expect(script.startsWith('#!/usr/bin/env bash\n')).toBe(true);
    const resume = buildPosixLaunchScript({ agent: 'claude-code', exe: '/bin/claude', kind: 'cli', dir: '/w', promptFile: '/p.md', resumeId: 'abc' });
    expect(resume.script).toContain(`'/bin/claude' --resume 'abc'`);
    expect(() => buildPosixLaunchScript({ agent: 'cursor', exe: null, kind: null, dir: '/w', promptFile: '/p.md' })).toThrow(/not found/);
  });

  it('opens Terminal or iTerm on macOS and the first available terminal on Linux', async () => {
    const { posixTerminalCommand } = await import('../src/server/agents/launcher');
    expect(posixTerminalCommand('darwin', '/x.command', '/w', () => null, () => false)).toEqual({ cmd: 'open', args: ['-a', 'Terminal', '/x.command'] });
    expect(posixTerminalCommand('darwin', '/x.command', '/w', () => null, () => true).args[1]).toBe('iTerm');
    const which = (n: string) => (n === 'konsole' ? '/usr/bin/konsole' : null);
    expect(posixTerminalCommand('linux', '/x.sh', '/w', which)).toEqual({ cmd: '/usr/bin/konsole', args: ['--workdir', '/w', '-e', 'bash', '/x.sh'] });
    expect(() => posixTerminalCommand('linux', '/x.sh', '/w', () => null)).toThrow(/No terminal/);
  });
});

describe('shared memory across agents', () => {
  it('adds the project_context / log_summary instruction to the rules block only when asked', async () => {
    const { mergeBlock, rulesBody, START } = await import('../src/server/rules');
    expect(rulesBody('- Use pnpm', false)).toBe('- Use pnpm');
    const both = rulesBody('- Use pnpm', true);
    expect(both).toContain('- Use pnpm');
    expect(both).toContain('`project_context`');
    expect(both).toContain('`log_summary`');
    expect(rulesBody('', true)).toContain('Shared memory');
    expect(rulesBody(null, false)).toBe('');
    expect(mergeBlock('# Mine\n', rulesBody(null, true)).startsWith(`# Mine\n\n${START}\n## Shared memory`)).toBe(true);
  });
});
