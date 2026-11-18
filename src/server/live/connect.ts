import fs from 'node:fs';
import path from 'node:path';
import { apiToken, dataDir, dataPath, ensureDir, homeDir, timestampSlug } from '../config';
import { listLiveStreams } from './store';

/**
 * "Connect" an agent to DevContinuity: register the hook recorder, the MCP server (so the agent can
 * log summaries and read history) and, optionally, OpenTelemetry export. Every change is shown
 * first; applying it backs the original file up to data/backups/agent-config/ and only ever adds
 * or removes DevContinuity's own entries.
 */

export const CONNECT_AGENTS = ['gemini-cli', 'cursor', 'windsurf', 'antigravity', 'claude-code', 'codex'] as const;
export type ConnectAgent = (typeof CONNECT_AGENTS)[number];

export interface ConnectChange {
  file: string;
  description: string;
  before: string | null;
  after: string | null;
}

export interface ConnectPlan {
  agent: ConnectAgent;
  label: string;
  remove: boolean;
  changes: ConnectChange[];
  /** Commands the user runs themselves (CLIs that own their config). */
  commands: string[];
  notes: string[];
}

const LABELS: Record<ConnectAgent, string> = { 'gemini-cli': 'Gemini CLI', cursor: 'Cursor', windsurf: 'Windsurf', antigravity: 'Antigravity', 'claude-code': 'Claude Code', codex: 'Codex' };
/** Our hook / MCP entries, whether they point at a checkout or at the copies an npm installation keeps in its data folder. */
const HOOK_MARKS = ['scripts/hook.mjs', 'devcontinuity-hook.mjs'];
const MCP_MARKS = ['scripts/mcp.ts', 'devcontinuity-mcp.mjs'];
const PORT = Number(process.env.PORT) || 3210;

type Rec = Record<string, unknown>;

export function appRoot(): string {
  const root = process.env.DEVCONTINUITY_APP_ROOT?.trim() || process.cwd();
  if (!fs.existsSync(path.join(root, 'scripts', 'hook.mjs'))) throw new Error(`DevContinuity scripts not found under ${root}. Run this from the DevContinuity folder (or use "npx devcontinuity").`);
  return root;
}

/** Installed from npm/npx: the package folder can disappear (npx cache), so agents get stable copies in the data folder. */
export const isPackagedInstall = () => process.env.DEVCONTINUITY_PACKAGED === '1';

const fwd = (p: string) => p.replace(/\\/g, '/');

/** tsx's CLI, wherever npm put it (inside the checkout, or hoisted next to the package). */
function tsxCli(root: string): string {
  for (const p of [path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(root, '..', 'tsx', 'dist', 'cli.mjs')]) if (fs.existsSync(p)) return p;
  return path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
}

/** Source of <data>/bin/devcontinuity-mcp.mjs: runs this installation's MCP server, or "npx devcontinuity mcp" once it is gone. */
export function mcpLauncher(root: string, data: string, tsx: string): string {
  return `#!/usr/bin/env node
// Written by DevContinuity ("connect"). Starts its MCP server for this data folder.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const APP_ROOT = ${JSON.stringify(root)};
const TSX = ${JSON.stringify(tsx)};
const env = { ...process.env, DEVCONTINUITY_DATA_DIR: process.env.DEVCONTINUITY_DATA_DIR || ${JSON.stringify(data)}, DEVCONTINUITY_PACKAGED: '1' };
const local = fs.existsSync(path.join(APP_ROOT, 'scripts', 'mcp.ts')) && fs.existsSync(TSX);
const win = process.platform === 'win32';
const child = local
  ? spawn(process.execPath, [TSX, path.join(APP_ROOT, 'scripts', 'mcp.ts')], { stdio: 'inherit', env })
  : spawn(win ? 'npx.cmd' : 'npx', ['-y', 'devcontinuity', 'mcp'], { stdio: 'inherit', env, shell: win });
child.on('exit', (code) => process.exit(code ?? 0));
`;
}

/**
 * Writes <data>/bin/devcontinuity-hook.mjs (the dependency-free hook recorder, pinned to this data
 * folder) and <data>/bin/devcontinuity-mcp.mjs. Rewritten on every connect so they follow upgrades.
 */
