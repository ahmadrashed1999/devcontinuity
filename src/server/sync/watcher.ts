import fs from 'node:fs';
import path from 'node:path';
import { resolveRoots } from '../adapters';
import type { AgentId } from '../adapters/types';
import { notify } from '../audit';
import { getFallbackAgent, isLimitEnding, limitNotice, rankTargets } from '../handoff/limit';
import { prisma, setSetting } from '../db';
import { runImport, silentReporter } from '../import/importer';
import { isLocked, withLock } from '../lock';

/**
 * Background auto-sync. Watches the agents' data folders (read-only) and imports new or changed
 * sessions after a quiet period, so a session is imported once the agent stops writing to it.
 */

const QUIET_MS = 45_000;
const MAX_WAIT_MS = 10 * 60_000;
const POLL_MS = 5 * 60_000;

/** Agents kept in sync automatically (Cursor and generic uploads are imported on request). */
const AUTO_SYNC_AGENTS: AgentId[] = ['claude-code', 'codex', 'opencode', 'antigravity', 'cline', 'copilot', 'continue', 'live'];

/** Which changed files (path relative to the watched folder) mean a session changed. */
const WATCH_FILTER: Partial<Record<AgentId, RegExp>> = {
  'claude-code': /\.jsonl$/i,
  codex: /\.jsonl(\.zst)?$/i,
  opencode: /\.db(-wal)?$/i,
  antigravity: /(^|\/)(conversation_summaries\.db(-wal)?|brain\/.+\.md)$/i,
  cline: /(api_conversation_history|ui_messages)\.json$/i,
  copilot: /chatSessions\/[^/]+\.jsonl?$/i,
  continue: /\.json$/i,
  live: /\.jsonl$/i,
};

interface Pending {
  first: number;
  last: number;
}

export class AutoSync {
  private watchers: fs.FSWatcher[] = [];
  private pending = new Map<AgentId, Pending>();
  private timer?: NodeJS.Timeout;
  private lastPoll = 0;
  private running = false;
  log: (m: string) => void = () => {};

  async start() {
    const targets: { agent: AgentId; dir: string }[] = [];
    for (const r of await resolveRoots('claude-code')) targets.push({ agent: 'claude-code', dir: path.join(r, 'projects') });
    for (const r of await resolveRoots('codex')) targets.push({ agent: 'codex', dir: path.join(r, 'sessions') });
    for (const r of await resolveRoots('opencode')) targets.push({ agent: 'opencode', dir: r });
    for (const r of await resolveRoots('antigravity')) targets.push({ agent: 'antigravity', dir: r });
    for (const r of await resolveRoots('cline')) targets.push({ agent: 'cline', dir: path.join(r, 'tasks') });
    for (const r of await resolveRoots('copilot')) targets.push({ agent: 'copilot', dir: r });
    for (const r of await resolveRoots('continue')) targets.push({ agent: 'continue', dir: r });
    for (const r of await resolveRoots('live')) targets.push({ agent: 'live', dir: r });
    for (const t of targets) {
      if (!fs.existsSync(t.dir)) continue;
      try {
        const w = fs.watch(t.dir, { recursive: true, persistent: true }, (_e, file) => {
          if (WATCH_FILTER[t.agent]?.test(String(file ?? '').replace(/\\/g, '/'))) this.touch(t.agent);
        });
        w.on('error', (e) => this.log(`watch error on ${t.dir}: ${e.message}`));
        this.watchers.push(w);
        this.log(`watching ${t.agent}: ${t.dir}`);
      } catch (e) {
        this.log(`cannot watch ${t.dir}: ${(e as Error).message} (polling only)`);
      }
    }
    this.timer = setInterval(() => void this.tick(), 5000);
    this.lastPoll = Date.now();
  }

  stop() {
    for (const w of this.watchers) w.close();
    this.watchers = [];
    if (this.timer) clearInterval(this.timer);
  }

  touch(agent: AgentId) {
    const now = Date.now();
    const p = this.pending.get(agent);
    if (p) p.last = now;
    else this.pending.set(agent, { first: now, last: now });
  }

  private async tick() {
    if (this.running) return;
    const now = Date.now();
    const due = [...this.pending.entries()].filter(([, p]) => now - p.last >= QUIET_MS || now - p.first >= MAX_WAIT_MS).map(([a]) => a);
    if (!due.length && now - this.lastPoll >= POLL_MS) {
      this.lastPoll = now;
      due.push(...AUTO_SYNC_AGENTS);
    }
    if (!due.length) return;
    for (const a of due) this.pending.delete(a);
    this.running = true;
    try {
      await this.syncNow(due);
    } finally {
      this.running = false;
    }
  }

  async syncNow(agents: AgentId[]) {
    const since = new Date();
    const r = await withLock('import', 30 * 60_000, () => runImport({ agents, includeAssets: false }, silentReporter));
    if (isLocked(r)) {
      for (const a of agents) this.touch(a);
      return;
    }
    await setSetting('lastAutoSync', { at: new Date().toISOString(), agents, imported: r.imported, failed: r.failed });
    if (r.imported) this.log(`auto-sync: imported ${r.imported} session(s) from ${agents.join(', ')}`);
    if (r.imported) await notifyEndings(since);
  }
}

/** Tells the owner about sessions that just ended, especially when they stopped on a limit or error. */
export async function notifyEndings(since: Date) {
  const db = prisma();
  const recent = await db.session.findMany({ where: { importedAt: { gte: since }, isSubagent: false, endedAt: { gte: new Date(Date.now() - 24 * 3600_000) } }, include: { project: { select: { name: true } } } });
  const fallback = recent.length ? await getFallbackAgent() : 'codex';
  for (const s of recent) {
    const where = s.project?.name ?? s.cwd ?? 'unknown project';
    const link = `/sessions/${s.id}?tab=continue`;
    const key = `ending-${s.id}-${s.endedAt?.getTime()}`;
    if (isLimitEnding(s.endState, s.endStateDetail)) {
      // Actionable: the Overview's "Needs attention" card continues it in the preferred fallback agent.
      const target = rankTargets(s.agent, fallback)[0];
      const n = limitNotice(s.agent, where, s.endStateDetail, target);
      await notify('error', n.title, n.body, `/?handoff=${s.id}`, key);
    }
    else if (s.endState === 'api_error') await notify('error', `Agent stopped with an error in ${where}`, s.endStateDetail ?? undefined, link, key);
    else if (['interrupted_tool', 'interrupted_response', 'awaiting_assistant'].includes(s.endState)) await notify('warning', `Session interrupted in ${where}`, `${s.title ?? s.externalId}: ${s.endStateDetail ?? ''}`, link, key);
    // Finished sessions appear in the activity feed; only problems are worth a notification.
  }
}
