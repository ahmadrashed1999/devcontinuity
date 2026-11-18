#!/usr/bin/env node
import './_env';
import fs from 'node:fs';
import path from 'node:path';
import { disconnectDb, ensureDb, prisma } from '../src/server/db';
import type { AgentId } from '../src/server/adapters/types';

const CLI = process.env.DEVCONTINUITY_CLI_NAME || 'npm run dc --';
const HELP = `DevContinuity CLI

Usage: ${CLI} <command> [options]

Recovery
  scan [--agent <id>] [--json]            Read-only inventory of recoverable agent data
  import [--agent <id>] [--force] [--no-assets]
                                          Safe-copy and import sessions (originals are never modified)
Browse
  projects                                List projects
  sessions [--project <name|id>] [--limit N]
  search <query>                          Full-text search across all sessions
  wrapped [--month 2026-11 | --year 2026] [--json]
                                          AI Coding Wrapped: a month or year in numbers
Continue with any agent
  resume --project <name|id> | --session <id> [--agent claude-code|opencode|codex|cursor|generic]
         [--out <file>]                   Print (or save) a ready-to-paste continuation prompt
  handoff --project <name|id> [--session <id>] [--agent <id>] [--drop-in]
                                          Build the full handoff package + ZIP
  docs --project <name|id>                Regenerate the project knowledge documents
Connect agents (live logging)
  agents                                  Which agents are connected and what they have logged
  connect <agent> [--telemetry] [--yes]   Show, then (with --yes) apply hooks + MCP setup for an agent
  disconnect <agent> [--yes]              Remove DevContinuity's hooks/MCP/telemetry from an agent
                                          agents: gemini-cli, cursor, windsurf, antigravity, claude-code, codex
Safety
  backup [--with-archives] [--note <text>]
  token                                   Show where the local API token is stored

Imported automatically: claude-code, codex, opencode, antigravity, cline (+ Roo/Kilo), copilot, continue, cursor.
Any other agent: connect it, or POST events to /api/ingest/event.`;

function parseArgs(argv: string[]) {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else flags[key] = true;
    } else positional.push(a);
  }
  return { flags, positional };
}

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
const fmtDate = (d?: Date | null) => (d ? d.toISOString().slice(0, 16).replace('T', ' ') : '-');

