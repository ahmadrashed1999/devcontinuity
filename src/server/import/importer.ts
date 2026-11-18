import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Prisma } from '@prisma/client';
import { ADAPTERS, getAdapter, resolveRoots } from '../adapters';
import { encodeClaudeProjectDir } from '../adapters/claude-code';
import { disposeOpencodeCopies } from '../adapters/opencode';
import { disposeWorkingCopies, sqliteCompanions } from '../adapters/sqlite-util';
import { pruneLiveDuplicates } from '../live/dedupe';
import { AgentId, AgentInventory, DiscoveredSession, NormalizedEvent, NormalizedFileOp, SessionSink, clip } from '../adapters/types';
import { ensureDb, ftsIndexSession, ftsRemoveSession, prisma } from '../db';
import { deriveTasks, saveDerivedTasks } from '../intelligence/tasks';
import { redactSecrets } from '../security/redact';
import { safeFileName } from '../security/paths';
import { RawWriter, archiveRootFor, archiveTree, safeCopy, sha256File } from './archive';
import { clearProjectCache, refreshProjectStats, resolveProject, resolveProjectFromHint } from './projects';

export interface ImportReporter {
  progress(done: number, total: number, message: string): void;
  log(line: string): void;
  isCancelled(): boolean;
}

export const silentReporter: ImportReporter = { progress() {}, log() {}, isCancelled: () => false };

export interface ImportOptions {
  agents?: AgentId[];
  /** Re-import sessions even when the source file is unchanged. */
  force?: boolean;
  /** Copy non-transcript assets (tool results, file snapshots, memory, plans). Default true. */
  includeAssets?: boolean;
  /** Extra roots for this run only, e.g. a single uploaded file for the generic adapter. */
  extraRoots?: Partial<Record<AgentId, string[]>>;
  /** Restrict to these roots instead of the configured ones. */
  onlyExtraRoots?: boolean;
  /** Assign imported sessions with no detectable project to this project. */
  fallbackProjectId?: string;
}

export interface ImportResult {
  imported: number;
  skippedUnchanged: number;
  failed: number;
  events: number;
  tasks: number;
  assetsCopied: number;
  malformedLines: number;
  durationMs: number;
  cancelled: boolean;
  errors: string[];
  perAgent: Record<string, { found: number; imported: number; skipped: number; failed: number }>;
}

export type InventoryReport = AgentInventory & { validation: { readable: number; unreadable: number; empty: number } };

const h = (s: string) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);

/** Read-only discovery of everything importable. Nothing is copied or written to the database. */
export async function scanAll(opts: Pick<ImportOptions, 'agents' | 'extraRoots' | 'onlyExtraRoots'> = {}): Promise<InventoryReport[]> {
  const out: InventoryReport[] = [];
  for (const adapter of ADAPTERS) {
    if (opts.agents && !opts.agents.includes(adapter.id)) continue;
    const extra = opts.extraRoots?.[adapter.id] ?? [];
    const roots = opts.onlyExtraRoots ? extra : [...(await resolveRoots(adapter.id)), ...extra];
    for (const root of roots) {
      let inv: AgentInventory;
      try {
        inv = await adapter.scan(root);
      } catch (e) {
        inv = { agent: adapter.id, label: adapter.label, root, exists: fs.existsSync(root), sessions: [], projectDirs: [], assets: [], notes: [], unrecoverable: [], errors: [`Scan failed: ${(e as Error).message}`] };
      }
      const validation = { readable: 0, unreadable: 0, empty: 0 };
      const checked = new Set<string>();
      for (const s of inv.sessions) {
        if (checked.has(s.sourcePath)) continue;
        checked.add(s.sourcePath);
        try {
          fs.accessSync(s.sourcePath, fs.constants.R_OK);
          validation.readable++;
          if (fs.statSync(s.sourcePath).size === 0) validation.empty++;
        } catch {
          validation.unreadable++;
        }
      }
      out.push({ ...inv, validation });
    }
  }
  return out;
}

function eventRow(sessionId: string, e: NormalizedEvent): Prisma.EventCreateManyInput {
  return {
    sessionId,
    seq: e.seq,
    lineNo: e.lineNo,
    blockIndex: e.blockIndex,
    kind: e.kind,
    role: e.role,
    rawType: e.rawType,
    subtype: e.subtype,
    timestamp: e.timestamp,
    uuid: e.uuid,
    parentUuid: e.parentUuid,
    text: e.text,
    truncated: e.truncated ?? false,
    toolName: e.toolName,
    toolUseId: e.toolUseId,
    isError: e.isError ?? false,
    isSidechain: e.isSidechain ?? false,
    isMeta: e.isMeta ?? false,
    model: e.model,
    filePath: e.filePath,
    command: e.command,
    rawOffset: e.rawOffset,
    rawLength: e.rawLength,
    meta: e.meta ? JSON.stringify(e.meta) : undefined,
  };
}

