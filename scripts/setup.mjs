#!/usr/bin/env node
/**
 * One-time (and safe to repeat) setup: creates the data folder and applies database migrations.
 * Works on Windows, macOS and Linux without any .env file.
 *
 *   npm run setup
 *
 * It only ever applies pending migrations ("prisma migrate deploy"); it never resets data.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const name of ['.env.local', '.env']) {
  const f = path.join(root, name);
  if (fs.existsSync(f)) {
    try {
      process.loadEnvFile(f);
    } catch {
      /* ignore unreadable env files */
    }
  }
}

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 5)) {
  console.error(`DevContinuity needs Node.js 22.5 or newer (found ${process.versions.node}).`);
  process.exit(1);
}

const dataDir = path.resolve(process.env.DEVCONTINUITY_DATA_DIR?.trim() || path.join(root, 'data'));
fs.mkdirSync(dataDir, { recursive: true });
const dbFile = path.join(dataDir, 'devcontinuity.db');
// Prisma wants file:<path>; forward slashes work on every platform.
const env = { ...process.env, DATABASE_URL: `file:${dbFile.replace(/\\/g, '/')}` };
const prisma = path.join(root, 'node_modules', 'prisma', 'build', 'index.js');
if (!fs.existsSync(prisma)) {
  console.error('Dependencies are missing. Run "npm install" first.');
  process.exit(1);
}

const run = (args) => spawnSync(process.execPath, [prisma, ...args], { cwd: root, env, stdio: 'inherit' }).status ?? 1;

console.log(`Data folder: ${dataDir}`);
if (run(['migrate', 'deploy']) !== 0) process.exit(1);
if (run(['generate']) !== 0) {
  // On Windows a running DevContinuity keeps the engine file locked; the existing client is fine.
  if (fs.existsSync(path.join(root, 'node_modules', '.prisma', 'client', 'index.js'))) console.warn('\nCould not regenerate the database client (is DevContinuity running?). The existing client will be used.');
  else process.exit(1);
}
console.log('\nSetup complete. Next: "npm run build" then "npm run app" (or "npm run dev" while developing).');
