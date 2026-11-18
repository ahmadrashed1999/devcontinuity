import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from '../config';

export class PathError extends Error {
  status = 400;
}

/** Lower-cased, forward-slash, no trailing slash. Used to compare Windows paths reliably. */
export function pathKey(p: string): string {
  let s = p.replace(/\\/g, '/').replace(/\/+$/, '');
  if (/^[a-zA-Z]:$/.test(s)) s += '/';
  return s.toLowerCase();
}

export function isInside(child: string, parent: string): boolean {
  const c = pathKey(path.resolve(child));
  const p = pathKey(path.resolve(parent));
  return c === p || c.startsWith(p.endsWith('/') ? p : `${p}/`);
}

/** Validates a user-supplied directory path: absolute, local, no device/UNC paths, no traversal tricks. */
export function validateLocalPath(input: unknown): string {
  if (typeof input !== 'string' || !input.trim()) throw new PathError('A path is required.');
  const raw = input.trim();
  if (raw.includes('\0')) throw new PathError('Invalid path.');
  if (/^\\\\/.test(raw) || /^\/\//.test(raw)) throw new PathError('Network (UNC) and device paths are not allowed.');
  if (!path.isAbsolute(raw)) throw new PathError('The path must be absolute.');
  return path.resolve(raw);
}

/** Files that are never copied, read into the database, or exported. */
const SENSITIVE_NAMES = [
  /^\.credentials\.json$/i,
  /^auth\.json$/i,
  /^\.claude\.json(\..*)?$/i,
  /^\.env(\..*)?$/i,
  /\.(pem|key|pfx|p12|keystore|jks)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /^cap_sid$/i,
  /^\.api-token$/i,
  /^\.netrc$/i,
];
const SENSITIVE_DIRS = [/^\.sandbox-secrets$/i, /^shell-snapshots$/i, /^session-env$/i, /^\.ssh$/i, /^\.aws$/i, /^\.gnupg$/i];

export function isSensitiveFile(filePath: string): boolean {
  const parts = filePath.replace(/\\/g, '/').split('/');
  const name = parts[parts.length - 1] ?? '';
  if (SENSITIVE_NAMES.some((re) => re.test(name))) return true;
  return parts.slice(0, -1).some((seg) => SENSITIVE_DIRS.some((re) => re.test(seg)));
}

/** Throws unless `target` is inside the DevContinuity data directory. All app writes go through this. */
export function assertInsideData(target: string): string {
  const resolved = path.resolve(target);
  if (!isInside(resolved, dataDir())) throw new PathError('Refusing to write outside the DevContinuity data directory.');
  return resolved;
}

/** Resolve `relative` under `base`, rejecting anything that escapes it (zip-slip / traversal protection). */
export function safeJoin(base: string, relative: string): string {
  if (relative.includes('\0')) throw new PathError('Invalid entry name.');
  const normalized = relative.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) throw new PathError(`Absolute entry path rejected: ${relative}`);
  if (normalized.split('/').some((seg) => seg === '..')) throw new PathError(`Path traversal rejected: ${relative}`);
  const target = path.resolve(base, normalized);
  if (!isInside(target, base)) throw new PathError(`Entry escapes the target directory: ${relative}`);
  return target;
}

export function safeFileName(name: string): string {
  const cleaned = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/\.+$/, '').trim();
  return cleaned.slice(0, 120) || 'file';
}

export function slugify(input: string): string {
  const s = input
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return s.slice(0, 60) || 'project';
}

export function pathExists(p: string): boolean {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

/** Never overwrite: returns `file` if free, otherwise the first free "name (n).ext". */
export function nonClobberingPath(file: string): string {
  if (!pathExists(file)) return file;
  const { dir, name, ext } = path.parse(file);
  for (let i = 2; i < 10_000; i++) {
    const candidate = path.join(dir, `${name} (${i})${ext}`);
    if (!pathExists(candidate)) return candidate;
  }
  throw new PathError('Could not find a free file name.');
}
