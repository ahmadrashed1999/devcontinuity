#!/usr/bin/env node
/**
 * Release check for the npm package, without publishing anything:
 *   1. npm pack (needs a production build in .next: run "npm run build" first)
 *   2. scan the tarball for private data (this machine's home folder, user name, data folder)
 *   3. install the tarball into an empty temp folder
 *   4. run "devcontinuity --version", "agents" and start the server against a scratch data folder
 *      on a spare port, then request the overview page and the health API
 *
 *   npm run pack:check                 # keeps nothing; prints the tarball name and size
 *   PACK_CHECK_PORT=3298 npm run pack:check
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { APP_ROOT } from './paths.mjs';

const port = process.env.PACK_CHECK_PORT || '3298';
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', shell: process.platform === 'win32', ...opts });
const fail = (m) => {
  console.error(`\nFAIL: ${m}`);
  process.exit(1);
};

if (!fs.existsSync(path.join(APP_ROOT, '.next', 'BUILD_ID'))) fail('No production build in .next. Run "npm run build" first.');

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-pack-'));
console.log(`Work folder: ${work}`);
const packed = JSON.parse(sh(npm, ['pack', '--json', '--pack-destination', work], { cwd: APP_ROOT }))[0];
const tarball = path.join(work, packed.filename);
console.log(`Packed ${packed.filename}: ${packed.entryCount} files, ${(packed.size / 1024 / 1024).toFixed(1)} MB (${(packed.unpackedSize / 1024 / 1024).toFixed(1)} MB unpacked)`);

// A CRLF shebang ("node\r") cannot run on macOS or Linux.
for (const f of packed.files.filter((x) => x.path.startsWith('bin/') || x.path.endsWith('.mjs'))) {
  if (fs.readFileSync(path.join(APP_ROOT, f.path), 'utf8').includes('\r\n')) fail(`${f.path} has Windows line endings; run "git add --renormalize ." or pack from CI.`);
}

// 2. Private data scan over the packed files.
const needles = [os.homedir(), os.homedir().replace(/\\/g, '/'), os.homedir().replace(/\\/g, '\\\\'), APP_ROOT, APP_ROOT.replace(/\\/g, '/')].filter((n) => n.length > 4);
const user = os.userInfo().username;
const forbidden = packed.files.map((f) => f.path).filter((p) => /^(data|demo)\//.test(p) || /\.(db|sqlite)$/.test(p) || /(^|\/)\.env(\.|$)/.test(p));
if (forbidden.length) fail(`private files would be published: ${forbidden.join(', ')}`);
const leaks = [];
for (const f of packed.files) {
  const full = path.join(APP_ROOT, f.path);
  if (!fs.existsSync(full) || fs.statSync(full).size > 20 * 1024 * 1024) continue;
  const text = fs.readFileSync(full, 'latin1');
  for (const n of needles) if (text.includes(n)) leaks.push(`${f.path} contains ${n}`);
  if (user.length > 3 && new RegExp(`[\\\\/]${user}[\\\\/]`, 'i').test(text)) leaks.push(`${f.path} contains the user name ${user}`);
}
if (leaks.length) fail(`machine-specific paths found in the package:\n  ${[...new Set(leaks)].slice(0, 20).join('\n  ')}`);
console.log('Privacy scan: no local paths, user names, databases or .env files in the package.');

// 3. Install into an empty project.
const app = path.join(work, 'app');
fs.mkdirSync(app);
fs.writeFileSync(path.join(app, 'package.json'), '{"name":"pack-check","private":true}');
console.log('Installing the tarball (this downloads the dependencies)…');
sh(npm, ['install', '--no-audit', '--no-fund', '--loglevel=error', tarball], { cwd: app, stdio: 'inherit' });

const bin = path.join(app, 'node_modules', 'devcontinuity', 'bin', 'devcontinuity.mjs');
const data = path.join(work, 'data');
const env = { ...process.env, DEVCONTINUITY_DATA_DIR: data, DEVCONTINUITY_NO_OPEN: '1', PORT: port };
delete env.DEVCONTINUITY_APP_ROOT;
delete env.DEVCONTINUITY_PACKAGED;
const version = execFileSync(process.execPath, [bin, '--version'], { cwd: work, env, encoding: 'utf8' }).trim();
console.log(`devcontinuity --version → ${version}`);
const agents = execFileSync(process.execPath, [bin, 'agents'], { cwd: work, env, encoding: 'utf8' });
if (!/Agent\s+hooks/.test(agents)) fail(`"devcontinuity agents" printed:\n${agents}`);
console.log('devcontinuity agents → OK');

// 4. Start it and request pages.
const server = spawn(process.execPath, [bin, '--no-open', '--port', port], { cwd: work, env, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
server.stdout.on('data', (d) => (log += d));
server.stderr.on('data', (d) => (log += d));
let ok = false;
try {
  for (let i = 0; i < 180 && !ok; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const page = await fetch(`http://localhost:${port}/`);
      const html = await page.text();
      ok = page.ok && html.includes('DevContinuity');
      if (ok) {
        const cookie = page.headers.get('set-cookie')?.split(';')[0] ?? '';
        const health = await (await fetch(`http://localhost:${port}/api/health`, { headers: { cookie } })).json();
        console.log(`GET / → ${page.status}; /api/health → ${JSON.stringify({ ok: health.ok, version: health.version })}`);
        if (!fs.existsSync(path.join(data, 'devcontinuity.db'))) fail('the database was not created in the scratch data folder');
      }
    } catch {
      /* still starting */
    }
  }
} finally {
  server.kill();
  if (process.platform === 'win32' && server.pid) {
    try {
      execFileSync('taskkill', ['/pid', String(server.pid), '/t', '/f'], { stdio: 'ignore' });
    } catch {
      /* already gone */
    }
  }
}
if (!ok) fail(`the installed package did not serve the UI on port ${port}. Log:\n${log.slice(-4000)}`);
console.log(`\nPASS: ${packed.filename} installs and runs. Publish it with:\n  npm publish ${tarball}\n(or "npm publish" from a clean checkout after "npm run build").`);
