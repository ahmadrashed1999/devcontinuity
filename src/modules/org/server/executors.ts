import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { findAgent } from '@/server/agents/binaries';
import { redactSecrets } from '@/server/security/redact';

/**
 * CLI executors: delegate a task to Claude Code, Codex or OpenCode running headless inside the
 * sandbox worktree. The prompt is sent on stdin (no shell quoting of task text). Whatever account
 * the CLI is signed in to is used, so when the Claude account is back, switching roles to
 * "claude-code" is all that is needed.
 */

export const CLI_EXECUTORS = ['claude-code', 'codex', 'opencode'] as const;
export type CliExecutor = (typeof CLI_EXECUTORS)[number];

function argsFor(exec: CliExecutor, cwd: string, outFile: string): string[] {
  switch (exec) {
    case 'claude-code':
      return ['-p', '--permission-mode', 'acceptEdits', '--output-format', 'text'];
    case 'codex':
      return ['exec', '-C', cwd, '-s', 'workspace-write', '--skip-git-repo-check', '-o', outFile, '-'];
    case 'opencode':
      return ['run'];
  }
}

export async function runCliExecutor(exec: CliExecutor, cwd: string, prompt: string, log: (l: string) => void, signal?: AbortSignal): Promise<{ ok: boolean; output: string }> {
  const bin = await findAgent(exec);
  if (!bin.path || bin.kind !== 'cli') throw new Error(`${exec} CLI is not installed or not found (Settings → Agents). The desktop app cannot run headless tasks.`);
  const outFile = path.join(cwd, '..', `.${path.basename(cwd)}-last-message.txt`);
  const args = argsFor(exec, cwd, outFile);
  const isPs1 = /\.ps1$/i.test(bin.path);
  const isCmd = /\.cmd$/i.test(bin.path);
  const [cmd, full] = isPs1 ? ['powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', bin.path, ...args]] : isCmd ? ['cmd.exe', ['/d', '/s', '/c', bin.path, ...args]] : [bin.path, args];
  log(`starting ${exec} headless in ${cwd}`);
  return new Promise((resolve) => {
    const child = spawn(cmd, full as string[], { cwd, windowsHide: true, env: { ...process.env, CI: '1', NO_COLOR: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    const add = (b: Buffer) => {
      const s = b.toString('utf8');
      out += s;
      if (out.length > 300_000) out = out.slice(-150_000);
      for (const line of s.split('\n').filter((l) => l.trim()).slice(0, 5)) log(`${exec}: ${redactSecrets(line).slice(0, 300)}`);
    };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    child.stdin.write(prompt);
    child.stdin.end();
    const timer = setTimeout(() => child.kill(), 45 * 60_000);
    signal?.addEventListener('abort', () => child.kill());
    child.on('close', (code) => {
      clearTimeout(timer);
      let final = out;
      if (exec === 'codex' && fs.existsSync(outFile)) {
        final = `${fs.readFileSync(outFile, 'utf8')}\n\n--- log tail ---\n${out.slice(-4000)}`;
        fs.rmSync(outFile, { force: true });
      }
      resolve({ ok: code === 0, output: redactSecrets(final).slice(-40_000) });
    });
    child.on('error', (e) => resolve({ ok: false, output: e.message }));
  });
}
