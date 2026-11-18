import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { redactSecrets } from '../security/redact';

/**
 * Read-only Git access. Every invocation goes through `git()` below, which refuses any
 * subcommand that is not on the read-only allowlist. There is no code path in DevContinuity
 * that can commit, reset, clean, checkout, stash or push.
 */
const READ_ONLY: Record<string, (args: string[]) => boolean> = {
  'rev-parse': () => true,
  status: () => true,
  log: () => true,
  diff: (a) => !a.includes('--output') && !a.some((x) => x.startsWith('--output=')),
  'cat-file': (a) => a.includes('-e') || a.includes('-t'),
  worktree: (a) => a[1] === 'list',
  remote: (a) => a.length === 2 && a[1] === '-v',
};

export class GitError extends Error {}

function git(repo: string, args: string[], opts: { maxBuffer?: number; allowFail?: boolean } = {}): Promise<{ stdout: string; code: number }> {
  const sub = args[0];
  if (!READ_ONLY[sub] || !READ_ONLY[sub](args)) return Promise.reject(new GitError(`Git command not allowed: ${sub}`));
  // Safe defaults: no optional index locks, no pagers, no prompts, no external diff/textconv/fsmonitor programs.
  const full = ['--no-optional-locks', '--no-pager', '-c', 'core.quotepath=false', '-c', 'core.fsmonitor=false', '-C', repo, ...args];
  return new Promise((resolve, reject) => {
    execFile('git', full, { windowsHide: true, timeout: 20_000, maxBuffer: opts.maxBuffer ?? 8 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat' } }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number' ? ((err as unknown as { code: number }).code) : 1) : 0;
      if (err && !opts.allowFail) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return reject(new GitError('Git is not installed or not on PATH.'));
        return reject(new GitError((stderr || err.message).toString().trim().slice(0, 500)));
      }
      resolve({ stdout: stdout.toString(), code });
    });
  });
}

export interface GitChange {
  path: string;
  origPath?: string;
  /** modified | added | deleted | renamed | untracked | conflicted | copied | type_changed */
  kind: string;
  staged: boolean;
  unstaged: boolean;
}

export interface GitCommit {
  sha: string;
  shortSha: string;
  author: string;
  date: string;
  subject: string;
}

export interface GitState {
  isRepo: boolean;
  repoPath: string;
  capturedAt: string;
  error?: string;
  branch?: string;
  detached?: boolean;
  upstream?: string;
  ahead?: number;
  behind?: number;
  head?: GitCommit;
  changes: GitChange[];
  counts: { modified: number; added: number; deleted: number; renamed: number; untracked: number; conflicted: number; staged: number; total: number };
  recentCommits: GitCommit[];
  worktrees: { path: string; branch?: string; head?: string }[];
  remotes: { name: string; url: string }[];
}

const KIND: Record<string, string> = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', T: 'type_changed', U: 'conflicted' };

export function parseStatus(out: string): Pick<GitState, 'branch' | 'detached' | 'upstream' | 'ahead' | 'behind' | 'changes'> {
  const res: ReturnType<typeof parseStatus> = { changes: [] };
  for (const line of out.split('\n')) {
    if (!line) continue;
    if (line.startsWith('## ')) {
      const head = line.slice(3);
      if (head.startsWith('HEAD (no branch)')) {
        res.detached = true;
        continue;
      }
      const m = head.match(/^(?:No commits yet on )?(.+?)(?:\.\.\.(\S+))?(?: \[(.+)\])?$/);
      if (m) {
        res.branch = m[1];
        res.upstream = m[2];
        res.ahead = Number(m[3]?.match(/ahead (\d+)/)?.[1] ?? 0);
        res.behind = Number(m[3]?.match(/behind (\d+)/)?.[1] ?? 0);
      }
      continue;
    }
    const x = line[0];
    const y = line[1];
    let p = line.slice(3);
    let orig: string | undefined;
    if ((x === 'R' || x === 'C') && p.includes(' -> ')) [orig, p] = p.split(' -> ');
    const unq = (s: string) => (s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s);
    let kind: string;
    if (x === '?' && y === '?') kind = 'untracked';
    else if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) kind = 'conflicted';
    else kind = KIND[x !== ' ' ? x : y] ?? 'modified';
    res.changes.push({ path: unq(p), origPath: orig ? unq(orig) : undefined, kind, staged: x !== ' ' && x !== '?', unstaged: y !== ' ' && y !== '?' });
  }
  return res;
}

function parseLog(out: string): GitCommit[] {
  return out
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [sha, shortSha, author, date, ...rest] = l.split('\x1f');
      return { sha, shortSha, author, date, subject: redactSecrets(rest.join(' ')) };
    });
}