export async function findProject(ref: string) {
  const db = prisma();
  const byId = await db.project.findFirst({ where: { OR: [{ id: ref }, { slug: ref }] } });
  if (byId) return byId;
  const matches = await db.project.findMany({ where: { OR: [{ name: { contains: ref } }, { rootPath: { contains: ref } }] }, orderBy: { lastActivityAt: 'desc' } });
  if (matches.length === 0) throw new Error(`No project matches "${ref}". Run "${CLI} projects" to list them.`);
  if (matches.length > 1) {
    const exact = matches.find((m) => m.name.toLowerCase() === ref.toLowerCase());
    if (exact) return exact;
    throw new Error(`"${ref}" matches ${matches.length} projects: ${matches.slice(0, 8).map((m) => m.slug).join(', ')}. Use the slug.`);
  }
  return matches[0];
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { flags, positional } = parseArgs(rest);
  if (!command || command === 'help' || flags.help) {
    console.log(HELP);
    return;
  }
  const agents = typeof flags.agent === 'string' ? ([flags.agent] as AgentId[]) : undefined;

  if (command === 'scan') {
    const { scanAll } = await import('../src/server/import/importer');
    const inv = await scanAll({ agents });
    if (flags.json) {
      console.log(JSON.stringify(inv.map((i) => ({ ...i, sessions: i.sessions.length })), null, 2));
      return;
    }
    for (const i of inv) {
      console.log(`\n=== ${i.label} — ${i.root} ${i.exists ? '' : '(not found)'}`);
      if (!i.exists) continue;
      const subs = i.sessions.filter((s) => s.isSubagent).length;
      console.log(`  sessions: ${i.sessions.length - subs} main + ${subs} subagent, ${mb(i.sessions.reduce((a, s) => a + (s.sourcePath.endsWith('.db') ? 0 : s.size), 0))}`);
      console.log(`  validation: ${i.validation.readable} readable, ${i.validation.unreadable} unreadable, ${i.validation.empty} empty`);
      for (const a of i.assets) console.log(`  [${a.archived ? 'copy' : 'skip'}] ${a.label}: ${a.count} file(s), ${mb(a.bytes)}${a.note ? ` — ${a.note}` : ''}`);
      for (const n of i.notes.slice(0, 10)) console.log(`  note: ${n}`);
      for (const u of i.unrecoverable) console.log(`  cannot recover: ${u}`);
      for (const e of i.errors.slice(0, 10)) console.log(`  error: ${e}`);
    }
    return;
  }

  if (command === 'connect' || command === 'disconnect') {
    const { CONNECT_AGENTS, applyConnect, planConnect } = await import('../src/server/live/connect');
    const agent = positional[0] as (typeof CONNECT_AGENTS)[number];
    if (!CONNECT_AGENTS.includes(agent)) throw new Error(`Usage: ${CLI} ${command} <${CONNECT_AGENTS.join('|')}>`);
    const plan = planConnect(agent, { telemetry: !!flags.telemetry, remove: command === 'disconnect' });
    console.log(`${command === 'connect' ? 'Connect' : 'Disconnect'} ${plan.label}\n`);
    if (!plan.changes.length && !plan.commands.length) console.log('Nothing to change: already in the requested state.');
    for (const c of plan.changes) console.log(`  ${c.before == null ? 'create' : 'update'} ${c.file}\n    ${c.description}`);
    for (const c of plan.commands) console.log(`  run yourself:\n    ${c}`);
    for (const n of plan.notes) console.log(`  note: ${n}`);
    if (!plan.changes.length) return;
    if (!flags.yes) {
      console.log('\nNothing was written. Re-run with --yes to apply (each file is backed up first).');
      return;
    }
    const r = applyConnect(plan);
    console.log(`\nWritten: ${r.written.join(', ')}\nBackups: ${r.backupDir}`);
    return;
  }
  if (command === 'agents') {
    const { connectionStatus } = await import('../src/server/live/connect');
    const yes = (b: boolean) => (b ? 'yes' : ' - ');
    console.log('Agent         hooks  mcp  telemetry  live sessions  last live event');
    for (const c of connectionStatus()) console.log(`${c.label.padEnd(13)} ${yes(c.hooks).padEnd(6)} ${yes(c.mcp).padEnd(4)} ${yes(c.telemetry).padEnd(10)} ${String(c.liveSessions).padEnd(14)} ${c.lastLiveEvent ?? '-'}`);
    console.log('\nClaude Code, Codex, OpenCode, Antigravity, Cline, Copilot and Continue are also imported from their own files; hooks are optional for them.');
    return;
  }

  await ensureDb();
  const db = prisma();

  if (command === 'import') {
    const { runImport } = await import('../src/server/import/importer');
    const { isLocked, withLock } = await import('../src/server/lock');
    const startedAt = new Date();
    let last = 0;
    // Same lease lock as the background auto-sync, so a manual import never races it.
    const res = await withLock('import', 60 * 60_000, () => runImport(
      { agents, force: !!flags.force, includeAssets: !flags['no-assets'] },
      {
        progress: (done, total, message) => {
          const now = Date.now();
          if (now - last > 1500 || done === total) {
            last = now;
            console.log(`[${done}/${total}] ${message}`);
          }
        },
        log: (line) => console.log(line),
        isCancelled: () => false,
      },
    ));
    if (isLocked(res)) throw new Error('Another import is running (auto-sync or the UI). Try again in a minute.');
    // Flag sessions that just stopped on a limit or error, exactly like the background sync does.
    const { notifyEndings } = await import('../src/server/sync/watcher');
    await notifyEndings(startedAt);
    console.log(JSON.stringify({ ...res, errors: res.errors.slice(0, 20) }, null, 2));
  } else if (command === 'wrapped') {
    const { parsePeriod, renderWrappedText, wrappedStats } = await import('../src/server/wrapped');
    const key = typeof flags.month === 'string' ? flags.month : typeof flags.year === 'string' ? flags.year : undefined;
    const stats = await wrappedStats(parsePeriod(key));
    console.log(flags.json ? JSON.stringify(stats, null, 2) : renderWrappedText(stats));
  } else if (command === 'projects') {
    const projects = await db.project.findMany({ orderBy: { lastActivityAt: 'desc' }, include: { _count: { select: { sessions: true, tasks: true } } } });
    for (const p of projects) console.log(`${fmtDate(p.lastActivityAt)}  ${p.slug.padEnd(34)} sessions=${String(p._count.sessions).padEnd(4)} tasks=${String(p._count.tasks).padEnd(5)} ${p.pathExists ? '' : '[folder missing] '}${p.rootPath}`);
    console.log(`\n${projects.length} project(s).`);
  } else if (command === 'sessions') {
    const project = typeof flags.project === 'string' ? await findProject(flags.project) : undefined;
    const sessions = await db.session.findMany({ where: { projectId: project?.id, isSubagent: false }, orderBy: { endedAt: 'desc' }, take: Number(flags.limit) || 30 });
    for (const s of sessions) console.log(`${fmtDate(s.endedAt)}  ${s.id}  ${s.agent.padEnd(11)} ${s.endState.padEnd(20)} ${(s.title ?? '(untitled)').slice(0, 70)}`);
  } else if (command === 'search') {
    const { searchEvents } = await import('../src/server/search');
    const hits = await searchEvents(positional.join(' '), { limit: 20 });
    for (const hit of hits.hits) console.log(`${fmtDate(hit.timestamp ? new Date(hit.timestamp) : null)}  [${hit.kind}] ${hit.projectName ?? '-'} / ${hit.sessionTitle ?? hit.sessionId}\n    ${hit.snippet.replace(/\s+/g, ' ')}`);
    console.log(`\n${hits.hits.length} of ${hits.total} match(es).`);
  } else if (command === 'resume') {
    const { buildResumeContext, renderContinuationPrompt } = await import('../src/server/handoff/context');
    const project = typeof flags.project === 'string' ? await findProject(flags.project) : undefined;
    const sessionId = typeof flags.session === 'string' ? flags.session : undefined;
    if (!project && !sessionId) throw new Error('Pass --project <name|id> or --session <id>.');
    const ctx = await buildResumeContext({ projectId: project?.id, sessionId });
    const prompt = renderContinuationPrompt(ctx, typeof flags.agent === 'string' ? flags.agent : 'generic');
    if (typeof flags.out === 'string') {
      const out = path.resolve(flags.out);
      if (fs.existsSync(out)) throw new Error(`${out} already exists. DevContinuity never overwrites files; choose another name.`);
      fs.writeFileSync(out, prompt, 'utf8');
      console.error(`Saved continuation prompt to ${out}`);
    } else console.log(prompt);
  } else if (command === 'handoff') {
    const { createHandoff, dropInHandoff } = await import('../src/server/handoff/package');
    if (typeof flags.project !== 'string') throw new Error('Pass --project <name|id>.');
    const project = await findProject(flags.project);
    const hand = await createHandoff({ projectId: project.id, sessionId: typeof flags.session === 'string' ? flags.session : undefined, targetAgent: typeof flags.agent === 'string' ? flags.agent : 'generic' });
    console.log(`Handoff package: ${hand.dirPath}\nZIP: ${hand.zipPath}`);
    if (flags['drop-in']) {
      const r = await dropInHandoff(hand.id);
      console.log(`Dropped into repository: ${r.targetDir}\n${r.note}`);
    }
  } else if (command === 'docs') {
    const { generateProjectDocs } = await import('../src/server/intelligence/docs');
    if (typeof flags.project !== 'string') throw new Error('Pass --project <name|id>.');
    const project = await findProject(flags.project);
    const docs = await generateProjectDocs(project.id);
    console.log(`Generated ${docs.length} documents in ${docs[0]?.dir ?? ''}`);
  } else if (command === 'backup') {
    const { createBackup } = await import('../src/server/backup/backup');
    const b = await createBackup({ includeArchives: !!flags['with-archives'], note: typeof flags.note === 'string' ? flags.note : undefined });
    console.log(`Backup written: ${b.filePath} (${b.sizeMb.toFixed(1)} MB)`);
  } else if (command === 'token') {
    const { dataDir } = await import('../src/server/config');
    console.log(`The local API token is stored at ${path.join(dataDir(), '.api-token')} (send it as "Authorization: Bearer <token>").`);
  } else {
    console.log(HELP);
    process.exitCode = 1;
  }
}

main()
  .catch((e) => {
    console.error(`Error: ${(e as Error).message}`);
    process.exitCode = 1;
  })
  .finally(() => disconnectDb());
