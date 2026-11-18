#!/usr/bin/env node
/**
 * DevContinuity orchestrator: the always-on background service.
 *  - Auto-sync: watches every supported agent's data and the live-capture spool, and imports
 *    sessions as they happen.
 *  - Scheduler: daily/weekly briefs, worktree scans, asset archiving, owner-created jobs.
 *  - AI organization (optional, off by default): plans orders, runs approved work, reviews.
 * Started by the tray app (or `npm run orchestrator`). Survives browser closes.
 */
import './_env';
import fs from 'node:fs';
import path from 'node:path';
import { dataPath, ensureDir } from '../src/server/config';
import { disconnectDb, ensureDb, prisma, setSetting } from '../src/server/db';
import { aiOrgEnabled } from '../src/server/features';
import { abortAll, activeCount, tick } from '../src/modules/org/server/engine';
import { schedulerTick } from '../src/server/scheduler';
import { seedOrg } from '../src/modules/org/server/seed';
import { AutoSync } from '../src/server/sync/watcher';

const logFile = path.join(ensureDir(dataPath('logs')), 'orchestrator.log');
function log(m: string) {
  const line = `${new Date().toISOString()} ${m}\n`;
  process.stdout.write(line);
  try {
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > 5 * 1024 * 1024) fs.renameSync(logFile, `${logFile}.1`);
    fs.appendFileSync(logFile, line);
  } catch {
    /* logging must not crash the service */
  }
}

async function main() {
  await ensureDb();
  if (await aiOrgEnabled()) {
    const seeded = await seedOrg();
    log(`orchestrator started (pid ${process.pid}); AI organization on: ${seeded.departments} department(s), ${seeded.roles} role(s)`);
  } else log(`orchestrator started (pid ${process.pid}); AI organization off (Settings → Features)`);
  // Work that was mid-flight when the service stopped goes back to the queue.
  await prisma().workItem.updateMany({ where: { status: { in: ['running', 'head_review', 'qa', 'security_review', 'changes_requested'] } }, data: { status: 'queued' } });
  await prisma().run.updateMany({ where: { status: 'running' }, data: { status: 'cancelled', error: 'Orchestrator restarted.', finishedAt: new Date() } });

  const sync = new AutoSync();
  sync.log = log;
  await sync.start();

  let stopping = false;
  const heartbeat = async () => setSetting('orchestrator', { pid: process.pid, at: new Date().toISOString(), active: activeCount() }).catch(() => undefined);
  await heartbeat();
  const timers = [
    setInterval(() => void heartbeat(), 10_000),
    setInterval(() => void tick(log).catch((e) => log(`engine error: ${(e as Error).message}`)), 3_000),
    setInterval(() => void schedulerTick(log).catch((e) => log(`scheduler error: ${(e as Error).message}`)), 30_000),
  ];
  void schedulerTick(log);

  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    log('orchestrator stopping');
    timers.forEach(clearInterval);
    sync.stop();
    abortAll();
    await setSetting('orchestrator', { pid: null, at: new Date().toISOString(), stopped: true }).catch(() => undefined);
    await disconnectDb();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('uncaughtException', (e) => log(`uncaught: ${e.stack ?? e.message}`));
  process.on('unhandledRejection', (e) => log(`unhandled: ${(e as Error)?.stack ?? String(e)}`));
}

main().catch((e) => {
  log(`fatal: ${(e as Error).stack ?? e}`);
  process.exit(1);
});
