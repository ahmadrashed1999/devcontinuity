#!/usr/bin/env node
/**
 * DevContinuity launcher: "npx devcontinuity".
 *
 *   npx devcontinuity                      set up ~/.devcontinuity, start the UI + background service, open the browser
 *   npx devcontinuity start --port 4000 --no-open
 *   npx devcontinuity connect windsurf     any CLI command (agents, search, resume, handoff, wrapped, …)
 *   npx devcontinuity mcp                  the MCP server (stdio), for agents
 *
 * Data lives in ~/.devcontinuity (or DEVCONTINUITY_DATA_DIR). Agents' own files are only ever read.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { APP_ROOT, isPackaged, prepareEnv } from '../scripts/paths.mjs';

const require = createRequire(path.join(APP_ROOT, 'package.json'));
const pkg = require('./package.json');
const argv = process.argv.slice(2);
const META = ['--version', '-v', '--help', '-h'];
const command = argv[0] && (!argv[0].startsWith('-') || META.includes(argv[0])) ? argv[0] : 'start';
const rest = command === 'start' && argv[0] !== 'start' ? argv : argv.slice(1);

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 5)) {
  console.error(`DevContinuity needs Node.js 22.5 or newer (found ${process.versions.node}). Install a current Node.js from https://nodejs.org.`);
  process.exit(1);
}

const dataDir = prepareEnv();
const tsx = () => require.resolve('tsx/cli');
const run = (args, opts = {}) => spawnSync(process.execPath, args, { stdio: 'inherit', cwd: APP_ROOT, ...opts }).status ?? 1;

function flag(name) {
  const i = rest.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = rest[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

function openBrowser(url) {
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/d', '/c', 'start', '""', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true, windowsVerbatimArguments: process.platform === 'win32' }).unref();
  } catch {
    /* no browser available (server, container): the URL is printed anyway */
  }
}

async function alreadyRunning(port) {
  try {
    const r = await fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(1500) });
    return r.ok && (await r.text()).includes('DevContinuity');
  } catch {
    return false;
  }
}

async function start() {
  const port = String(flag('port') ?? process.env.PORT ?? '3210');
  const url = `http://localhost:${port}`;
  const open = !flag('no-open') && !process.env.CI && process.env.DEVCONTINUITY_NO_OPEN !== '1';
  if (await alreadyRunning(port)) {
    console.log(`DevContinuity is already running at ${url}`);
    if (open) openBrowser(url);
    return;
  }
  console.log(`DevContinuity ${pkg.version}\nData folder: ${dataDir}\n`);
  if (run([path.join(APP_ROOT, 'scripts', 'setup.mjs')], { env: { ...process.env, DEVCONTINUITY_QUIET_SETUP: '1' } }) !== 0) process.exit(1);
  const child = spawn(process.execPath, [path.join(APP_ROOT, 'scripts', 'serve.mjs')], { stdio: 'inherit', cwd: APP_ROOT, env: { ...process.env, PORT: port } });
  const stop = () => child.kill('SIGTERM');
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  child.on('exit', (code) => process.exit(code ?? 0));
  for (let i = 0; i < 240; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (child.exitCode != null) return;
    if (await alreadyRunning(port)) {
      console.log(`\n  DevContinuity is ready: ${url}\n  Connect an agent:  npx devcontinuity connect <agent>   (see "npx devcontinuity help")\n`);
      if (open) openBrowser(url);
      return;
    }
  }
  console.log(`\nStill starting… open ${url} in a moment.`);
}

const HELP = `DevContinuity ${pkg.version}: one local log for every AI coding agent.

  npx devcontinuity                   start the web UI + background service and open the browser
      [--port 3210] [--no-open]
  npx devcontinuity setup             create the data folder and apply database migrations only
  npx devcontinuity mcp               run the MCP server (stdio) for an agent
  npx devcontinuity <command>         any CLI command below

Data folder: ${dataDir}  (set DEVCONTINUITY_DATA_DIR to change it)
`;

switch (command) {
  case 'start':
    await start();
    break;
  case 'setup':
    process.exit(run([path.join(APP_ROOT, 'scripts', 'setup.mjs')]));
    break;
  case 'serve':
    process.exit(run([path.join(APP_ROOT, 'scripts', 'serve.mjs')]));
    break;
  case 'mcp': {
    // stdio belongs to the MCP client: nothing else may print to stdout.
    const child = spawn(process.execPath, [tsx(), path.join(APP_ROOT, 'scripts', 'mcp.ts')], { stdio: 'inherit', cwd: APP_ROOT });
    child.on('exit', (code) => process.exit(code ?? 0));
    break;
  }
  case 'hook':
    process.exit(run([path.join(APP_ROOT, 'scripts', 'hook.mjs'), ...rest]));
    break;
  case 'version':
  case '--version':
  case '-v':
    console.log(pkg.version);
    break;
  case 'help':
  case '--help':
  case '-h':
    console.log(HELP);
    run([tsx(), path.join(APP_ROOT, 'scripts', 'dc.ts'), 'help']);
    break;
  default:
    // A first CLI command on a fresh machine: create the database quietly first.
    if (!fs.existsSync(path.join(dataDir, 'devcontinuity.db'))) {
      const r = spawnSync(process.execPath, [path.join(APP_ROOT, 'scripts', 'setup.mjs')], { cwd: APP_ROOT, encoding: 'utf8' });
      if (r.status !== 0) {
        process.stderr.write(`${r.stdout ?? ''}${r.stderr ?? ''}`);
        process.exit(1);
      }
    }
    process.exit(run([tsx(), path.join(APP_ROOT, 'scripts', 'dc.ts'), command, ...rest], { env: { ...process.env, DEVCONTINUITY_CLI_NAME: isPackaged() ? 'npx devcontinuity' : 'npm run dc --' } }));
}
