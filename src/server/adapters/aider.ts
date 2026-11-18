import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '../db';
import { pathKey } from '../security/paths';
import { AgentAdapter, AgentInventory, DiscoveredSession, ParseContext, SessionAccumulator, SessionSink, clip } from './types';

/**
 * Aider keeps its history in the project folder: .aider.chat.history.md (the whole chat, appended
 * across runs, each run starting with "# aider chat started at …") and .aider.input.history (the
 * prompts with timestamps). Each run becomes one session. Project folders come from the projects
 * DevContinuity already knows, plus any folder added in Settings → Import roots.
 */

export const AIDER_KNOWN_PROJECTS = 'known DevContinuity projects';
const CHAT = '.aider.chat.history.md';
const INPUT = '.aider.input.history';
const START = /^# aider chat started at (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s*$/;
const MAX_BYTES = 100 * 1024 * 1024;

export interface AiderBlock {
  startedAt: string;
  /** Character offsets of the block inside the history file. */
  start: number;
  end: number;
}

/** Splits a chat history into runs. */
export function splitAiderRuns(text: string): AiderBlock[] {
  const out: AiderBlock[] = [];
  const re = /^# aider chat started at (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})[ \t]*$/gm;
  let m: RegExpExecArray | null;
  const starts: { at: string; index: number }[] = [];
  while ((m = re.exec(text))) starts.push({ at: m[1], index: m.index });
  starts.forEach((s, i) => out.push({ startedAt: s.at, start: s.index, end: i + 1 < starts.length ? starts[i + 1].index : text.length }));
  return out;
}

/** Prompt timestamps from .aider.input.history ("# 2024-05-01 10:00:00.123" then "+line" lines). */
export function parseAiderInputHistory(text: string): { at: Date; text: string }[] {
  const out: { at: Date; text: string }[] = [];
  let cur: { at: Date; lines: string[] } | null = null;
  for (const line of text.split(/\r?\n/)) {
    // "# 2024-05-01 10:00:00.123456": keep milliseconds (Date only parses up to three fraction digits).
    const h = /^# (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,3})?)/.exec(line);
    if (h) {
      if (cur?.lines.length) out.push({ at: cur.at, text: cur.lines.join('\n') });
      cur = { at: new Date(h[1].replace(' ', 'T')), lines: [] };
    } else if (cur && line.startsWith('+')) cur.lines.push(line.slice(1));
  }
  if (cur?.lines.length) out.push({ at: cur.at, text: cur.lines.join('\n') });
  return out;
}

type Group = { kind: 'user' | 'tool' | 'assistant'; lines: string[] };

