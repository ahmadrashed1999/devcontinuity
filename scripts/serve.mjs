#!/usr/bin/env node
/**
 * Runs DevContinuity: the web UI and the background service (auto-sync of every agent, live
 * capture import, schedules), restarting either one if it crashes. Works on Windows, macOS and
 * Linux. On Windows the tray app (npm run tray) does the same with a tray icon.
 *
 *   npm run app            # http://localhost:3210
 *   PORT=4000 npm run app
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = process.env.PORT || '3210';
const next = path.join(root, 'node_modules', 'next', 'dist', 'bin', 'next');
const tsx = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const distDir = process.env.NEXT_DIST_DIR || '.next';

if (!fs.existsSync(next) || !fs.existsSync(tsx)) {
  console.error('Dependencies are missing. Run "npm install" and "npm run setup" first.');
  process.exit(1);
}
if (!fs.existsSync(path.join(root, distDir, 'BUILD_ID'))) {
  console.log('No production build found; building once (a few minutes)…');
  const b = spawnSync(process.execPath, [next, 'build'], { cwd: root, stdio: 'inherit' });
  if (b.status !== 0) process.exit(b.status ?? 1);
}

let stopping = false;
const children = new Map();

function start(name, args) {
  const child = spawn(process.execPath, args, { cwd: root, stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env, PORT: port } });
  children.set(name, child);
  child.on('exit', (code) => {
    children.delete(name);
    if (stopping) return;
    console.error(`[devcontinuity] ${name} exited (${code ?? 'signal'}); restarting in 3 s`);
    setTimeout(() => start(name, args), 3000);
  });
}

start('web', [next, 'start', '-p', port]);
start('orchestrator', [tsx, path.join('scripts', 'orchestrator.ts')]);
console.log(`[devcontinuity] running at http://localhost:${port}  (Ctrl+C to stop)`);

function shutdown() {
  if (stopping) return;
  stopping = true;
  for (const c of children.values()) c.kill();
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
