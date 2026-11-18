#!/usr/bin/env node
/**
 * DevContinuity hook recorder. Agents run it as a hook command and pipe the event JSON to stdin:
 *
 *   node "<repo>/scripts/hook.mjs" <agent>
 *   node "<data>/bin/devcontinuity-hook.mjs" <agent>     (npm installation)
 *
 * It appends the payload unchanged to data/live/<agent>/<session>.jsonl and exits 0 without
 * printing anything, so it can never block or alter the agent. It needs no running server and no
 * dependencies; the DevContinuity importer normalizes the records later.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_STDIN = 8 * 1024 * 1024;
const MAX_STRING = 200_000;

const here = path.dirname(fileURLToPath(import.meta.url));
// npm installations copy this file to <data>/bin/devcontinuity-hook.mjs and fill in the line below,
// so agents keep logging even after npx clears its cache.
const INSTALLED_DATA_DIR = null;
const dataDir = process.env.DEVCONTINUITY_DATA_DIR?.trim() || INSTALLED_DATA_DIR || path.join(here, '..', 'data');

const safe = (v, fallback) => {
  const s = typeof v === 'string' || typeof v === 'number' ? String(v) : '';
  return s.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^[._]+/, '').slice(0, 100) || fallback;
};

function clip(v, depth = 0) {
  if (typeof v === 'string') return v.length > MAX_STRING ? `${v.slice(0, MAX_STRING)}…[clipped ${v.length - MAX_STRING} chars]` : v;
  if (depth > 12 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.slice(0, 5000).map((x) => clip(x, depth + 1));
  const out = {};
  for (const [k, x] of Object.entries(v)) out[k] = clip(x, depth + 1);
  return out;
}

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    const chunks = [];
    let size = 0;
    const done = () => resolve(Buffer.concat(chunks).toString('utf8'));
    process.stdin.on('data', (c) => {
      size += c.length;
      if (size <= MAX_STDIN) chunks.push(c);
    });
    process.stdin.on('end', done);
    process.stdin.on('error', done);
    setTimeout(done, 3000).unref();
  });
}

async function main() {
  const agent = safe((process.argv[2] || 'unknown').toLowerCase(), 'unknown');
  const raw = (await readStdin()).replace(/^﻿/, '').trim();
  if (!raw) return;
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    payload = { unparsed: raw.slice(0, 50_000) };
  }
  const session = safe(payload.session_id ?? payload.sessionId ?? payload.conversation_id ?? payload.trajectory_id ?? payload.thread_id, `${agent}-${new Date().toISOString().slice(0, 10)}`);
  const record = { v: 1, at: new Date().toISOString(), source: 'hook', agent, session, cwd: process.cwd(), payload: clip(payload) };
  // Cursor waits for an answer on "before" hooks: always allow, never change anything.
  const ev = payload.hook_event_name;
  if (ev === 'beforeSubmitPrompt') process.stdout.write('{"continue":true}');
  else if (ev === 'beforeShellExecution' || ev === 'beforeMCPExecution' || ev === 'beforeReadFile') process.stdout.write('{"permission":"allow"}');
  const dir = path.join(dataDir, 'live', agent);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, `${session}.jsonl`), `${JSON.stringify(record)}\n`, 'utf8');
}

main()
  .catch((e) => {
    try {
      fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true });
      fs.appendFileSync(path.join(dataDir, 'logs', 'hook-errors.log'), `${new Date().toISOString()} ${process.argv[2] ?? ''} ${e?.stack ?? e}\n`);
    } catch {
      /* never fail the agent */
    }
  })
  .finally(() => process.exit(0));