export function writeStableEntryPoints(): { hook: string; mcp: string } {
  const root = appRoot();
  const dir = ensureDir(path.join(dataDir(), 'bin'));
  const hook = path.join(dir, 'devcontinuity-hook.mjs');
  const mcp = path.join(dir, 'devcontinuity-mcp.mjs');
  const src = fs.readFileSync(path.join(root, 'scripts', 'hook.mjs'), 'utf8');
  fs.writeFileSync(hook, src.replace('const INSTALLED_DATA_DIR = null;', `const INSTALLED_DATA_DIR = ${JSON.stringify(dataDir())};`), 'utf8');
  fs.writeFileSync(mcp, mcpLauncher(root, dataDir(), tsxCli(root)), 'utf8');
  return { hook, mcp };
}

export function hookCommand(agent: string): string {
  if (isPackagedInstall()) return `node "${fwd(writeStableEntryPoints().hook)}" ${agent}`;
  return `node "${fwd(path.join(appRoot(), 'scripts', 'hook.mjs'))}" ${agent}`;
}

export function mcpServer(): { command: string; args: string[] } {
  if (isPackagedInstall()) return { command: 'node', args: [fwd(writeStableEntryPoints().mcp)] };
  return { command: 'node', args: [fwd(tsxCli(appRoot())), fwd(path.join(appRoot(), 'scripts', 'mcp.ts'))] };
}
const otlpBase = () => `http://localhost:${PORT}/api/otlp`;

function configPaths() {
  const home = homeDir();
  const claude = process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(home, '.claude');
  const codex = process.env.CODEX_HOME?.trim() || path.join(home, '.codex');
  return {
    claudeSettings: path.join(claude, 'settings.json'),
    codexConfig: path.join(codex, 'config.toml'),
    geminiSettings: path.join(home, '.gemini', 'settings.json'),
    cursorHooks: path.join(home, '.cursor', 'hooks.json'),
    cursorMcp: path.join(home, '.cursor', 'mcp.json'),
    windsurfHooks: path.join(home, '.codeium', 'windsurf', 'hooks.json'),
    windsurfMcp: path.join(home, '.codeium', 'windsurf', 'mcp_config.json'),
    antigravityMcp: path.join(home, '.gemini', 'antigravity', 'mcp_config.json'),
  };
}

function read(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** JSON with comments and trailing commas tolerated (VS Code-style config files). */
function parseConfig(text: string | null, file: string): Rec {
  if (text == null || !text.trim()) return {};
  try {
    return JSON.parse(text.replace(/^﻿/, '')) as Rec;
  } catch {
    try {
      return JSON.parse(text.replace(/^﻿/, '').replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/,(\s*[}\]])/g, '$1')) as Rec;
    } catch (e) {
      throw new Error(`${file} is not valid JSON (${(e as Error).message}); fix it or edit it by hand.`);
    }
  }
}

const isOurs = (v: unknown) => {
  const text = JSON.stringify(v ?? '');
  return HOOK_MARKS.some((m) => text.includes(m));
};

/** Claude Code / Gemini CLI layout: hooks[event] = [{ matcher?, hooks: [{ type, command }] }]. */
function setNestedHooks(cfg: Rec, events: string[], command: string, remove: boolean, toolEvents: Set<string>) {
  const hooks = ((cfg.hooks as Rec | undefined) ??= {}) as Rec;
  for (const ev of Object.keys(hooks)) {
    const list = Array.isArray(hooks[ev]) ? (hooks[ev] as Rec[]) : [];
    const kept = list.map((g) => ({ ...g, hooks: Array.isArray(g.hooks) ? (g.hooks as unknown[]).filter((h) => !isOurs(h)) : g.hooks })).filter((g) => !Array.isArray(g.hooks) || g.hooks.length > 0);
    if (kept.length) hooks[ev] = kept;
    else delete hooks[ev];
  }
  if (!remove) {
    for (const ev of events) {
      const entry: Rec = { hooks: [{ name: 'devcontinuity', type: 'command', command, timeout: 5000 }] };
      if (toolEvents.has(ev)) entry.matcher = '*';
      hooks[ev] = [...((hooks[ev] as Rec[] | undefined) ?? []), entry];
    }
  }
  if (Object.keys(hooks).length === 0) delete cfg.hooks;
}

