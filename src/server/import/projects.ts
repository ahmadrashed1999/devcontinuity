import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '../db';
import { pathKey, slugify } from '../security/paths';

const CLAUDE_WORKTREE = /^(.*?)[\\/]\.claude[\\/]worktrees[\\/]([^\\/]+)/i;

export interface ProjectLocation {
  root: string;
  worktree?: string;
  /** How the root was determined. */
  basis: 'claude-worktree' | 'git-worktree' | 'git-root' | 'cwd';
}

/**
 * Maps a session working directory to a project root. Worktrees (Claude's .claude/worktrees
 * and regular `git worktree` checkouts) fold into their main repository, and a subdirectory of
 * a repository folds into the repository root. Only the filesystem is read.
 */
export function locateProject(cwd: string): ProjectLocation {
  const m = cwd.match(CLAUDE_WORKTREE);
  if (m) return { root: m[1], worktree: m[2], basis: 'claude-worktree' };
  let dir = path.resolve(cwd);
  for (let i = 0; i < 40; i++) {
    const dotGit = path.join(dir, '.git');
    try {
      const st = fs.statSync(dotGit);
      if (st.isDirectory()) return { root: dir, basis: dir === path.resolve(cwd) ? 'cwd' : 'git-root' };
      if (st.isFile()) {
        const content = fs.readFileSync(dotGit, 'utf8');
        const g = content.match(/^gitdir:\s*(.+?)[\\/]\.git[\\/]worktrees[\\/]/m);
        if (g) return { root: path.resolve(dir, g[1]), worktree: path.basename(dir), basis: 'git-worktree' };
        return { root: dir, basis: 'git-root' };
      }
    } catch {
      /* no .git here (or the directory no longer exists) */
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { root: path.resolve(cwd), basis: 'cwd' };
}

function projectName(root: string): string {
  const base = path.basename(root);
  return base || root.replace(/[\\/]+$/, '') || root;
}

async function uniqueSlug(name: string): Promise<string> {
  const base = slugify(name);
  for (let i = 0; i < 500; i++) {
    const slug = i === 0 ? base : `${base}-${i + 1}`;
    if (!(await prisma().project.findUnique({ where: { slug } }))) return slug;
  }
  return `${base}-${Date.now()}`;
}

const cache = new Map<string, { projectId: string; worktree?: string }>();

export function clearProjectCache() {
  cache.clear();
}

/** Finds or creates the project for a working directory that was recorded in a transcript. */
export async function resolveProject(cwd: string | undefined): Promise<{ projectId: string; worktree?: string } | null> {
  if (!cwd || !path.isAbsolute(cwd)) return null;
  const ck = pathKey(cwd);
  const hit = cache.get(ck);
  if (hit) return hit;
  const loc = locateProject(cwd);
  const key = pathKey(loc.root);
  let project = await prisma().project.findUnique({ where: { pathKey: key } });
  if (!project) {
    const exists = fs.existsSync(loc.root);
    project = await prisma().project.create({
      data: {
        name: projectName(loc.root),
        slug: await uniqueSlug(projectName(loc.root)),
        rootPath: loc.root,
        pathKey: key,
        pathVerified: true,
        pathExists: exists,
        isGitRepo: exists && fs.existsSync(path.join(loc.root, '.git')),
      },
    });
  }
  const out = { projectId: project.id, worktree: loc.worktree };
  cache.set(ck, out);
  return out;
}

/** Creates a placeholder project for sessions whose working directory is only known from an encoded folder name. */
export async function resolveProjectFromHint(hint: string): Promise<string> {
  const key = `unresolved:${hint.toLowerCase()}`;
  let project = await prisma().project.findUnique({ where: { pathKey: key } });
  if (!project) {
    project = await prisma().project.create({
      data: { name: hint, slug: await uniqueSlug(hint), rootPath: `(unresolved) ${hint}`, pathKey: key, pathVerified: false, pathExists: false, isGitRepo: false },
    });
  }
  return project.id;
}

/** Recomputes derived project fields (activity range, whether the folder still exists). */
export async function refreshProjectStats(projectId?: string): Promise<void> {
  const db = prisma();
  const projects = await db.project.findMany({ where: projectId ? { id: projectId } : {} });
  for (const p of projects) {
    const agg = await db.session.aggregate({ where: { projectId: p.id }, _min: { startedAt: true }, _max: { endedAt: true } });
    const exists = p.pathVerified && fs.existsSync(p.rootPath);
    await db.project.update({
      where: { id: p.id },
      data: {
        firstActivityAt: agg._min.startedAt,
        lastActivityAt: agg._max.endedAt,
        pathExists: exists,
        isGitRepo: exists && fs.existsSync(path.join(p.rootPath, '.git')),
      },
    });
  }
}
