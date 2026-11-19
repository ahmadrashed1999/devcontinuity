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

describe('AI Coding Wrapped', () => {
  it('parses month and year periods in local time', async () => {
    const { parsePeriod } = await import('../src/server/wrapped');
    const m = parsePeriod('2026-11');
    expect([m.kind, m.start.getMonth(), m.end.getMonth(), m.end.getFullYear()]).toEqual(['month', 10, 11, 2026]);
    expect(parsePeriod('2026-12').end.getFullYear()).toBe(2027);
    expect(parsePeriod('2026').kind).toBe('year');
    expect(parsePeriod('nonsense', new Date(2026, 4, 9)).key).toBe('2026-05');
  });

  it('aggregates sessions, rates, tokens, cost, days, projects and the longest session', async () => {
    const { aggregateWrapped, parsePeriod } = await import('../src/server/wrapped');
    const at = (d: number, h: number) => new Date(2026, 10, d, h);
    const row = (id: string, agent: string, endState: string, d: number, meta: unknown = null, mins = 30, project: string | null = 'shop') => ({ id, agent, title: id, projectName: project, startedAt: new Date(at(d, 10).getTime() - mins * 60_000), endedAt: at(d, 10), endState, userMessageCount: 2, toolCallCount: 5, fileOpCount: 1, providerMeta: meta ? JSON.stringify(meta) : null });
    const s = aggregateWrapped([
      row('a', 'claude-code', 'completed_turn', 3, { usage: { inputTokens: 1000, outputTokens: 200, costUsd: null }, cost: { totalCostUSD: 1.5 } }, 90),
      row('b', 'claude-code', 'api_error', 3),
      row('c', 'codex', 'interrupted_tool', 4, { usage: { inputTokens: 10, outputTokens: 5 } }, 20, 'docs'),
      row('d', 'codex', 'completed_turn', 4, null, 5000),
      row('e', 'cursor', 'empty', 4),
    ], parsePeriod('2026-11'), [{ name: 'Edit', calls: 9 }]);
    expect(s.totals).toMatchObject({ sessions: 4, prompts: 8, toolCalls: 20, agents: 2, projects: 2, activeDays: 2, tokens: 1215, costUsd: 1.5, costSessions: 1 });
    const claude = s.agents.find((a) => a.agent === 'claude-code')!;
    expect([claude.finishRate, claude.errorRate, claude.interruptRate]).toEqual([0.5, 0.5, 0]);
    expect(s.agents.find((a) => a.agent === 'codex')!.costUsd).toBeNull();
    expect(s.topProjects[0]).toEqual({ name: 'shop', sessions: 3, agents: 2 });
    expect(s.longest).toMatchObject({ id: 'd', minutes: 720 });
    expect(s.byWeekday.reduce((a, b) => a + b, 0)).toBe(4);
    expect(s.topTools).toEqual([{ name: 'Edit', calls: 9 }]);
  });
});

describe('agent comparison', () => {
  it('computes rates per agent and says "not enough data" instead of ranking small samples', async () => {
    const { compareAgents } = await import('../src/server/compare');
    const s = (agent: string, endState: string, cost?: number) => ({ agent, endState, userMessageCount: 2, toolCallCount: 6, filesChanged: 3, providerMeta: cost ? JSON.stringify({ usage: { costUsd: cost } }) : null });
    const rows = [
      ...Array.from({ length: 6 }, (_, i) => s('claude-code', i < 3 ? 'completed_turn' : i < 5 ? 'interrupted_tool' : 'api_error', i < 3 ? 1 + i : undefined)),
      s('cursor', 'completed_turn'), s('cursor', 'completed_turn'), s('cursor', 'empty'),
    ];
    const [claude, cursor] = compareAgents(rows);
    expect(claude).toMatchObject({ agent: 'claude-code', sessions: 6, enoughData: true, completionRate: 0.5, toolsPerPrompt: 3, filesPerSession: 3, costPerCompleted: 2, costedSessions: 3 });
    expect(claude.interruptionRate).toBeCloseTo(2 / 6);
    expect(claude.errorRate).toBeCloseTo(1 / 6);
    expect(cursor).toMatchObject({ agent: 'cursor', sessions: 2, enoughData: false, completionRate: null, costPerCompleted: null });
  });
});
