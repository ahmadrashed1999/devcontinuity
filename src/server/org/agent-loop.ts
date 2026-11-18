import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { CallContext, Msg, Part, ToolDef, chat } from '../ai/gateway';
import { getSetting } from '../db';
import { safeJoin } from '../security/paths';
import { redactSecrets } from '../security/redact';
import { validateCommand } from '../verify/runner';

/**
 * Built-in coding agent used by "api" executors. It can only see and change files inside its own
 * sandbox worktree, and can only run allow-listed test/build commands when the role is L2+.
 */

const TOOLS: ToolDef[] = [
  { name: 'list_dir', description: 'List files and folders at a path relative to the project root.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'read_file', description: 'Read a text file (relative path). Optional 1-based line range.', parameters: { type: 'object', properties: { path: { type: 'string' }, start_line: { type: 'number' }, end_line: { type: 'number' } }, required: ['path'] } },
  { name: 'search', description: 'Search file contents with a regular expression. Returns matching lines with paths.', parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string', description: 'optional sub-folder' } }, required: ['pattern'] } },
  { name: 'write_file', description: 'Create or replace a file with the given content.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
  { name: 'edit_file', description: 'Replace an exact unique snippet in a file.', parameters: { type: 'object', properties: { path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } }, required: ['path', 'old_string', 'new_string'] } },
  { name: 'run_command', description: 'Run an allowed test/build/lint command in the project root (only if permitted for your role).', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
  { name: 'finish', description: 'Finish the task. status=done when acceptance criteria are met, blocked when you cannot proceed.', parameters: { type: 'object', properties: { status: { type: 'string', enum: ['done', 'blocked'] }, summary: { type: 'string' }, notes: { type: 'string' } }, required: ['status', 'summary'] } },
];

const SKIP_DIRS = new Set(['.git', 'node_modules', 'vendor', 'build', '.dart_tool', '.next', 'dist', 'Library', 'Temp', 'obj', 'bin', '.gradle', 'Pods']);

function resolveIn(root: string, rel: string): string {
  const p = safeJoin(root, rel.replace(/^[\\/]+/, '') || '.');
  if (/[\\/]\.git([\\/]|$)/.test(p)) throw new Error('Access to .git is not allowed.');
  return p;
}

function searchJs(root: string, re: RegExp, sub: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 12 || out.length >= 80) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (out.length >= 80) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(full, depth + 1);
      } else if (e.isFile() && fs.statSync(full).size < 1_000_000) {
        const lines = fs.readFileSync(full, 'utf8').split('\n');
        lines.forEach((l, i) => {
          if (out.length < 80 && re.test(l)) out.push(`${path.relative(root, full)}:${i + 1}: ${l.trim().slice(0, 200)}`);
        });
      }
    }
  };
  walk(resolveIn(root, sub || '.'), 0);
  return out;
}

function runCmd(cwd: string, cmd: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve) => {
    const child = execFile('cmd.exe', ['/d', '/s', '/c', cmd], { cwd, windowsHide: true, timeout: 10 * 60_000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, CI: '1' } }, (err, stdout, stderr) => {
      const code = err ? ((err as { code?: number }).code ?? 1) : 0;
      resolve(`exit code ${code}\n${redactSecrets(`${stdout}\n${stderr}`).slice(-12_000)}`);
    });
    signal?.addEventListener('abort', () => child.kill());
  });
}

export interface AgentLoopInput {
  root: string;
  system: string;
  task: string;
  autonomy: string;
  allowedCommands: string[];
  route: string;
  ctx: CallContext;
  log: (line: string) => void;
  signal?: AbortSignal;
}

export interface AgentLoopResult {
  status: 'done' | 'blocked' | 'incomplete';
  summary: string;
  notes?: string;
  steps: number;
  costUsd: number;
  filesChanged: string[];
}