/** Groups a run's lines: "#### " = user, "> " = Aider's own output, anything else = the model's answer. */
export function groupAiderLines(block: string): Group[] {
  const groups: Group[] = [];
  for (const raw of block.split(/\r?\n/)) {
    if (START.test(raw)) continue;
    const kind: Group['kind'] = raw.startsWith('#### ') || raw === '####' ? 'user' : raw.startsWith('> ') || raw === '>' ? 'tool' : 'assistant';
    const line = kind === 'user' ? raw.replace(/^####\s?/, '') : kind === 'tool' ? raw.replace(/^>\s?/, '') : raw;
    const last = groups[groups.length - 1];
    if (last && last.kind === kind) last.lines.push(line);
    else if (kind !== 'assistant' || line.trim()) groups.push({ kind, lines: [line] });
  }
  return groups.map((g) => ({ ...g, lines: trimLines(g.lines) })).filter((g) => g.lines.length);
}

function trimLines(lines: string[]): string[] {
  let a = 0;
  let b = lines.length;
  while (a < b && !lines[a].trim()) a++;
  while (b > a && !lines[b - 1].trim()) b--;
  return lines.slice(a, b);
}

const LIMIT_LINE = /RateLimitError|rate limit|quota|credit balance|insufficient_quota|429|overloaded/i;
const ERROR_LINE = /^(litellm\.\w*Error|.*Error:|Error |Unable to |API Error)/;

async function knownProjectDirs(): Promise<string[]> {
  try {
    const rows = await prisma().project.findMany({ where: { pathVerified: true, pathExists: true }, select: { rootPath: true } });
    return rows.map((r) => r.rootPath);
  } catch {
    return [];
  }
}

export const aiderAdapter: AgentAdapter = {
  id: 'aider',
  label: 'Aider',
  capabilities: {
    toolCalls: true,
    toolResults: true,
    thinking: false,
    subagents: false,
    fileSnapshots: false,
    todos: false,
    gitMetadata: true,
    maturity: 'tested-with-fixtures',
    notes: 'Reads .aider.chat.history.md (and prompt times from .aider.input.history) in the folders of known projects and any folder added as an import root. Each "aider chat started" run is one session; applied edits and Aider commits are recorded.',
  },

  defaultRoots() {
    return [AIDER_KNOWN_PROJECTS];
  },

  async scan(root: string): Promise<AgentInventory> {
    const inv: AgentInventory = { agent: 'aider', label: 'Aider', root, exists: true, sessions: [], projectDirs: [], assets: [], notes: [], unrecoverable: [], errors: [] };
    // An added root may be a project folder or a folder of projects.
    const dirs = root === AIDER_KNOWN_PROJECTS ? await knownProjectDirs() : [root, ...safeSubdirs(root)];
    if (root !== AIDER_KNOWN_PROJECTS) inv.exists = fs.existsSync(root);
    for (const dir of dirs) {
      const file = path.join(dir, CHAT);
      let st: fs.Stats;
      try {
        st = fs.statSync(file);
      } catch {
        continue;
      }
      if (st.size > MAX_BYTES) {
        inv.errors.push(`${file} is larger than 100 MB and was skipped.`);
        continue;
      }
      let text: string;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch (e) {
        inv.errors.push(`${file}: ${(e as Error).message}`);
        continue;
      }
      const runs = splitAiderRuns(text);
      const input = path.join(dir, INPUT);
      const key = pathKey(file);
      runs.forEach((r, i) => {
        const last = i === runs.length - 1;
        // Earlier runs never change, so their size/time identify them; only the last run grows.
        inv.sessions.push({
          agent: 'aider',
          externalId: `${path.basename(dir)}@${r.startedAt}`,
          sourcePath: file,
          sourceKey: `aider:${key}#${r.startedAt}`,
          size: r.end - r.start,
          mtime: last ? st.mtime : new Date(r.startedAt.replace(' ', 'T')),
          relPath: path.join(pathKey(dir).replace(/[^a-z0-9]+/gi, '_').slice(-80), CHAT),
          projectHint: dir,
          companions: fs.existsSync(input) ? [input] : undefined,
          extra: { cwd: dir, startedAt: r.startedAt, index: i },
        });
      });
      inv.projectDirs.push({ name: dir, sessions: runs.length, subagents: 0, bytes: st.size, lastWrite: st.mtime });
    }
    inv.assets.push({ kind: 'transcripts', label: 'Aider chat histories', count: inv.projectDirs.length, bytes: inv.projectDirs.reduce((a, d) => a + d.bytes, 0), archived: true });
    if (root === AIDER_KNOWN_PROJECTS && !inv.sessions.length) inv.notes.push('No .aider.chat.history.md found in known project folders. Add other folders under Settings → Import roots.');
    return inv;
  },

  async parse(d: DiscoveredSession, sink: SessionSink, ctx: ParseContext) {
    const acc = new SessionAccumulator(sink, { agent: 'aider', externalId: d.externalId, isSubagent: false });
    const s = acc.session;
    const cwd = typeof d.extra?.cwd === 'string' ? d.extra.cwd : path.dirname(d.sourcePath);
    s.cwd = cwd;
    acc.noteCwd(cwd);
    const text = fs.readFileSync(ctx.archivePath, 'utf8');
    const run = splitAiderRuns(text).find((r) => r.startedAt === d.extra?.startedAt);
    if (!run) return acc.finish();
    const started = new Date(run.startedAt.replace(' ', 'T'));
    acc.noteTime(started);
    const inputCopy = ctx.companions?.[0];
    const prompts = inputCopy && fs.existsSync(inputCopy) ? parseAiderInputHistory(fs.readFileSync(inputCopy, 'utf8')).filter((p) => p.at >= started) : [];
    const used = new Set<number>();
    let toolN = 0;

    for (const g of groupAiderLines(text.slice(run.start, run.end))) {
      const body = g.lines.join('\n');
      if (g.kind === 'user') {
        const idx = prompts.findIndex((p, i) => !used.has(i) && p.text.trim() === body.trim());
        if (idx >= 0) used.add(idx);
        const at = idx >= 0 ? prompts[idx].at : undefined;
        const seq = await acc.event({ kind: 'user_message', role: 'user', text: body, timestamp: at });
        if (body.startsWith('/')) acc.injectedUser();
        else acc.humanPrompt(seq, body, at);
        continue;
      }
      if (g.kind === 'assistant') {
        const seq = await acc.event({ kind: 'assistant_message', role: 'assistant', text: body });
        acc.assistantText(seq, body, 'final');
        continue;
      }
      // Aider's own output: applied edits, commits, commands, warnings and errors.
      for (const line of g.lines) {
        const edit = /^Applied edit to (.+)$/.exec(line.trim());
        const commit = /^Commit ([0-9a-f]{7,40}) (.+)$/.exec(line.trim());
        const run2 = /^Running (.+)$/.exec(line.trim());
        // Aider applies edits and commits after the model's answer, as part of the same turn, so they
        // are recorded as completed steps without changing how the turn ended.
        if (edit) {
          const id = `aider-${++toolN}`;
          const file = path.resolve(cwd, edit[1]);
          const seq = await acc.event({ kind: 'tool_result', role: 'tool', toolName: 'edit', toolUseId: id, text: line.trim(), filePath: file });
          s.toolCallCount++;
          acc.extraFileOp({ eventSeq: seq, path: file, op: 'edit', toolName: 'edit', toolUseId: id, succeeded: true });
        } else if (commit) {
          const seq = await acc.event({ kind: 'tool_result', role: 'tool', toolName: 'git', text: line.trim() });
          acc.gitOp({ kind: 'commit', sha: commit[1], seq });
        } else if (run2) {
          await acc.event({ kind: 'tool_result', role: 'tool', toolName: 'run', toolUseId: `aider-${++toolN}`, text: `$ ${run2[1]}`, command: run2[1] });
          s.toolCallCount++;
          s.commandCount++;
        } else if (LIMIT_LINE.test(line)) {
          await acc.event({ kind: 'error', role: 'system', text: line.trim(), isError: true });
          acc.apiError(line.trim());
        } else if (ERROR_LINE.test(line.trim())) {
          await acc.event({ kind: 'error', role: 'system', text: line.trim(), isError: true });
        }
      }
      const rest = g.lines.filter((l) => !/^(Applied edit to|Commit [0-9a-f]{7,40} |Running )/.test(l.trim())).join('\n').trim();
      if (rest) await acc.event({ kind: 'system', role: 'system', text: rest, isMeta: true });
    }
    // A run whose last step is a rate-limit error ends as api_error (set by acc.apiError above).
    const done = await acc.finish();
    done.title = done.firstUserPrompt ? clip(done.firstUserPrompt.split('\n')[0], 100) : `Aider run ${run.startedAt}`;
    Object.assign(done.providerMeta, { historyFile: CHAT, runStartedAt: run.startedAt });
    return done;
  },
};

function safeSubdirs(root: string): string[] {
  try {
    return fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules').map((e) => path.join(root, e.name));
  } catch {
    return [];
  }
}