const LOG_FORMAT = '--pretty=format:%H%x1f%h%x1f%an%x1f%aI%x1f%s';

/** Snapshot of a repository's current state. Reads only; safe to call on a dirty tree. */
export async function getGitState(repoPath: string): Promise<GitState> {
  const base: GitState = { isRepo: false, repoPath, capturedAt: new Date().toISOString(), changes: [], counts: { modified: 0, added: 0, deleted: 0, renamed: 0, untracked: 0, conflicted: 0, staged: 0, total: 0 }, recentCommits: [], worktrees: [], remotes: [] };
  if (!fs.existsSync(repoPath)) return { ...base, error: 'The folder no longer exists on this machine.' };
  if (!fs.existsSync(path.join(repoPath, '.git'))) return { ...base, error: 'This folder is not a Git repository.' };
  try {
    const status = await git(repoPath, ['status', '--porcelain=v1', '--branch', '--untracked-files=normal']);
    Object.assign(base, parseStatus(status.stdout), { isRepo: true });
    for (const c of base.changes) {
      if (c.kind in base.counts) (base.counts as Record<string, number>)[c.kind]++;
      if (c.staged) base.counts.staged++;
    }
    base.counts.total = base.changes.length;
    const log = await git(repoPath, ['log', '-n', '25', LOG_FORMAT], { allowFail: true });
    base.recentCommits = log.code === 0 ? parseLog(log.stdout) : [];
    base.head = base.recentCommits[0];
    const wt = await git(repoPath, ['worktree', 'list', '--porcelain'], { allowFail: true });
    if (wt.code === 0) {
      let cur: { path: string; branch?: string; head?: string } | undefined;
      for (const l of wt.stdout.split('\n')) {
        if (l.startsWith('worktree ')) {
          cur = { path: l.slice(9) };
          base.worktrees.push(cur);
        } else if (cur && l.startsWith('HEAD ')) cur.head = l.slice(5, 17);
        else if (cur && l.startsWith('branch ')) cur.branch = l.slice(7).replace('refs/heads/', '');
      }
    }
    const rem = await git(repoPath, ['remote', '-v'], { allowFail: true });
    if (rem.code === 0) {
      const seen = new Set<string>();
      for (const l of rem.stdout.split('\n')) {
        const m = l.match(/^(\S+)\s+(\S+)\s+\(fetch\)/);
        if (m && !seen.has(m[1])) {
          seen.add(m[1]);
          base.remotes.push({ name: m[1], url: redactSecrets(m[2]) });
        }
      }
    }
  } catch (e) {
    base.error = (e as Error).message;
  }
  return base;
}

const MAX_DIFF = 400 * 1024;

/** Diff of the working tree (or index) for one file or the whole repository. Only what Git itself can show now. */
export async function getDiff(repoPath: string, opts: { file?: string; staged?: boolean } = {}): Promise<{ diff: string; truncated: boolean }> {
  const args = ['diff', '--no-color', '--no-ext-diff', '--no-textconv'];
  if (opts.staged) args.push('--cached');
  if (opts.file) {
    const rel = opts.file.replace(/\\/g, '/');
    if (path.isAbsolute(rel) || rel.split('/').includes('..')) throw new GitError('The file path must be relative to the repository.');
    args.push('--', rel);
  }
  const { stdout } = await git(repoPath, args, { maxBuffer: 64 * 1024 * 1024 });
  const red = redactSecrets(stdout.length > MAX_DIFF ? stdout.slice(0, MAX_DIFF) : stdout);
  return { diff: red, truncated: stdout.length > MAX_DIFF };
}

export async function getDiffStat(repoPath: string): Promise<string> {
  const { stdout } = await git(repoPath, ['diff', '--stat', '--no-color', '--no-ext-diff', 'HEAD'], { allowFail: true });
  return stdout.trim();
}

/** True when a commit recorded in a transcript really exists in the repository today. */
export async function commitExists(repoPath: string, sha: string): Promise<boolean> {
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) return false;
  if (!fs.existsSync(path.join(repoPath, '.git'))) return false;
  const r = await git(repoPath, ['cat-file', '-e', `${sha}^{commit}`], { allowFail: true }).catch(() => ({ code: 1 }));
  return r.code === 0;
}

export async function commitsSince(repoPath: string, sinceIso: string, limit = 50): Promise<GitCommit[]> {
  const r = await git(repoPath, ['log', '-n', String(limit), `--since=${sinceIso}`, LOG_FORMAT], { allowFail: true }).catch(() => ({ stdout: '', code: 1 }));
  return r.code === 0 ? parseLog(r.stdout) : [];
}
