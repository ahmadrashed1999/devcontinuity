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
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { APP_ROOT as root, isPackaged, prepareEnv } from './paths.mjs';

const dataDir = prepareEnv();

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 5)) {
  console.error(`DevContinuity needs Node.js 22.5 or newer (found ${process.versions.node}).`);
  process.exit(1);
}

fs.mkdirSync(dataDir, { recursive: true });
const dbFile = path.join(dataDir, 'devcontinuity.db');
// Prisma wants file:<path>; forward slashes work on every platform.
const env = { ...process.env, DATABASE_URL: `file:${dbFile.replace(/\\/g, '/')}` };
// In an npm installation the dependencies are hoisted next to the package, not inside it.
const require = createRequire(path.join(root, 'package.json'));
let prisma;
try {
  prisma = require.resolve('prisma/build/index.js');
} catch {
  prisma = null;
}
if (!prisma) {
  console.error('Dependencies are missing. Run "npm install" first.');
  process.exit(1);
}

const run = (args) => spawnSync(process.execPath, [prisma, ...args], { cwd: root, env, stdio: 'inherit' }).status ?? 1;

console.log(`Data folder: ${dataDir}`);
if (run(['migrate', 'deploy']) !== 0) process.exit(1);

// The generated client lives next to @prisma/client. It is regenerated only when the schema changed,
// which keeps every "npx devcontinuity" start fast.
const clientDir = path.join(path.dirname(require.resolve('@prisma/client/package.json')), '..', '..', '.prisma', 'client');
const schemaHash = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'prisma', 'schema.prisma'))).digest('hex');
const stamp = path.join(clientDir, '.devcontinuity-schema');
const current = fs.existsSync(path.join(clientDir, 'index.js')) && fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === schemaHash;
if (!current) {
  if (run(['generate']) === 0) {
    try {
      fs.writeFileSync(stamp, schemaHash);
    } catch {
      /* read-only install: regenerate next time */
    }
  } else if (fs.existsSync(path.join(clientDir, 'index.js'))) {
    // On Windows a running DevContinuity keeps the engine file locked; the existing client is fine.
    console.warn('\nCould not regenerate the database client (is DevContinuity running?). The existing client will be used.');
  } else process.exit(1);
}
if (!process.env.DEVCONTINUITY_QUIET_SETUP) console.log(isPackaged() ? '\nSetup complete.' : '\nSetup complete. Next: "npm run build" then "npm run app" (or "npm run dev" while developing).');
