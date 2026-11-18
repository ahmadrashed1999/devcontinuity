import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { homeDir } from '../config';
import { pathKey } from '../security/paths';
import { fileUriToPath } from './editors';
import { cachedWorkingCopy, hasTable, openWorkingCopy } from './sqlite-util';
import { AgentAdapter, AgentInventory, DiscoveredSession, ParseContext, SessionAccumulator, SessionSink, clip, str } from './types';

type Row = Record<string, unknown>;

const SUMMARIES_DB = 'conversation_summaries.db';

/** "2026-11-15 22:53:20.6088136+00:00" → Date. Go zero time ("0001-01-01…") → undefined. */
export function agyDate(v: unknown): Date | undefined {
  if (typeof v !== 'string' || !v || v.startsWith('0001-')) return undefined;
  const iso = v.trim().replace(' ', 'T').replace(/(\.\d{3})\d+/, '$1').replace(/\+00:00$/, 'Z');
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/**
 * Antigravity keeps the conversation itself as protobuf steps (no published schema), but its own
 * search index stores the plain text of every user and agent step, chunked, with a JSON list of
 * [stepIndex, byteOffset] pairs per chunk. Splitting the bodies at those offsets gives the
 * transcript in step order without decoding the protobuf.
 */
export function splitSteps(body: unknown, offsets: unknown): { step: number; text: string }[] {
  if (typeof body !== 'string' || !body) return [];
  let pairs: unknown;
  try {
    pairs = JSON.parse(Buffer.from(offsets as Uint8Array).toString('utf8'));
  } catch {
    return [{ step: -1, text: body }];
  }
  if (!Array.isArray(pairs) || pairs.length === 0) return [{ step: -1, text: body }];
  const buf = Buffer.from(body, 'utf8');
  const list = pairs.filter((p): p is [number, number] => Array.isArray(p) && typeof p[0] === 'number' && typeof p[1] === 'number').sort((a, b) => a[1] - b[1]);
  return list.map(([step, off], i) => ({ step, text: buf.subarray(off, i + 1 < list.length ? list[i + 1][1] : buf.length).toString('utf8').trim() })).filter((x) => x.text);
}

function brainFiles(root: string, id: string): string[] {
  const dir = path.join(root, 'brain', id);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((n) => /\.md$/i.test(n))
    .map((n) => path.join(dir, n))
    .filter((f) => fs.statSync(f).isFile());
}

export const antigravityAdapter: AgentAdapter = {
  id: 'antigravity',
  label: 'Antigravity',
  capabilities: {
    toolCalls: false,
    toolResults: false,
    thinking: false,
    subagents: true,
    fileSnapshots: false,
    todos: false,
    gitMetadata: false,
    maturity: 'verified',
    notes: 'Reads conversations from Antigravity\'s own search index: titles, workspace, sub-agents, and the text of every user and agent step in order. Plans and walkthroughs from brain/ are kept as plans. Tool calls are stored only as undocumented protobuf, so they are not shown; connect Antigravity through MCP (npm run dc -- connect antigravity) to log them.',
  },

  defaultRoots() {
    const g = path.join(homeDir(), '.gemini');
    return [path.join(g, 'antigravity'), path.join(g, 'antigravity-ide')];
  },

  async scan(root: string): Promise<AgentInventory> {
    const inv: AgentInventory = { agent: 'antigravity', label: path.basename(root) === 'antigravity-ide' ? 'Antigravity IDE' : 'Antigravity', root, exists: fs.existsSync(root), sessions: [], projectDirs: [], assets: [], notes: [], unrecoverable: [], errors: [] };
    if (!inv.exists) return inv;
    const file = path.join(root, SUMMARIES_DB);
    if (!fs.existsSync(file)) {
      inv.notes.push(`${SUMMARIES_DB} not found; nothing to import yet.`);
      return inv;
    }
    let w: { db: DatabaseSync; dispose: () => void } | undefined;
    try {
      w = openWorkingCopy(file);
      if (!hasTable(w.db, 'conversation_summaries')) {
        inv.errors.push('conversation_summaries table not found: this Antigravity version stores conversations differently.');
        return inv;
      }
      const rows = w.db.prepare('SELECT conversation_id, title, step_count, last_modified_time, workspace_uris, parent_conversation_id, agent_name FROM conversation_summaries').all() as Row[];
      for (const r of rows) {
        const id = String(r.conversation_id);
        let cwd: string | undefined;
        try {
          cwd = fileUriToPath((JSON.parse(String(r.workspace_uris ?? '[]')) as string[])[0]);
        } catch {
          /* no workspace */
        }
        const companions = brainFiles(root, id);
        inv.sessions.push({
          agent: 'antigravity',
          externalId: id,
          sourcePath: file,
          sourceKey: `antigravity:${pathKey(file)}#${id}`,
          // Step count plus artifact sizes changes whenever the conversation does.
          size: Number(r.step_count ?? 0) + companions.reduce((a, f) => a + fs.statSync(f).size, 0),
          mtime: agyDate(r.last_modified_time) ?? new Date(0),
          relPath: SUMMARIES_DB,
          projectHint: cwd,
          isSubagent: !!str(r.parent_conversation_id),
          parentExternalId: str(r.parent_conversation_id),
          subagentId: str(r.agent_name),
          companions,
        });
      }
      inv.assets.push({ kind: 'database', label: 'Conversation index', count: 1, bytes: fs.statSync(file).size, archived: true });
      const convDir = path.join(root, 'conversations');
      if (fs.existsSync(convDir)) inv.assets.push({ kind: 'protobuf', label: 'Raw conversation steps (protobuf)', count: fs.readdirSync(convDir).length, bytes: 0, archived: false, note: 'Undocumented binary format; text is taken from the conversation index instead.' });
      inv.unrecoverable.push('Tool calls and their results (stored only as undocumented protobuf).');
    } catch (e) {
      inv.errors.push(`${SUMMARIES_DB}: ${(e as Error).message}`);
    } finally {
      w?.dispose();
    }
    return inv;
  },

  async parse(d: DiscoveredSession, sink: SessionSink, ctx: ParseContext) {
    const db = cachedWorkingCopy(ctx.archivePath);
    const acc = new SessionAccumulator(sink, { agent: 'antigravity', externalId: d.externalId, isSubagent: !!d.isSubagent, parentExternalId: d.parentExternalId, subagentId: d.subagentId });
    const s = acc.session;
    s.cwd = d.projectHint;
    const sum = db.prepare('SELECT * FROM conversation_summaries WHERE conversation_id = ?').get(d.externalId) as Row | undefined;
    if (sum) {
      s.title = str(sum.title) ?? str(sum.preview);
      Object.assign(s.providerMeta, { status: sum.status ?? null, stepCount: sum.step_count ?? null, agentName: sum.agent_name || null, killed: !!Number(sum.killed), projectId: sum.project_id || null });
    }

    const steps: { step: number; role: 'user' | 'agent'; text: string }[] = [];
    if (hasTable(db, 'conversations_fts_content')) {
      // c0 conversation_id, c1 chunk_index, c8/c9 user/agent step offsets, c13/c14 user/agent body.
      const chunks = db.prepare('SELECT c1 AS chunk, c8 AS uo, c9 AS ao, c13 AS ub, c14 AS ab FROM conversations_fts_content WHERE c0 = ? ORDER BY c1').all(d.externalId) as Row[];
      for (const c of chunks) {
        for (const x of splitSteps(c.ub, c.uo)) steps.push({ ...x, role: 'user' });
        for (const x of splitSteps(c.ab, c.ao)) steps.push({ ...x, role: 'agent' });
      }
    }
    steps.sort((a, b) => a.step - b.step || (a.role === 'user' ? -1 : 1));
    const end = agyDate(sum?.last_modified_time);
    for (const st of steps) {
      const r = ctx.writeRaw?.({ conversationId: d.externalId, step: st.step, role: st.role, text: st.text });
      const raw = r ? { rawOffset: r.offset, rawLength: r.length } : {};
      if (st.role === 'user') {
        const seq = await acc.event({ ...raw, kind: 'user_message', role: 'user', text: st.text, meta: { step: st.step }, isMeta: !!d.isSubagent, subtype: d.isSubagent ? 'delegated_prompt' : undefined });
        if (d.isSubagent) acc.injectedUser();
        else acc.humanPrompt(seq, st.text, undefined, `step-${st.step}`);
      } else {
        const seq = await acc.event({ ...raw, kind: 'assistant_message', role: 'assistant', text: st.text, meta: { step: st.step } });
        acc.assistantText(seq, st.text, 'unknown');
      }
    }

    for (const f of ctx.companions ?? []) {
      if (!f) continue;
      const text = fs.readFileSync(f, 'utf8');
      if (!text.trim()) continue;
      s.plans.push({ text: `${path.basename(f)}\n\n${text}`, seq: acc.nextSeq });
      await acc.event({ kind: 'attachment', rawType: 'brain-artifact', text: clip(text, 12_000), filePath: path.basename(f) });
    }

    const done = await acc.finish();
    if (end) done.endedAt = end;
    if (sum && Number(sum.killed)) {
      done.endState = 'interrupted_response';
      done.endStateDetail = 'Antigravity marked this conversation as killed.';
    } else if (sum && /RUNNING|BUSY/i.test(String(sum.status ?? ''))) {
      done.endState = 'interrupted_response';
      done.endStateDetail = `Antigravity reported the run status as ${String(sum.status)} when it was last saved.`;
    }
    if (!done.title && done.firstUserPrompt) done.title = clip(done.firstUserPrompt.split('\n')[0], 120);
    if (!done.title && d.subagentId) done.title = `Sub-agent: ${d.subagentId}`;
    if (steps.length === 0 && done.endState === 'empty') {
      done.endStateDetail = `Antigravity did not index the text of this ${d.isSubagent ? 'sub-agent ' : ''}conversation (${Number(sum?.step_count ?? 0)} steps exist only as undocumented protobuf). Its title, folder and timing are shown.`;
    }
    done.providerMeta.textSource = 'conversation_summaries.db (search index)';
    return done;
  },
};
