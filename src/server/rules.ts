import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findAgent } from './agents/binaries';
import { audit } from './audit';
import { dataPath, ensureDir, timestampSlug } from './config';
import { prisma } from './db';
import { PathError, safeFileName } from './security/paths';
import { redactSecrets } from './security/redact';

/**
 * One rules file → every agent. The owner writes project rules once; DevContinuity maintains a
 * clearly marked block inside CLAUDE.md, AGENTS.md (Codex/OpenCode) and a Cursor rules file.
 * Text outside the block is never changed, and every file is backed up before it is touched.
 */

export const START = '<!-- devcontinuity:rules:start (managed by DevContinuity; edit in the app) -->';
export const END = '<!-- devcontinuity:rules:end -->';
export const TARGETS = [
  { id: 'claude', file: 'CLAUDE.md', label: 'Claude Code' },
  { id: 'agents', file: 'AGENTS.md', label: 'Codex / OpenCode / others (AGENTS.md)' },
  { id: 'cursor', file: path.join('.cursor', 'rules', 'devcontinuity.mdc'), label: 'Cursor' },
  { id: 'gemini', file: 'GEMINI.md', label: 'Gemini CLI' },
] as const;

export function mergeBlock(existing: string | null, rules: string, cursor = false): string {
  const block = `${START}\n${rules.trim()}\n${END}`;
  if (existing == null || !existing.trim()) return cursor ? `---\ndescription: Project rules managed by DevContinuity\nalwaysApply: true\n---\n\n${block}\n` : `${block}\n`;
  const s = existing.indexOf(START);
  const e = existing.indexOf(END);
  if (s !== -1 && e > s) return existing.slice(0, s) + block + existing.slice(e + END.length);
  return `${existing.replace(/\s*$/, '')}\n\n${block}\n`;
}

export async function importExistingRules(projectId: string): Promise<string> {
  const p = await prisma().project.findUnique({ where: { id: projectId } });
  if (!p?.pathVerified) throw new PathError('Project folder unknown.');
  const parts: string[] = [];
  for (const t of TARGETS) {
    const f = path.join(p.rootPath, t.file);
    if (!fs.existsSync(f)) continue;
    let c = fs.readFileSync(f, 'utf8');
    const s = c.indexOf(START);
    const e = c.indexOf(END);
    if (s !== -1 && e > s) c = c.slice(s + START.length, e);
    if (c.trim()) parts.push(`<!-- from ${t.file} -->\n${c.trim()}`);
  }
  return redactSecrets(parts.join('\n\n'));
}

export async function previewRules(projectId: string) {
  const p = await prisma().project.findUnique({ where: { id: projectId } });
  if (!p?.pathVerified || !fs.existsSync(p.rootPath)) throw new PathError('The project folder does not exist on this machine.');
  return TARGETS.map((t) => {
    const f = path.join(p.rootPath, t.file);
    const existing = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
    const managed = existing?.includes(START) ?? false;
    return { id: t.id, label: t.label, file: t.file, exists: existing != null, managed, action: existing == null ? 'create' : managed ? 'update block' : 'append block' };
  });
}

/** Optional instruction that makes agents share memory through DevContinuity's MCP tools. */
export const SHARED_MEMORY_RULE = [
  '## Shared memory (DevContinuity)',
  'Other AI agents also work in this project. If the DevContinuity MCP server is available:',
  '- At the start of a task, call `project_context` with your working directory and read what the other agents did, their open tasks and last errors. Do not redo or undo their work without a reason.',
  '- When you finish (or stop with work left), call `log_summary` with what you did, the files you changed and the next steps.',
].join('\n');

/** The text written inside the managed block. */
export function rulesBody(rules: string | null | undefined, sharedMemory: boolean): string {
  return [rules?.trim(), sharedMemory ? SHARED_MEMORY_RULE : ''].filter(Boolean).join('\n\n');
}

export async function syncRules(projectId: string, targetIds: string[], opts: { sharedMemory?: boolean } = {}): Promise<{ file: string; action: string; backup?: string }[]> {
  const p = await prisma().project.findUnique({ where: { id: projectId } });
  if (!p?.pathVerified || !fs.existsSync(p.rootPath)) throw new PathError('The project folder does not exist on this machine.');
  const body = rulesBody(p.rules, !!opts.sharedMemory);
  if (!body) throw new PathError('Write the project rules first, or include the shared-memory instruction.');
  const backupDir = path.join(dataPath('backups'), 'rules', safeFileName(p.slug), timestampSlug());
  const out: { file: string; action: string; backup?: string }[] = [];
  for (const t of TARGETS.filter((x) => targetIds.includes(x.id))) {
    const f = path.join(p.rootPath, t.file);
    const existing = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
    let backup: string | undefined;
    if (existing != null) {
      backup = path.join(ensureDir(backupDir), safeFileName(t.file.replace(/[\\/]/g, '__')));
      fs.writeFileSync(backup, existing, 'utf8');
    }
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, mergeBlock(existing, body, t.id === 'cursor'), 'utf8');
    out.push({ file: f, action: existing == null ? 'created' : existing.includes(START) ? 'updated block' : 'appended block', backup });
  }
  await audit('owner', 'rules.sync', projectId, out);
  return out;
}

