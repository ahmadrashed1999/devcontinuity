import fs from 'node:fs';
import path from 'node:path';
import { homeDir } from '../config';

/**
 * VS Code and its forks keep extension data under "<user data dir>/User". Cline, Copilot Chat and
 * similar extensions can run inside any of them, so adapters look in every one that exists.
 */
export const EDITORS: { id: string; label: string; dir: string }[] = [
  { id: 'vscode', label: 'VS Code', dir: 'Code' },
  { id: 'vscode-insiders', label: 'VS Code Insiders', dir: 'Code - Insiders' },
  { id: 'vscodium', label: 'VSCodium', dir: 'VSCodium' },
  { id: 'cursor', label: 'Cursor', dir: 'Cursor' },
  { id: 'windsurf', label: 'Windsurf', dir: 'Windsurf' },
  { id: 'antigravity', label: 'Antigravity', dir: 'Antigravity' },
  { id: 'trae', label: 'Trae', dir: 'Trae' },
];

/** Platform folder that holds the editors' user data. */
export function appDataRoot(): string {
  if (process.platform === 'win32') return process.env.APPDATA || path.join(homeDir(), 'AppData', 'Roaming');
  if (process.platform === 'darwin') return path.join(homeDir(), 'Library', 'Application Support');
  return process.env.XDG_CONFIG_HOME || path.join(homeDir(), '.config');
}

/** "<appdata>/<Editor>/User" for every installed VS Code-family editor. */
export function editorUserDirs(): { editor: string; label: string; dir: string }[] {
  const base = appDataRoot();
  return EDITORS.map((e) => ({ editor: e.id, label: e.label, dir: path.join(base, e.dir, 'User') })).filter((e) => fs.existsSync(e.dir));
}

/** Which editor a path belongs to, from its "<Editor>/User" segment. */
export function editorForPath(p: string): string | undefined {
  const norm = p.replace(/\\/g, '/').toLowerCase();
  return EDITORS.find((e) => norm.includes(`/${e.dir.toLowerCase()}/user/`))?.id;
}

/** file:///c%3A/work/app → c:\work\app (or /work/app on POSIX). Returns undefined for non-file URIs. */
export function fileUriToPath(uri: unknown): string | undefined {
  if (typeof uri !== 'string' || !uri.startsWith('file://')) return undefined;
  try {
    let p = decodeURIComponent(new URL(uri).pathname);
    if (/^\/[a-zA-Z]:/.test(p)) p = p.slice(1).replace(/\//g, '\\');
    return p;
  } catch {
    return undefined;
  }
}