/** Cursor / Windsurf layout: hooks[event] = [{ command, ... }]. */
function setFlatHooks(cfg: Rec, events: string[], entry: Rec, remove: boolean) {
  const hooks = ((cfg.hooks as Rec | undefined) ??= {}) as Rec;
  for (const ev of Object.keys(hooks)) {
    const kept = (Array.isArray(hooks[ev]) ? (hooks[ev] as unknown[]) : []).filter((h) => !isOurs(h));
    if (kept.length) hooks[ev] = kept;
    else delete hooks[ev];
  }
  if (!remove) for (const ev of events) hooks[ev] = [...((hooks[ev] as unknown[] | undefined) ?? []), entry];
}

function setMcp(cfg: Rec, remove: boolean, key = 'mcpServers') {
  const servers = ((cfg[key] as Rec | undefined) ??= {}) as Rec;
  if (remove) delete servers.devcontinuity;
  else servers.devcontinuity = mcpServer();
  if (Object.keys(servers).length === 0) delete cfg[key];
}

function jsonChange(file: string, description: string, mutate: (cfg: Rec) => void): ConnectChange | null {
  const before = read(file);
  const cfg = parseConfig(before, file);
  mutate(cfg);
  const after = `${JSON.stringify(cfg, null, 2)}\n`;
  if (before != null && JSON.stringify(parseConfig(before, file)) === JSON.stringify(cfg)) return null;
  return { file, description, before, after };
}

function tomlBlock(text: string, header: string): RegExp {
  const h = header.replace(/[.[\]]/g, (c) => `\\${c}`);
  return new RegExp(`^\\[${h}\\][^\\n]*\\n(?:(?!^\\[).*(?:\\n|$))*`, 'm');
}

