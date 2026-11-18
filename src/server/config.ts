import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Root of all DevContinuity-owned data. Nothing outside this folder is ever written, except explicit drop-ins. */
export function dataDir(): string {
  const dir = process.env.DEVCONTINUITY_DATA_DIR?.trim() || path.join(process.cwd(), 'data');
  return path.resolve(dir);
}

export type DataSubdir = 'archives' | 'exports' | 'handoffs' | 'knowledge' | 'backups' | 'tmp' | 'uploads' | 'pre-restore' | 'worktrees' | 'logs' | 'runs' | 'live';

export function dataPath(sub: DataSubdir, ...rest: string[]): string {
  const p = path.join(dataDir(), sub, ...rest);
  return p;
}

export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function dbPath(): string {
  return path.join(dataDir(), 'devcontinuity.db');
}

export function dbUrl(): string {
  return `file:${dbPath().replace(/\\/g, '/')}?connection_limit=1&socket_timeout=60`;
}

/**
 * Local API token. Generated on first use and stored in the data dir.
 * Browsers receive it as an HttpOnly cookie; CLI/MCP clients read the file.
 */
export function apiToken(): string {
  const file = path.join(ensureDir(dataDir()), '.api-token');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (/^[a-f0-9]{48,}$/.test(existing)) return existing;
  } catch {
    /* first run */
  }
  const token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(file, token, { encoding: 'utf8', mode: 0o600 });
  return token;
}

export function homeDir(): string {
  return os.homedir();
}

export const APP_VERSION = '2.1.0';

/** Maximum characters of event text kept in the database. Full content always remains in the archived original. */
export const MAX_EVENT_TEXT = 12_000;

export function timestampSlug(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
