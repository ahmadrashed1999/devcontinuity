import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getSetting } from '../db';

export const LAUNCH_AGENTS = ['claude-code', 'codex', 'opencode', 'cursor', 'terminal'] as const;
export type LaunchAgent = (typeof LAUNCH_AGENTS)[number];

export interface AgentBinary {
  agent: LaunchAgent;
  path: string | null;
  /** cli = terminal program that accepts a prompt; app = desktop app (prompt goes to the clipboard) */
  kind: 'cli' | 'app' | null;
  source: 'setting' | 'path' | 'known-location' | null;
}

const home = os.homedir();
const appData = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
const localAppData = process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');

const WIN = process.platform === 'win32';

const NAMES: Record<LaunchAgent, string[]> = WIN
  ? {
      'claude-code': ['claude.exe', 'claude.cmd', 'claude.ps1'],
      codex: ['codex.exe', 'codex.ps1', 'codex.cmd'],
      opencode: ['opencode.exe', 'opencode.ps1', 'opencode.cmd'],
      cursor: ['cursor.cmd', 'cursor.exe'],
      terminal: ['wt.exe'],
    }
  : {
      'claude-code': ['claude'],
      codex: ['codex'],
      opencode: ['opencode'],
      cursor: ['cursor'],
      // macOS: Terminal/iTerm are opened with "open -a"; Linux: see POSIX_TERMINALS in launcher.ts.
      terminal: ['x-terminal-emulator', 'gnome-terminal', 'konsole', 'xfce4-terminal', 'kitty', 'alacritty', 'xterm'],
    };

const unixBins = (name: string) => [path.join(home, '.local', 'bin', name), '/opt/homebrew/bin/' + name, '/usr/local/bin/' + name, path.join(home, '.npm-global', 'bin', name)];

const KNOWN: Record<LaunchAgent, { file: string; kind: 'cli' | 'app' }[]> = WIN
  ? {
      'claude-code': [{ file: path.join(home, '.local', 'bin', 'claude.exe'), kind: 'cli' }, { file: path.join(appData, 'npm', 'claude.ps1'), kind: 'cli' }, { file: path.join(home, '.claude', 'local', 'claude.exe'), kind: 'cli' }],
      codex: [{ file: path.join(appData, 'npm', 'codex.ps1'), kind: 'cli' }, { file: path.join(appData, 'npm', 'codex.cmd'), kind: 'cli' }],
      opencode: [{ file: path.join(appData, 'npm', 'opencode.ps1'), kind: 'cli' }, { file: path.join(home, '.opencode', 'bin', 'opencode.exe'), kind: 'cli' }, { file: path.join(localAppData, 'Programs', '@opencode-aidesktop', 'OpenCode.exe'), kind: 'app' }],
      cursor: [{ file: path.join(localAppData, 'Programs', 'cursor', 'resources', 'app', 'bin', 'cursor.cmd'), kind: 'cli' }, { file: path.join(localAppData, 'Programs', 'cursor', 'Cursor.exe'), kind: 'app' }],
      terminal: [{ file: path.join(localAppData, 'Microsoft', 'WindowsApps', 'wt.exe'), kind: 'cli' }],
    }
  : {
      'claude-code': [...unixBins('claude'), path.join(home, '.claude', 'local', 'claude')].map((file) => ({ file, kind: 'cli' as const })),
      codex: unixBins('codex').map((file) => ({ file, kind: 'cli' as const })),
      opencode: [path.join(home, '.opencode', 'bin', 'opencode'), ...unixBins('opencode')].map((file) => ({ file, kind: 'cli' as const })),
      cursor: [{ file: '/Applications/Cursor.app/Contents/Resources/app/bin/cursor', kind: 'cli' }, { file: '/usr/bin/cursor', kind: 'cli' }, { file: '/opt/Cursor/cursor', kind: 'app' }],
      terminal: [],
    };

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    // Windows app execution aliases (e.g. WindowsApps\wt.exe) cannot be stat'ed but can be run.
    try {
      const l = fs.lstatSync(p);
      return !l.isDirectory() && /WindowsApps/i.test(p);
    } catch {
      return false;
    }
  }
}

function onPath(names: string[]): string | null {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const n of names) {
      const p = path.join(dir, n);
      // Skip extension-less files: on this machine C:\Windows\System32\claude is a data file, not a program.
      if (isFile(p)) return p;
    }
  }
  return null;
}

/** Finds each agent's executable. Owner-configured paths (Settings) win, so the system adapts when tools change. */
export async function detectAgents(): Promise<AgentBinary[]> {
  const custom = await getSetting<Partial<Record<LaunchAgent, string>>>('agentPaths', {});
  return LAUNCH_AGENTS.map((agent) => {
    const c = custom[agent]?.trim();
    if (c && isFile(c)) return { agent, path: c, kind: /OpenCode\.exe$|Cursor\.exe$|\.app$/i.test(c) ? 'app' : 'cli', source: 'setting' };
    const p = onPath(NAMES[agent]);
    if (p) return { agent, path: p, kind: 'cli', source: 'path' };
    const k = KNOWN[agent].find((x) => isFile(x.file));
    if (k) return { agent, path: k.file, kind: k.kind, source: 'known-location' };
    return { agent, path: null, kind: null, source: null };
  });
}

export async function findAgent(agent: LaunchAgent): Promise<AgentBinary> {
  return (await detectAgents()).find((a) => a.agent === agent)!;
}