async function projectForClaudeHint(hint: string): Promise<{ projectId: string; worktree?: string }> {
  const projects = await prisma().project.findMany({ where: { pathVerified: true }, select: { id: true, rootPath: true } });
  let best: { projectId: string; worktree?: string; len: number } | undefined;
  for (const p of projects) {
    const enc = encodeClaudeProjectDir(p.rootPath);
    if (hint.toLowerCase() === enc.toLowerCase()) return { projectId: p.id };
    const prefix = `${enc}--claude-worktrees-`.toLowerCase();
    if (hint.toLowerCase().startsWith(prefix) && (!best || enc.length > best.len)) best = { projectId: p.id, worktree: hint.slice(prefix.length), len: enc.length };
  }
  if (best) return { projectId: best.projectId, worktree: best.worktree };
  return { projectId: await resolveProjectFromHint(hint) };
}

export async function runImport(opts: ImportOptions = {}, rep: ImportReporter = silentReporter): Promise<ImportResult> {
  const started = Date.now();
  await ensureDb();
  clearProjectCache();
  const db = prisma();
  await db.$executeRawUnsafe('PRAGMA synchronous=NORMAL').catch(() => undefined);

  const result: ImportResult = { imported: 0, skippedUnchanged: 0, failed: 0, events: 0, tasks: 0, assetsCopied: 0, malformedLines: 0, durationMs: 0, cancelled: false, errors: [], perAgent: {} };
  rep.progress(0, 0, 'Scanning agent data directories (read-only)…');
  const inventories = await scanAll(opts);

  const work: { inv: InventoryReport; d: DiscoveredSession; archiveRoot: string }[] = [];
  for (const inv of inventories) {
    const pa = (result.perAgent[inv.agent] ??= { found: 0, imported: 0, skipped: 0, failed: 0 });
    pa.found += inv.sessions.length;
    if (!inv.exists || inv.sessions.length === 0) continue;
    const archiveRoot = archiveRootFor(inv.agent, inv.root);
    for (const d of inv.sessions) work.push({ inv, d, archiveRoot });
  }
  // Parent sessions first so subagent transcripts can inherit their project.
  work.sort((a, b) => Number(!!a.d.isSubagent) - Number(!!b.d.isSubagent));
  const total = work.length;
  rep.log(`Found ${total} session source(s) across ${inventories.filter((i) => i.exists).length} agent data director${inventories.length === 1 ? 'y' : 'ies'}.`);

  const copiedDbs = new Map<string, string>();
  const unresolved: { sessionId: string; hint: string }[] = [];
  const orphanSubagents: { sessionId: string; parentExternalId: string; agent: string }[] = [];

  try {
    for (let i = 0; i < work.length; i++) {
      if (rep.isCancelled()) {
        result.cancelled = true;
        break;
      }
      const { inv, d, archiveRoot } = work[i];
      const pa = result.perAgent[inv.agent];
      rep.progress(i, total, `${inv.label}: ${d.projectHint ? `${clip(d.projectHint, 60)} / ` : ''}${clip(d.externalId, 40)}`);
      try {
        const existing = await db.session.findUnique({ where: { sourceKey: d.sourceKey } });
        if (existing && !opts.force && existing.sourceSize === d.size && existing.sourceMtime?.getTime() === d.mtime.getTime() && existing.eventCount > 0) {
          result.skippedUnchanged++;
          pa.skipped++;
          continue;
        }

        // 1. Safe copy. The original is read once here and never touched again.
        const adapter = getAdapter(d.agent);
        const isDb = /\.(db|vscdb|sqlite)$/i.test(d.sourcePath);
        let archivePath: string;
        if (isDb) {
          archivePath = copiedDbs.get(d.sourcePath) ?? '';
          if (!archivePath) {
            archivePath = path.join(archiveRoot, d.relPath);
            await safeCopy(d.sourcePath, archivePath);
            for (const c of sqliteCompanions(d.sourcePath)) await safeCopy(c, archivePath + c.slice(d.sourcePath.length));
            copiedDbs.set(d.sourcePath, archivePath);
          }
        } else {
          archivePath = path.join(archiveRoot, d.relPath);
          const copy = await safeCopy(d.sourcePath, archivePath);
          if (copy.copied) result.assetsCopied++;
        }
        // Companion files (UI logs, plan artifacts) are safe-copied too; adapters only read the copies.
        const companionCopies: (string | undefined)[] = [];
        for (const c of d.companions ?? []) {
          const dest = path.join(path.dirname(archivePath), isDb ? path.join('companions', safeFileName(d.externalId)) : '', path.basename(c));
          try {
            const cp = await safeCopy(c, dest);
            companionCopies.push(cp.skippedReason ? undefined : dest);
            if (cp.copied) result.assetsCopied++;
          } catch (e) {
            companionCopies.push(undefined);
            rep.log(`Companion not copied: ${c}: ${(e as Error).message}`);
          }
        }

        // 2. Parse the copy into the unified representation.
        const row = existing ?? (await db.session.create({ data: { agent: d.reportedAgent ?? d.agent, externalId: d.externalId, sourcePath: d.sourcePath, sourceKey: d.sourceKey } }));
        if (existing) {
          await ftsRemoveSession(row.id);
          await db.event.deleteMany({ where: { sessionId: row.id } });
          await db.fileOp.deleteMany({ where: { sessionId: row.id } });
        }
        const fileOps: NormalizedFileOp[] = [];
        const sink: SessionSink = {
          events: async (batch) => {
            await db.event.createMany({ data: batch.map((e) => eventRow(row.id, e)) });
            result.events += batch.length;
          },
          fileOps: async (batch) => {
            fileOps.push(...batch);
          },
        };
        const rawWriter = new RawWriter(path.join(archiveRoot, 'normalized', `${safeFileName(d.externalId)}.jsonl`));
        let s;
        try {
          s = await adapter.parse(d, sink, { archivePath, writeRaw: rawWriter.write, companions: companionCopies });
        } finally {
          rawWriter.close();
        }

        // 3. Attach to a project.
        let projectId: string | null = null;
        let worktree: string | undefined;
        const located = await resolveProject(s.cwd);
        if (located) {
          projectId = located.projectId;
          worktree = located.worktree;
        } else if (d.agent === 'claude-code' && d.projectHint) unresolved.push({ sessionId: row.id, hint: d.projectHint });
        else if (opts.fallbackProjectId) projectId = opts.fallbackProjectId;
        if (!projectId && d.isSubagent && d.parentExternalId) orphanSubagents.push({ sessionId: row.id, parentExternalId: d.parentExternalId, agent: d.agent });

        const rawFile = rawWriter.used ? rawWriter.file : archivePath;
        await db.session.update({
          where: { id: row.id },
          data: {
            projectId,
            title: s.title ? clip(redactSecrets(s.title), 200) : null,
            cwd: s.cwd,
            worktree,
            gitBranch: s.gitBranch,
            startedAt: s.startedAt,
            endedAt: s.endedAt,
            models: JSON.stringify(s.models),
            primaryModel: s.primaryModel,
            agentVersion: s.agentVersion,
            isSubagent: s.isSubagent,
            parentExternalId: s.parentExternalId,
            subagentId: s.subagentId,
            endState: s.endState,
            endStateDetail: s.endStateDetail,
            eventCount: s.eventCount,
            userMessageCount: s.userMessageCount,
            assistantMessageCount: s.assistantMessageCount,
            toolCallCount: s.toolCallCount,
            toolErrorCount: s.toolErrorCount,
            fileOpCount: s.fileOpCount,
            commandCount: s.commandCount,
            malformedLines: s.malformedLines,
            unknownRecordCount: s.unknownRecordCount,
            firstUserPrompt: s.firstUserPrompt,
            lastUserPrompt: s.lastUserPrompt,
            lastAssistantText: s.lastAssistantText,
            sourceSize: d.size,
            sourceMtime: d.mtime,
            sha256: isDb ? null : await sha256File(archivePath),
            archivePath: rawFile,
            providerMeta: JSON.stringify({ ...s.providerMeta, gitOps: s.gitOps, sourceArchive: archivePath }),
            importedAt: new Date(),
          },
        });
        for (let k = 0; k < fileOps.length; k += 400) {
          await db.fileOp.createMany({ data: fileOps.slice(k, k + 400).map((f) => ({ sessionId: row.id, projectId, eventSeq: f.eventSeq, path: f.path, op: f.op, toolName: f.toolName, toolUseId: f.toolUseId, timestamp: f.timestamp, succeeded: f.succeeded, linesAdded: f.linesAdded, linesRemoved: f.linesRemoved })) });
        }
        await ftsIndexSession(row.id);

        // 4. Derived knowledge: task candidates with evidence, and plans the agent wrote.
        result.tasks += await saveDerivedTasks(row.id, projectId, d.agent, deriveTasks(row.id, d.sourceKey, s));
        if (projectId) {
          for (const plan of s.plans) {
            const key = `plan:${h(d.sourceKey)}:${plan.seq}`;
            const body = clip(redactSecrets(plan.text), 30_000);
            const title = clip((plan.text.split('\n').find((l) => l.trim()) ?? 'Plan').replace(/^#+\s*/, ''), 140);
            await db.knowledgeItem.upsert({ where: { dedupeKey: key }, create: { projectId, sessionId: row.id, kind: 'plan', title, body, source: 'agent-plan', dedupeKey: key, occurredAt: plan.timestamp, evidence: JSON.stringify([{ type: 'plan', detail: 'Plan submitted by the agent via ExitPlanMode. A plan is intent, not proof of implementation.', sessionId: row.id, seq: plan.seq }]) }, update: { body, title } });
          }
        }
        result.malformedLines += s.malformedLines;
        result.imported++;
        pa.imported++;
      } catch (e) {
        result.failed++;
        pa.failed++;
        const msg = `${d.sourcePath}: ${(e as Error).message}`;
        result.errors.push(msg);
        rep.log(`FAILED ${msg}`);
      }
    }

    // Sessions whose working directory was never recorded: match the encoded folder name against known projects.
    for (const u of unresolved) {
      const loc = await projectForClaudeHint(u.hint);
      await db.session.update({ where: { id: u.sessionId }, data: { projectId: loc.projectId, worktree: loc.worktree } });
      await db.task.updateMany({ where: { sessionId: u.sessionId }, data: { projectId: loc.projectId } });
      await db.fileOp.updateMany({ where: { sessionId: u.sessionId }, data: { projectId: loc.projectId } });
    }
    for (const o of orphanSubagents) {
      const parent = await db.session.findFirst({ where: { agent: o.agent, externalId: o.parentExternalId, isSubagent: false }, select: { projectId: true, worktree: true } });
      const current = await db.session.findUnique({ where: { id: o.sessionId }, select: { projectId: true } });
      if (parent?.projectId && !current?.projectId) await db.session.update({ where: { id: o.sessionId }, data: { projectId: parent.projectId, worktree: parent.worktree } });
    }

    // Non-transcript assets: copied to the archive, and project memory notes indexed as knowledge.
    if (opts.includeAssets !== false && !result.cancelled) {
      for (const inv of inventories) {
        if (inv.agent !== 'claude-code' || !inv.exists) continue;
        const archiveRoot = archiveRootFor(inv.agent, inv.root);
        for (const rel of ['projects', 'file-history', 'plans', 'todos', 'paste-cache', 'history.jsonl']) {
          if (rep.isCancelled()) break;
          rep.progress(total, total, `Archiving ${rel} (safe copies)…`);
          const r = await archiveTree(inv.root, rel, archiveRoot, (n) => {
            if (n % 500 === 0) rep.progress(total, total, `Archiving ${rel}: ${n} files…`);
          });
          result.assetsCopied += r.copied;
          if (r.errors.length) result.errors.push(...r.errors.slice(0, 20));
          rep.log(`Archived ${rel}: ${r.files} file(s), ${r.copied} newly copied, ${r.skipped} skipped as sensitive.`);
        }
        for (const pd of inv.projectDirs) {
          const memDir = path.join(archiveRoot, 'projects', pd.name, 'memory');
          if (!fs.existsSync(memDir)) continue;
          const loc = await projectForClaudeHint(pd.name);
          for (const name of fs.readdirSync(memDir)) {
            if (!/\.(md|txt)$/i.test(name)) continue;
            const file = path.join(memDir, name);
            const body = clip(redactSecrets(fs.readFileSync(file, 'utf8')), 30_000);
            if (!body.trim()) continue;
            const key = `mem:${h(`${inv.root}|${pd.name}|${name}`)}`;
            await db.knowledgeItem.upsert({ where: { dedupeKey: key }, create: { projectId: loc.projectId, kind: 'memory', title: name, body, source: 'agent-memory', dedupeKey: key, occurredAt: fs.statSync(file).mtime, evidence: JSON.stringify([{ type: 'file', detail: `Claude Code project memory file: projects/${pd.name}/memory/${name}` }]) }, update: { body } });
          }
        }
      }
    }
    const pruned = await pruneLiveDuplicates();
    if (pruned) rep.log(`Removed ${pruned} live-captured session(s) now covered by the agent's own transcript (live originals stay in data/live).`);
    await refreshProjectStats();
  } finally {
    disposeOpencodeCopies();
    disposeWorkingCopies();
  }

  result.durationMs = Date.now() - started;
  rep.progress(total, total, result.cancelled ? 'Import cancelled.' : 'Import finished.');
  rep.log(`Imported ${result.imported}, unchanged ${result.skippedUnchanged}, failed ${result.failed}; ${result.events} events, ${result.tasks} task candidates, ${result.malformedLines} malformed line(s) preserved.`);
  return result;
}