export function planConnect(agent: ConnectAgent, opts: { telemetry?: boolean; remove?: boolean } = {}): ConnectPlan {
  const remove = !!opts.remove;
  const p = configPaths();
  const plan: ConnectPlan = { agent, label: LABELS[agent], remove, changes: [], commands: [], notes: [] };
  const push = (c: ConnectChange | null) => {
    if (c) plan.changes.push(c);
  };
  const mcp = mcpServer();

  switch (agent) {
    case 'gemini-cli': {
      const events = ['SessionStart', 'BeforeAgent', 'AfterAgent', 'BeforeTool', 'AfterTool', 'Notification', 'SessionEnd'];
      push(
        jsonChange(p.geminiSettings, remove ? 'Remove DevContinuity hooks, MCP server and telemetry' : `Record ${events.join(', ')} hooks and add the DevContinuity MCP server`, (cfg) => {
          setNestedHooks(cfg, events, hookCommand('gemini-cli'), remove, new Set(['BeforeTool', 'AfterTool']));
          setMcp(cfg, remove);
          const tel = cfg.telemetry as Rec | undefined;
          if (remove && tel && String(tel.otlpEndpoint ?? '').startsWith(otlpBase())) delete cfg.telemetry;
          if (!remove && opts.telemetry) cfg.telemetry = { ...(tel ?? {}), enabled: true, target: 'local', otlpEndpoint: `${otlpBase()}/t/${apiToken()}`, otlpProtocol: 'http', logPrompts: true };
        }),
      );
      plan.notes.push('Hooks need a recent Gemini CLI. Run /hooks inside Gemini CLI to confirm they are listed.');
      if (opts.telemetry) plan.notes.push('Telemetry adds token usage. Its endpoint URL contains your local DevContinuity token; it is only accepted from this PC.');
      break;
    }
    case 'cursor': {
      const events = ['beforeSubmitPrompt', 'afterAgentResponse', 'afterAgentThought', 'afterShellExecution', 'afterMCPExecution', 'afterFileEdit', 'stop'];
      push(
        jsonChange(p.cursorHooks, remove ? 'Remove DevContinuity hooks' : `Record ${events.join(', ')}`, (cfg) => {
          cfg.version ??= 1;
          setFlatHooks(cfg, events, { command: hookCommand('cursor') }, remove);
        }),
      );
      push(jsonChange(p.cursorMcp, remove ? 'Remove the DevContinuity MCP server' : 'Add the DevContinuity MCP server', (cfg) => setMcp(cfg, remove)));
      plan.notes.push('Restart Cursor after connecting. Hooks need Cursor 1.7 or newer.');
      break;
    }
    case 'windsurf': {
      const events = ['pre_user_prompt', 'post_cascade_response', 'post_read_code', 'post_write_code', 'post_run_command', 'post_mcp_tool_use'];
      push(jsonChange(p.windsurfHooks, remove ? 'Remove DevContinuity hooks' : `Record ${events.join(', ')}`, (cfg) => setFlatHooks(cfg, events, { command: hookCommand('windsurf'), show_output: false }, remove)));
      push(jsonChange(p.windsurfMcp, remove ? 'Remove the DevContinuity MCP server' : 'Add the DevContinuity MCP server', (cfg) => setMcp(cfg, remove)));
      plan.notes.push('Windsurf stores its own conversations encrypted, so hooks are the only way to log them. Restart Windsurf after connecting.');
      break;
    }
    case 'antigravity': {
      push(jsonChange(p.antigravityMcp, remove ? 'Remove the DevContinuity MCP server' : 'Add the DevContinuity MCP server', (cfg) => setMcp(cfg, remove)));
      plan.notes.push('Antigravity conversations are already imported from its own index. The MCP server lets Antigravity agents log task summaries and read history from other agents.');
      plan.notes.push('Reload MCP servers in Antigravity (Agent panel → … → MCP Servers → Refresh).');
      break;
    }
    case 'claude-code': {
      plan.commands.push(remove ? 'claude mcp remove --scope user devcontinuity' : `claude mcp add --scope user devcontinuity -- ${mcp.command} ${mcp.args.map((a) => `"${a}"`).join(' ')}`);
      plan.notes.push('Claude Code transcripts are already imported automatically; the MCP server adds summaries and cross-agent history.');
      if (opts.telemetry || remove) {
        const keys: Rec = { CLAUDE_CODE_ENABLE_TELEMETRY: '1', OTEL_LOGS_EXPORTER: 'otlp', OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json', OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `${otlpBase()}/v1/logs`, OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Bearer ${apiToken()}`, OTEL_LOG_USER_PROMPTS: '1' };
        push(
          jsonChange(p.claudeSettings, remove ? 'Remove DevContinuity telemetry settings' : 'Send OpenTelemetry logs (cost, tokens, tool results) to DevContinuity', (cfg) => {
            const env = ((cfg.env as Rec | undefined) ??= {}) as Rec;
            // Only remove telemetry settings that point at DevContinuity; someone else's exporter is left alone.
            const ours = String(env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT ?? '').startsWith(otlpBase());
            if (remove) {
              if (ours) for (const k of Object.keys(keys)) delete env[k];
            } else Object.assign(env, keys);
            if (Object.keys(env).length === 0) delete cfg.env;
          }),
        );
      }
      break;
    }
    case 'codex': {
      const before = read(p.codexConfig);
      let after = before ?? '';
      const mcpRe = tomlBlock(after, 'mcp_servers.devcontinuity');
      after = after.replace(mcpRe, '');
      if (!remove) after = `${after.replace(/\s*$/, '')}\n\n[mcp_servers.devcontinuity]\ncommand = ${JSON.stringify(mcp.command)}\nargs = ${JSON.stringify(mcp.args)}\n`;
      const otelRe = tomlBlock(after, 'otel');
      const hasOtel = otelRe.test(after);
      if (opts.telemetry && !remove) {
        if (hasOtel && !after.match(otelRe)?.[0].includes(otlpBase())) plan.notes.push('An [otel] section already exists in config.toml; telemetry was left unchanged.');
        else {
          after = after.replace(otelRe, '');
          after = `${after.replace(/\s*$/, '')}\n\n[otel]\nlog_user_prompt = true\nexporter = { otlp-http = { endpoint = "${otlpBase()}/v1/logs", protocol = "json", headers = { "Authorization" = "Bearer ${apiToken()}" } } }\n`;
        }
      }
      if (remove && hasOtel && after.match(otelRe)?.[0].includes(otlpBase())) after = after.replace(otelRe, '');
      after = after.replace(/\n{3,}/g, '\n\n').replace(/^\s+/, '');
      if (after !== (before ?? '')) plan.changes.push({ file: p.codexConfig, description: remove ? 'Remove DevContinuity MCP server and telemetry' : `Add the DevContinuity MCP server${opts.telemetry ? ' and OpenTelemetry export' : ''}`, before, after });
      plan.notes.push('Codex rollouts are already imported automatically; the MCP server adds summaries and cross-agent history.');
      break;
    }
  }
  if (!remove) plan.notes.push('Ask the agent to call the DevContinuity "log_summary" tool when it finishes a task (the Agent rules sync can add this instruction for you).');
  return plan;
}

/** Writes the plan. Each touched file is backed up first. Returns the backup folder. */
export function applyConnect(plan: ConnectPlan): { backupDir: string; written: string[] } {
  const backupDir = ensureDir(dataPath('backups', 'agent-config', `${timestampSlug()}-${plan.agent}`));
  const written: string[] = [];
  for (const c of plan.changes) {
    if (c.before != null) fs.writeFileSync(path.join(backupDir, path.basename(c.file)), c.before, 'utf8');
    fs.mkdirSync(path.dirname(c.file), { recursive: true });
    if (c.after == null) continue;
    fs.writeFileSync(c.file, c.after, 'utf8');
    written.push(c.file);
  }
  fs.writeFileSync(path.join(backupDir, 'README.txt'), `DevContinuity ${plan.remove ? 'disconnect' : 'connect'} for ${plan.label} on ${new Date().toISOString()}\n\nOriginals of:\n${plan.changes.map((c) => `- ${c.file}${c.before == null ? ' (did not exist)' : ''}`).join('\n')}\n`, 'utf8');
  return { backupDir, written };
}

export interface AgentConnection {
  agent: ConnectAgent;
  label: string;
  hooks: boolean;
  mcp: boolean;
  telemetry: boolean;
  liveSessions: number;
  lastLiveEvent: string | null;
}

/** What is connected today, read from the agents' config files and the live spool. */
export function connectionStatus(): AgentConnection[] {
  const p = configPaths();
  const has = (file: string, needles: string | string[]) => {
    const text = read(file) ?? '';
    return (Array.isArray(needles) ? needles : [needles]).some((n) => text.includes(n));
  };
  const streams = listLiveStreams();
  return CONNECT_AGENTS.map((agent) => {
    const mine = streams.filter((s) => s.agent === agent);
    const last = mine.reduce<Date | null>((a, s) => (!a || s.mtime > a ? s.mtime : a), null);
    const base = { agent, label: LABELS[agent], liveSessions: mine.length, lastLiveEvent: last?.toISOString() ?? null };
    switch (agent) {
      case 'gemini-cli':
        return { ...base, hooks: has(p.geminiSettings, HOOK_MARKS), mcp: has(p.geminiSettings, MCP_MARKS), telemetry: has(p.geminiSettings, '/api/otlp') };
      case 'cursor':
        return { ...base, hooks: has(p.cursorHooks, HOOK_MARKS), mcp: has(p.cursorMcp, MCP_MARKS), telemetry: false };
      case 'windsurf':
        return { ...base, hooks: has(p.windsurfHooks, HOOK_MARKS), mcp: has(p.windsurfMcp, MCP_MARKS), telemetry: false };
      case 'antigravity':
        return { ...base, hooks: false, mcp: has(p.antigravityMcp, MCP_MARKS), telemetry: false };
      case 'claude-code':
        return { ...base, hooks: false, mcp: has(path.join(homeDir(), '.claude.json'), MCP_MARKS), telemetry: has(p.claudeSettings, '/api/otlp') };
      case 'codex':
        return { ...base, hooks: false, mcp: has(p.codexConfig, MCP_MARKS), telemetry: has(p.codexConfig, '/api/otlp') };
    }
  });
}
