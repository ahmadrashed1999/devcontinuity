import { execFile } from 'node:child_process';
import { audit } from './audit';
import { parseJson, prisma } from './db';
import { getGitState } from './git/git';

/** GitHub via the gh CLI (uses the owner's existing gh login). Read-only, except PR creation after owner approval. */

const READ: string[][] = [['pr', 'list'], ['issue', 'list'], ['run', 'list'], ['repo', 'view'], ['auth', 'status']];

function gh(args: string[], cwd?: string): Promise<{ out: string; err: string; code: number }> {
  return new Promise((resolve) => {
    execFile('gh', args, { cwd, windowsHide: true, timeout: 30_000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' } }, (err, stdout, stderr) => {
      const code = err ? ((err as NodeJS.ErrnoException).code === 'ENOENT' ? 127 : ((err as { code?: number }).code ?? 1)) : 0;
      resolve({ out: String(stdout), err: String(stderr), code });
    });
  });
}

async function ghRead(args: string[]) {
  if (!READ.some((r) => r[0] === args[0] && r[1] === args[1])) throw new Error('gh command not allowed');
  return gh(args);
}

export function parseRepo(url: string): string | null {
  const m = url.match(/github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i);
  return m ? `${m[1]}/${m[2]}` : null;
}

export async function githubStatus() {
  const r = await ghRead(['auth', 'status']);
  if (r.code === 127) return { installed: false, authed: false, detail: 'GitHub CLI (gh) is not installed.' };
  return { installed: true, authed: r.code === 0, detail: (r.out + r.err).split('\n').filter((l) => /Logged in|account|not logged/i.test(l)).join(' ').trim().slice(0, 300) };
}

export async function projectGithub(projectId: string) {
  const p = await prisma().project.findUnique({ where: { id: projectId } });
  if (!p?.pathVerified) return { repo: null, error: 'Project folder unknown.' };
  const git = await getGitState(p.rootPath);
  const remote = git.remotes.find((r) => r.name === 'origin') ?? git.remotes[0];
  const repo = remote ? parseRepo(remote.url) : null;
  if (!repo) return { repo: null, error: 'No GitHub remote found for this repository.' };
  const [prs, issues, runs] = await Promise.all([
    ghRead(['pr', 'list', '--repo', repo, '--state', 'all', '--limit', '25', '--json', 'number,title,state,headRefName,url,updatedAt,author,isDraft']),
    ghRead(['issue', 'list', '--repo', repo, '--state', 'open', '--limit', '25', '--json', 'number,title,state,url,updatedAt,labels']),
    ghRead(['run', 'list', '--repo', repo, '--limit', '15', '--json', 'databaseId,name,status,conclusion,headBranch,url,createdAt,event']),
  ]);
  const err = [prs, issues, runs].find((r) => r.code !== 0);
  // Link PRs to the sessions that created them (Claude Code records pr-link entries).
  const sessions = await prisma().session.findMany({ where: { projectId }, select: { id: true, title: true, providerMeta: true } });
  const prSessions = new Map<string, { id: string; title: string | null }[]>();
  for (const s of sessions) {
    const meta = parseJson<{ pullRequests?: { url?: string }[]; gitOps?: { prUrl?: string }[] }>(s.providerMeta, {});
    for (const url of [...(meta.pullRequests ?? []).map((x) => x.url), ...(meta.gitOps ?? []).map((g) => g.prUrl)].filter((u): u is string => !!u)) prSessions.set(url, [...(prSessions.get(url) ?? []).filter((x) => x.id !== s.id), { id: s.id, title: s.title }]);
  }
  const parse = <T>(r: { out: string; code: number }): T[] => (r.code === 0 ? (JSON.parse(r.out || '[]') as T[]) : []);
  return {
    repo,
    error: err ? (err.err || err.out).trim().slice(0, 300) : undefined,
    prs: parse<{ number: number; title: string; state: string; url: string; headRefName: string; updatedAt: string; isDraft: boolean; author?: { login: string } }>(prs).map((x) => ({ ...x, sessions: prSessions.get(x.url) ?? [] })),
    issues: parse<{ number: number; title: string; url: string; updatedAt: string; labels: { name: string }[] }>(issues),
    runs: parse<{ databaseId: number; name: string; status: string; conclusion: string; headBranch: string; url: string; createdAt: string; event: string }>(runs),
  };
}

/** Owner-approved PR creation for a DevContinuity branch that was already pushed. */
export async function createPullRequest(repoPath: string, branch: string, title: string, body: string) {
  const r = await gh(['pr', 'create', '--head', branch, '--title', title.slice(0, 200), '--body', body.slice(0, 60_000)], repoPath);
  await audit('owner', 'github.pr.create', repoPath, { branch, ok: r.code === 0 });
  if (r.code !== 0) throw new Error((r.err || r.out).trim().slice(0, 400));
  return r.out.trim();
}