export async function runAgentLoop(i: AgentLoopInput): Promise<AgentLoopResult> {
  const maxSteps = await getSetting<number>('agentMaxSteps', 40);
  const capUsd = await getSetting<number>('taskCostCapUsd', 2);
  const messages: Msg[] = [{ role: 'user', content: i.task }];
  const changed = new Set<string>();
  let cost = 0;
  const tools = i.autonomy === 'L0' ? TOOLS.filter((t) => ['list_dir', 'read_file', 'search', 'finish'].includes(t.name)) : i.autonomy === 'L1' ? TOOLS.filter((t) => t.name !== 'run_command') : TOOLS;
  for (let step = 1; step <= maxSteps; step++) {
    if (i.signal?.aborted) return { status: 'incomplete', summary: 'Stopped by the kill switch or the owner.', steps: step, costUsd: cost, filesChanged: [...changed] };
    const r = await chat({ job: 'worker', route: i.route, system: i.system, messages, tools, maxTokens: 8000, ctx: i.ctx, signal: i.signal });
    cost += r.costUsd ?? 0;
    const parts: Part[] = [];
    if (r.text) parts.push({ type: 'text', text: r.text });
    for (const c of r.toolCalls) parts.push({ type: 'tool_call', id: c.id, name: c.name, input: c.input });
    messages.push({ role: 'assistant', content: parts.length ? parts : r.text || '(no output)' });
    if (r.text) i.log(`thought: ${r.text.slice(0, 600)}`);
    if (!r.toolCalls.length) {
      if (r.stop === 'max_tokens') {
        messages.push({ role: 'user', content: 'Your output was cut off. Continue, using tools for any file changes, and call finish when done.' });
        continue;
      }
      return { status: 'incomplete', summary: r.text.slice(0, 2000) || 'The agent stopped without calling finish.', steps: step, costUsd: cost, filesChanged: [...changed] };
    }
    const results: Part[] = [];
    for (const call of r.toolCalls) {
      const a = call.input as Record<string, string | number>;
      let out: string;
      let isError = false;
      try {
        switch (call.name) {
          case 'finish':
            i.log(`finish: ${a.status} — ${String(a.summary).slice(0, 400)}`);
            return { status: a.status === 'done' ? 'done' : 'blocked', summary: String(a.summary ?? ''), notes: a.notes ? String(a.notes) : undefined, steps: step, costUsd: cost, filesChanged: [...changed] };
          case 'list_dir': {
            const p = resolveIn(i.root, String(a.path ?? '.'));
            out = fs.readdirSync(p, { withFileTypes: true }).filter((e) => !SKIP_DIRS.has(e.name)).map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).slice(0, 300).join('\n');
            break;
          }
          case 'read_file': {
            const p = resolveIn(i.root, String(a.path));
            const lines = fs.readFileSync(p, 'utf8').split('\n');
            const s = Math.max(1, Number(a.start_line) || 1);
            const e = Math.min(lines.length, Number(a.end_line) || s + 399);
            out = `${lines.slice(s - 1, e).map((l, k) => `${s + k}: ${l}`).join('\n')}${e < lines.length ? `\n… (${lines.length} lines total)` : ''}`;
            break;
          }
          case 'search': {
            const re = new RegExp(String(a.pattern), 'i');
            out = searchJs(i.root, re, String(a.path ?? '')).join('\n') || 'No matches.';
            break;
          }
          case 'write_file': {
            const p = resolveIn(i.root, String(a.path));
            fs.mkdirSync(path.dirname(p), { recursive: true });
            fs.writeFileSync(p, String(a.content ?? ''), 'utf8');
            changed.add(path.relative(i.root, p));
            out = `Wrote ${path.relative(i.root, p)}.`;
            break;
          }
          case 'edit_file': {
            const p = resolveIn(i.root, String(a.path));
            const content = fs.readFileSync(p, 'utf8');
            const oldS = String(a.old_string);
            const n = content.split(oldS).length - 1;
            if (n !== 1) throw new Error(n === 0 ? 'old_string not found.' : `old_string occurs ${n} times; include more context.`);
            fs.writeFileSync(p, content.replace(oldS, () => String(a.new_string)), 'utf8');
            changed.add(path.relative(i.root, p));
            out = `Edited ${path.relative(i.root, p)}.`;
            break;
          }
          case 'run_command': {
            if (i.autonomy !== 'L2' && i.autonomy !== 'L3') throw new Error('Your role is not allowed to run commands.');
            const cmd = validateCommand(String(a.command));
            if (i.allowedCommands.length && !i.allowedCommands.some((p) => cmd.toLowerCase().startsWith(p.toLowerCase()))) throw new Error(`Command not in this role's allow-list: ${i.allowedCommands.join(', ')}`);
            i.log(`run: ${cmd}`);
            out = await runCmd(i.root, cmd, i.signal);
            break;
          }
          default:
            throw new Error(`Unknown tool ${call.name}`);
        }
      } catch (e) {
        isError = true;
        out = (e as Error).message;
      }
      i.log(`${call.name}(${JSON.stringify(a).slice(0, 160)}) → ${isError ? 'ERROR ' : ''}${out.slice(0, 200).replace(/\n/g, ' ')}`);
      results.push({ type: 'tool_result', id: call.id, content: out.slice(0, 20_000), isError });
    }
    messages.push({ role: 'user', content: results });
    if (cost >= capUsd) return { status: 'incomplete', summary: `Stopped at the per-task cost cap ($${capUsd}).`, steps: step, costUsd: cost, filesChanged: [...changed] };
  }
  return { status: 'incomplete', summary: `Reached the step limit (${maxSteps}).`, steps: maxSteps, costUsd: cost, filesChanged: [...changed] };
}
