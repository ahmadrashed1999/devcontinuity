/**
 * Where DevContinuity lives and where it keeps its data. Shared by the launcher (bin/), setup,
 * serve and the TypeScript entry points (scripts/_env.ts) so they always agree.
 *
 * - A git checkout keeps its data in <checkout>/data (unchanged since 2.0).
 * - An npm/npx installation (the package sits inside a node_modules folder, which npx may delete
 *   at any time) keeps its data in ~/.devcontinuity.
 * - DEVCONTINUITY_DATA_DIR always wins.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** True when running from an installed npm package rather than a source checkout. */
export function isPackaged(root = APP_ROOT) {
  if (process.env.DEVCONTINUITY_PACKAGED === '1') return true;
  if (process.env.DEVCONTINUITY_PACKAGED === '0') return false;
  return root.split(/[\\/]/).includes('node_modules') && !fs.existsSync(path.join(root, '.git'));
}

export function defaultDataDir(root = APP_ROOT) {
  return isPackaged(root) ? path.join(os.homedir(), '.devcontinuity') : path.join(root, 'data');
}

export function resolveDataDir(root = APP_ROOT) {
  return path.resolve(process.env.DEVCONTINUITY_DATA_DIR?.trim() || defaultDataDir(root));
}

/** Loads .env.local/.env from the checkout and from the data folder (an npx install has no checkout to edit). */
export function loadEnvFiles(root = APP_ROOT) {
  const dirs = [root];
  if (isPackaged(root)) dirs.push(resolveDataDir(root));
  for (const dir of dirs) {
    for (const name of ['.env.local', '.env']) {
      const file = path.join(dir, name);
      if (!fs.existsSync(file)) continue;
      try {
        process.loadEnvFile(file);
      } catch {
        /* unreadable env file: continue without it */
      }
    }
  }
}

/** Sets the variables every child process (web server, orchestrator, CLI, MCP) relies on. */
export function prepareEnv(root = APP_ROOT) {
  loadEnvFiles(root);
  process.env.DEVCONTINUITY_DATA_DIR = resolveDataDir(root);
  process.env.DEVCONTINUITY_APP_ROOT ||= root;
  if (isPackaged(root)) process.env.DEVCONTINUITY_PACKAGED ||= '1';
  return process.env.DEVCONTINUITY_DATA_DIR;
}
