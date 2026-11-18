import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '../db';

/** Read-only worktree analysis. Nothing here modifies a repository. */

function git(cwd: string, args: string[]): Promise<{ out: string; code: number }> {
  return new Promise((resolve) => {
    execFile('git', ['--no-optional-locks', '--no-pager', '-C', cwd, ...args], { windowsHide: true, timeout: 20_000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' } }, (err, stdout) => resolve({ out: String(stdout), code: err ? ((err as { code?: number }).code ?? 1) : 0 }));
  });
}

export type WorktreeState = 'at_risk' | 'unmerged' | 'merged' | 'missing' | 'clean' | 'main';

export interface WorktreeInfo {
  path: string;
  name: string;
  branch: string | null;
  head: string | null;
  exists: boolean;
  registered: boolean;
  isMain: boolean;
  dirty: number;
  ahead: number | null;
  merged: boolean | null;
  lastCommitAt: string | null;
  state: WorktreeState;
  stale: boolean;
  reasons: string[];
  sessions: { id: string; title: string | null; endedAt: string | null; endState: string; agent: string }[];
}

export function classify(w: Pick<WorktreeInfo, 'exists' | 'isMain' | 'dirty' | 'ahead' | 'merged'>): WorktreeState {
  if (w.isMain) return 'main';
  if (!w.exists) return 'missing';
  if (w.dirty > 0) return 'at_risk';
  if ((w.ahead ?? 0) > 0 && w.merged === false) return 'unmerged';
  if (w.merged) return 'merged';
  return 'clean';
}

async function defaultBranch(repo: string): Promise<string | null> {
  const sym = await git(repo, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  if (sym.code === 0 && sym.out.trim()) return sym.out.trim();
  for (const b of ['main', 'master', 'staging', 'develop']) if ((await git(repo, ['rev-parse', '--verify', '--quiet', b])).code === 0) return b;
  const cur = await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return cur.code === 0 ? cur.out.trim() : null;
}

export async function analyzeWorktrees(projectId: string): Promise<{ repo: string; defaultBranch: string | null; worktrees: WorktreeInfo[]; error?: string }> {
  const p = await prisma().project.findUnique({ where: { id: projectId } });
  if (!p) throw Object.assign(new Error('Project not found.'), { status: 404 });
  const repo = p.rootPath;
  if (!p.pathVerified || !fs.existsSync(path.join(repo, '.git'))) return { repo, defaultBranch: null, worktrees: [], error: 'Not a Git repository on this machine.' };
  const base = await defaultBranch(repo);
  const list = await git(repo, ['worktree', 'list', '--porcelain']);
  const entries: { path: string; head?: string; branch?: string }[] = [];
  let cur: { path: string; head?: string; branch?: string } | undefined;
  for (const l of list.out.split('\n')) {
    if (l.startsWith('worktree ')) entries.push((cur = { path: l.slice(9).trim() }));
    else if (cur && l.startsWith('HEAD ')) cur.head = l.slice(5).trim();
    else if (cur && l.startsWith('branch ')) cur.branch = l.slice(7).trim().replace('refs/heads/', '');
  }
  const norm = (s: string) => path.resolve(s).toLowerCase();
  const known = new Set(entries.map((e) => norm(e.path)));
  const claudeDir = path.join(repo, '.claude', 'worktrees');
  if (fs.existsSync(claudeDir)) for (const d of fs.readdirSync(claudeDir)) {
    const full = path.join(claudeDir, d);
    if (!known.has(norm(full)) && fs.statSync(full).isDirectory()) entries.push({ path: full });
  }

  const sessions = await prisma().session.findMany({ where: { projectId, isSubagent: false, worktree: { not: null } }, select: { id: true, title: true, endedAt: true, endState: true, agent: true, worktree: true, cwd: true }, orderBy: { endedAt: 'desc' } });
  const out: WorktreeInfo[] = [];
  for (const e of entries) {
    const isMain = norm(e.path) === norm(repo);
    const exists = fs.existsSync(e.path);
    const name = isMain ? '(main)' : path.basename(e.path);
    let dirty = 0;
    let ahead: number | null = null;
    let merged: boolean | null = null;
    let lastCommitAt: string | null = null;
    if (exists) {
      const st = await git(e.path, ['status', '--porcelain']);
      dirty = st.code === 0 ? st.out.split('\n').filter(Boolean).length : 0;
    }
    const ref = e.branch ?? e.head;
    if (ref && base && !isMain) {
      const a = await git(repo, ['rev-list', '--count', `${base}..${ref}`]);
      ahead = a.code === 0 ? Number(a.out.trim()) : null;
      merged = (await git(repo, ['merge-base', '--is-ancestor', ref, base])).code === 0;
    }
    if (ref) {
      const lc = await git(repo, ['log', '-1', '--format=%cI', ref]);
      lastCommitAt = lc.code === 0 ? lc.out.trim() || null : null;
    }
    const related = sessions.filter((s) => s.worktree && (s.worktree.toLowerCase() === name.toLowerCase() || (s.cwd && norm(s.cwd) === norm(e.path))));
    const lastActivity = [lastCommitAt, related[0]?.endedAt?.toISOString()].filter(Boolean).sort().pop() ?? null;
    const stale = !isMain && !!lastActivity && Date.now() - new Date(lastActivity).getTime() > 14 * 86400_000;
    const info: WorktreeInfo = { path: e.path, name, branch: e.branch ?? null, head: e.head?.slice(0, 12) ?? null, exists, registered: known.has(norm(e.path)), isMain, dirty, ahead, merged, lastCommitAt, state: 'clean', stale, reasons: [], sessions: related.slice(0, 5).map((s) => ({ id: s.id, title: s.title, endedAt: s.endedAt?.toISOString() ?? null, endState: s.endState, agent: s.agent })) };
    info.state = classify(info);
    if (dirty) info.reasons.push(`${dirty} uncommitted change(s) — work that exists only in this folder`);
    if (info.state === 'unmerged') info.reasons.push(`${ahead} commit(s) not in ${base}`);
    if (info.state === 'merged') info.reasons.push(`fully merged into ${base}`);
    if (!exists) info.reasons.push('folder no longer exists (git can prune it)');
    if (!info.registered && exists) info.reasons.push('folder exists but is not registered with git worktree');
    if (stale) info.reasons.push('no activity for 14+ days');
    const lastSession = info.sessions[0];
    if (lastSession && ['interrupted_tool', 'interrupted_response', 'awaiting_assistant', 'api_error'].includes(lastSession.endState)) info.reasons.push(`last session ended: ${lastSession.endState.replace(/_/g, ' ')}`);
    out.push(info);
  }
  const order: Record<WorktreeState, number> = { at_risk: 0, unmerged: 1, missing: 2, clean: 3, merged: 4, main: 5 };
  out.sort((a, b) => order[a.state] - order[b.state] || (b.lastCommitAt ?? '').localeCompare(a.lastCommitAt ?? ''));
  return { repo, defaultBranch: base, worktrees: out };
}