// ---------------- MCP servers & skills across agents ----------------
export interface McpEntry {
  agent: string;
  name: string;
  command: string;
}

function readText(f: string): string | null {
  try {
    return fs.readFileSync(f, 'utf8');
  } catch {
    return null;
  }
}

function claudeMcpList(exe: string): Promise<McpEntry[]> {
  return new Promise((resolve) => {
    execFile(exe, ['mcp', 'list'], { windowsHide: true, timeout: 20_000 }, (err, stdout) => {
      if (err) return resolve([]);
      resolve(
        String(stdout)
          .split('\n')
          .map((l) => l.match(/^([\w.@-]+):\s+(.+?)(?:\s+-\s+.*)?$/))
          .filter((m): m is RegExpMatchArray => !!m)
          .map((m) => ({ agent: 'claude-code', name: m[1], command: redactSecrets(m[2]).slice(0, 200) })),
      );
    });
  });
}

export async function mcpInventory(): Promise<{ servers: McpEntry[]; notes: string[] }> {
  const home = os.homedir();
  const servers: McpEntry[] = [];
  const notes: string[] = [];
  const toml = readText(path.join(home, '.codex', 'config.toml'));
  if (toml) {
    const re = /^\[mcp_servers\.("?)([\w.@-]+)\1\]\s*$([\s\S]*?)(?=^\[|$(?![\s\S]))/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(toml))) {
      const body = m[3];
      const cmd = body.match(/^command\s*=\s*"([^"]*)"/m)?.[1] ?? body.match(/^url\s*=\s*"([^"]*)"/m)?.[1] ?? '';
      const args = body.match(/^args\s*=\s*\[([^\]]*)\]/m)?.[1]?.replace(/"/g, '').replace(/\s*,\s*/g, ' ') ?? '';
      servers.push({ agent: 'codex', name: m[2], command: redactSecrets(`${cmd} ${args}`.trim()).slice(0, 200) });
    }
  }
  for (const f of [path.join(home, '.config', 'opencode', 'opencode.json'), path.join(home, '.config', 'opencode', 'opencode.jsonc')]) {
    const raw = readText(f);
    if (!raw) continue;
    try {
      const j = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/,(\s*[}\]])/g, '$1')) as { mcp?: Record<string, { command?: string[] | string; url?: string }> };
      for (const [name, v] of Object.entries(j.mcp ?? {})) servers.push({ agent: 'opencode', name, command: redactSecrets(Array.isArray(v.command) ? v.command.join(' ') : (v.command ?? v.url ?? '')).slice(0, 200) });
    } catch {
      notes.push(`Could not parse ${f}.`);
    }
  }
  const claude = await findAgent('claude-code');
  if (claude.path) servers.push(...(await claudeMcpList(claude.path)));
  else notes.push('Claude Code CLI not found; its MCP servers cannot be listed.');
  return { servers, notes };
}

export function mcpSnippets(name: string, command: string, args: string[]) {
  const all = [command, ...args];
  return {
    'claude-code': `claude mcp add ${name} -- ${all.join(' ')}`,
    codex: `[mcp_servers.${name}]\ncommand = ${JSON.stringify(command)}\nargs = ${JSON.stringify(args)}`,
    opencode: JSON.stringify({ mcp: { [name]: { type: 'local', command: all } } }, null, 2),
    cursor: JSON.stringify({ mcpServers: { [name]: { command, args } } }, null, 2),
  };
}

export const SKILL_DIRS = () => {
  const home = os.homedir();
  return [
    { agent: 'claude-code', dir: path.join(home, '.claude', 'skills') },
    { agent: 'shared (.agents)', dir: path.join(home, '.agents', 'skills') },
    { agent: 'codex', dir: path.join(home, '.codex', 'skills') },
    { agent: 'opencode', dir: path.join(home, '.config', 'opencode', 'skills') },
  ];
};

export function skillInventory() {
  return SKILL_DIRS().map((d) => ({ ...d, skills: fs.existsSync(d.dir) ? fs.readdirSync(d.dir, { withFileTypes: true }).filter((e) => e.isDirectory() && fs.existsSync(path.join(d.dir, e.name, 'SKILL.md'))).map((e) => e.name) : [] }));
}

/** Copies a skill folder to another agent's skills directory. Never overwrites an existing skill. */
export async function copySkill(fromAgent: string, skill: string, toAgent: string) {
  const dirs = SKILL_DIRS();
  const from = dirs.find((d) => d.agent === fromAgent);
  const to = dirs.find((d) => d.agent === toAgent);
  if (!from || !to || !/^[\w.-]+$/.test(skill)) throw new PathError('Invalid skill or agent.');
  const src = path.join(from.dir, skill);
  const dst = path.join(to.dir, skill);
  if (!fs.existsSync(path.join(src, 'SKILL.md'))) throw new PathError('Skill not found.');
  if (fs.existsSync(dst)) throw new PathError(`${toAgent} already has a skill named ${skill}. Nothing was overwritten.`);
  fs.cpSync(src, dst, { recursive: true, errorOnExist: true, force: false });
  await audit('owner', 'skill.copy', skill, { fromAgent, toAgent });
  return dst;
}
