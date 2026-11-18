import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { audit } from '../audit';
import { dataPath } from '../config';
import { isInside } from '../security/paths';

/**
 * The only Git operations that change anything. Each is narrow and guarded:
 * - worktree add / commit / worktree remove: only inside DevContinuity's own data/worktrees sandbox.
 * - merge / push / PR: only called after an explicit owner approval, never force, never reset.
 */

export class GitWriteError extends Error {}

const REF = /^(?!-)(?!.*\.\.)[\w./-]{1,200}$/;
export function assertRef(ref: string): string {
  if (!REF.test(ref)) throw new GitWriteError(`Invalid ref: ${ref}`);
  return ref;
}

function run(cwd: string, args: string[], timeout = 120_000): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile('git', ['--no-pager', '-c', 'core.quotepath=false', '-C', cwd, ...args], { windowsHide: true, timeout, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat' } }, (err, stdout, stderr) => {
      resolve({ stdout: String(stdout), stderr: String(stderr), code: err ? ((err as { code?: number }).code ?? 1) : 0 });
    });
  });
}

function assertSandbox(p: string) {
  if (!isInside(p, dataPath('worktrees'))) throw new GitWriteError('Refusing: this operation is only allowed inside the DevContinuity worktree sandbox.');
}

export function sandboxPath(projectSlug: string, name: string): string {
  return path.join(dataPath('worktrees'), projectSlug, name);
}

export async function currentHead(repo: string): Promise<{ branch: string | null; sha: string }> {
  const b = await run(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const s = await run(repo, ['rev-parse', 'HEAD']);
  if (s.code !== 0) throw new GitWriteError('The repository has no commits yet.');
  return { branch: b.stdout.trim() === 'HEAD' ? null : b.stdout.trim(), sha: s.stdout.trim() };
}

/** Creates an isolated worktree on a new branch, outside the repository folder. */
export async function addWorktree(repo: string, worktree: string, branch: string, base: string): Promise<void> {
  assertSandbox(worktree);
  assertRef(branch);
  assertRef(base);
  if (fs.existsSync(worktree)) throw new GitWriteError(`${worktree} already exists.`);
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  const r = await run(repo, ['worktree', 'add', '-b', branch, worktree, base]);
  if (r.code !== 0) throw new GitWriteError(`git worktree add failed: ${r.stderr.trim().slice(0, 400)}`);
  await audit('system', 'git.worktree.add', repo, { worktree, branch, base });
}

/** Commits everything in a sandbox worktree. Uses the repository's own identity, with a DevContinuity fallback. */
export async function commitSandbox(worktree: string, message: string): Promise<string | null> {
  assertSandbox(worktree);
  await run(worktree, ['add', '-A']);
  const staged = await run(worktree, ['diff', '--cached', '--quiet']);
  if (staged.code === 0) return null;
  let r = await run(worktree, ['commit', '-m', message.slice(0, 2000)]);
  if (r.code !== 0 && /identity|user\.email|user\.name/i.test(r.stderr)) r = await run(worktree, ['-c', 'user.name=DevContinuity', '-c', 'user.email=devcontinuity@localhost', 'commit', '-m', message.slice(0, 2000)]);
  if (r.code !== 0) throw new GitWriteError(`Commit failed: ${r.stderr.trim().slice(0, 400)}`);
  return (await run(worktree, ['rev-parse', 'HEAD'])).stdout.trim();
}

export async function diffAgainst(worktree: string, base: string, maxBytes = 400_000): Promise<{ diff: string; stat: string; truncated: boolean }> {
  assertRef(base);
  const d = await run(worktree, ['diff', '--no-color', '--no-ext-diff', `${base}...HEAD`]);
  const s = await run(worktree, ['diff', '--stat', '--no-color', `${base}...HEAD`]);
  return { diff: d.stdout.slice(0, maxBytes), stat: s.stdout.trim(), truncated: d.stdout.length > maxBytes };
}

/** Owner-approved merge into the repository's current branch. Requires a clean working tree; aborts cleanly on conflicts. */
export async function mergeApproved(repo: string, branch: string, expectBranch?: string | null): Promise<{ merged: boolean; message: string }> {
  assertRef(branch);
  const head = await currentHead(repo);
  if (expectBranch && head.branch !== expectBranch) return { merged: false, message: `The repository is on "${head.branch}" but the work was based on "${expectBranch}". Switch branches yourself, then approve again.` };
  const st = await run(repo, ['status', '--porcelain', '--untracked-files=no']);
  if (st.stdout.trim()) return { merged: false, message: 'The repository has uncommitted changes. Commit or stash them yourself first; DevContinuity never touches uncommitted work.' };
  const r = await run(repo, ['merge', '--no-ff', '--no-edit', branch], 300_000);
  if (r.code !== 0) {
    await run(repo, ['merge', '--abort']);
    await audit('owner', 'git.merge.conflict', repo, { branch });
    return { merged: false, message: `Merge had conflicts and was aborted (the repository is unchanged). Resolve manually: git merge ${branch}` };
  }
  await audit('owner', 'git.merge', repo, { branch, into: head.branch });
  return { merged: true, message: `Merged ${branch} into ${head.branch ?? 'HEAD'}.` };
}

/** Owner-approved push of a DevContinuity branch (never force). */
export async function pushApproved(repo: string, branch: string): Promise<{ ok: boolean; message: string }> {
  assertRef(branch);
  const r = await run(repo, ['push', '-u', 'origin', branch], 300_000);
  await audit('owner', 'git.push', repo, { branch, ok: r.code === 0 });
  return { ok: r.code === 0, message: (r.code === 0 ? r.stderr || r.stdout : r.stderr).trim().slice(0, 600) };
}

/** Removes a sandbox worktree created by DevContinuity. Never forced: a worktree with changes is kept. */
export async function removeSandboxWorktree(repo: string, worktree: string): Promise<boolean> {
  assertSandbox(worktree);
  const r = await run(repo, ['worktree', 'remove', worktree]);
  await audit('system', 'git.worktree.remove', repo, { worktree, ok: r.code === 0 });
  return r.code === 0;
}
