import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { homeDir } from '../config';
import { pathKey } from '../security/paths';
import { hasTable, openWorkingCopy } from './sqlite-util';
import { AgentAdapter, AgentInventory, DiscoveredSession, FileOpKind, ParseContext, SessionAccumulator, SessionSink, asRecord, compactJson, str, toDate } from './types';

type Rec = Record<string, unknown>;
type Row = Record<string, unknown>;

const FILE_TOOLS: Record<string, FileOpKind> = { read: 'read', write: 'write', edit: 'edit', multiedit: 'edit', patch: 'edit', apply_patch: 'edit' };

function json(v: unknown): Rec {
  if (typeof v !== 'string') return {};
  try {
    return asRecord(JSON.parse(v)) ?? {};
  } catch {
    return {};
  }
}

// Working copies are cached per archive path for the duration of an import run.
const open = new Map<string, { db: DatabaseSync; dispose: () => void }>();
function working(dbFile: string): DatabaseSync {
  let w = open.get(dbFile);
  if (!w) {
    w = openWorkingCopy(dbFile);
    open.set(dbFile, w);
  }
  return w.db;
}

export function disposeOpencodeCopies(): void {
  for (const w of open.values()) w.dispose();
  open.clear();
}

export const opencodeAdapter: AgentAdapter = {
  id: 'opencode',
  label: 'OpenCode',
  capabilities: {
    toolCalls: true,
    toolResults: true,
    thinking: true,
    subagents: true,
    fileSnapshots: false,
    todos: true,
    gitMetadata: false,
    maturity: 'verified',
    notes: 'Reads sessions, messages, parts and todos from the OpenCode SQLite database through a private working copy. Legacy JSON-file storage from old OpenCode versions is not parsed.',
  },

  defaultRoots() {
    const roots = [process.env.XDG_DATA_HOME ? path.join(process.env.XDG_DATA_HOME, 'opencode') : undefined, path.join(homeDir(), '.local', 'share', 'opencode')].filter((r): r is string => !!r);
    return [...new Set(roots.map((r) => path.resolve(r)))];
  },

  async scan(root: string): Promise<AgentInventory> {
    const inv: AgentInventory = { agent: 'opencode', label: 'OpenCode', root, exists: fs.existsSync(root), sessions: [], projectDirs: [], assets: [], notes: [], unrecoverable: [], errors: [] };
    if (!inv.exists) return inv;
    const dbs = fs.readdirSync(root).filter((n) => /^opencode.*\.db$/i.test(n));
    let bytes = 0;
    for (const name of dbs) {
      const file = path.join(root, name);
      bytes += fs.statSync(file).size;
      let w: ReturnType<typeof openWorkingCopy> | undefined;
      try {
        w = openWorkingCopy(file);
        if (!hasTable(w.db, 'session') || !hasTable(w.db, 'part')) {
          inv.notes.push(`${name}: no session/part tables found; skipped.`);
          continue;
        }
        const rows = w.db.prepare('SELECT s.id, s.parent_id, s.directory, s.time_updated, (SELECT count(*) FROM part p WHERE p.session_id = s.id) AS parts FROM session s').all() as Row[];
        for (const r of rows) {
          const id = String(r.id);
          inv.sessions.push({
            agent: 'opencode',
            externalId: id,
            sourcePath: file,
            sourceKey: `opencode:${pathKey(file)}#${id}`,
            size: Number(r.parts ?? 0),
            mtime: toDate(Number(r.time_updated)) ?? new Date(0),
            relPath: name,
            projectHint: str(r.directory),
            isSubagent: !!r.parent_id,
            parentExternalId: str(r.parent_id),
          });
        }
      } catch (e) {
        inv.errors.push(`${name}: ${(e as Error).message}`);
      } finally {
        w?.dispose();
      }
    }
    inv.assets.push({ kind: 'database', label: 'OpenCode SQLite databases', count: dbs.length, bytes, archived: true });
    inv.assets.push({ kind: 'credentials', label: 'Credential files', count: 0, bytes: 0, archived: false, note: 'Never read or copied (auth.json).' });
    if (fs.existsSync(path.join(root, 'storage'))) inv.notes.push('A legacy storage/ directory exists. Its JSON-file sessions are not parsed by this adapter.');
    return inv;
  },

  async parse(d: DiscoveredSession, sink: SessionSink, ctx: ParseContext) {
    const db = working(ctx.archivePath);
    const acc = new SessionAccumulator(sink, { agent: 'opencode', externalId: d.externalId, isSubagent: !!d.isSubagent, parentExternalId: d.parentExternalId });
    const s = acc.session;
    const rawOf = (table: string, row: Row) => {
      const r = ctx.writeRaw?.({ table, ...row });
      return r ? { rawOffset: r.offset, rawLength: r.length } : {};
    };

    const session = db.prepare('SELECT * FROM session WHERE id = ?').get(d.externalId) as Row | undefined;
    if (session) {
      s.title = str(session.title);
      s.cwd = str(session.directory);
      s.agentVersion = str(session.version);
      Object.assign(s.providerMeta, { slug: session.slug ?? null, projectId: session.project_id ?? null, agentName: session.agent ?? null, cost: session.cost ?? null, summary: { additions: session.summary_additions ?? null, deletions: session.summary_deletions ?? null, files: session.summary_files ?? null } });
      await acc.event({ kind: 'meta', rawType: 'session', timestamp: toDate(Number(session.time_created)), ...rawOf('session', session) });
    }

    const messages = db.prepare('SELECT * FROM message WHERE session_id = ? ORDER BY time_created, id').all(d.externalId) as Row[];
    const partStmt = db.prepare('SELECT * FROM part WHERE message_id = ? ORDER BY id');
    const partTypes: Record<string, number> = {};

    for (const m of messages) {
      const md = json(m.data);
      const role = str(md.role) ?? 'assistant';
      const model = str(md.modelID) ?? str(asRecord(md.model)?.modelID);
      const mTime = toDate(Number(m.time_created));
      if (role === 'assistant') acc.noteModel(model);
      acc.noteCwd(str(asRecord(md.path)?.cwd));
      const finish = str(md.finish);
      const err = asRecord(md.error);
      const parts = partStmt.all(String(m.id)) as Row[];
      const userTexts: string[] = [];
      let userRaw: Rec = {};
      let userSynthetic = true;

      for (const p of parts) {
        const pd = json(p.data);
        const type = str(pd.type) ?? '<no-type>';
        partTypes[type] = (partTypes[type] ?? 0) + 1;
        const timestamp = toDate(Number(p.time_created)) ?? mTime;
        const common = { rawType: 'part', subtype: type, timestamp, uuid: String(p.id), parentUuid: String(m.id), ...rawOf('part', p) };

        if (type === 'text') {
          const text = str(pd.text) ?? '';
          if (role === 'user') {
            if (pd.synthetic !== true && pd.ignored !== true) userSynthetic = false;
            userTexts.push(text);
            userRaw = common;
          } else {
            const seq = await acc.event({ ...common, kind: 'assistant_message', role: 'assistant', text, model });
            if (text.trim()) acc.assistantText(seq, text, finish === 'stop' || finish === 'end_turn' ? 'final' : finish ? 'interim' : 'unknown');
          }
        } else if (type === 'reasoning') {
          await acc.event({ ...common, kind: 'thinking', role: 'assistant', text: str(pd.text), model });
          acc.assistantPartial();
        } else if (type === 'tool') {
          const state = asRecord(pd.state) ?? {};
          const input = asRecord(state.input) ?? {};
          const name = str(pd.tool) ?? 'tool';
          const id = str(pd.callID) ?? String(p.id);
          const command = name === 'bash' ? str(input.command) : undefined;
          const op = FILE_TOOLS[name];
          const filePath = str(input.filePath) ?? str(input.path);
          const seq = await acc.event({ ...common, kind: 'tool_call', role: 'assistant', toolName: name, toolUseId: id, text: command ? `$ ${command}` : compactJson(input, 6000), command, filePath, model });
          acc.toolCall(seq, id, name, { filePath: op ? filePath : undefined, op, command, timestamp });
          const status = str(state.status);
          if (status === 'completed' || status === 'error') {
            const isError = status === 'error';
            const text = isError ? str(state.error) ?? compactJson(state.error, 4000) : typeof state.output === 'string' ? state.output : compactJson(state.output, 12_000);
            await acc.event({ ...common, kind: 'tool_result', role: 'tool', toolUseId: id, toolName: name, text, isError, timestamp: toDate(Number(asRecord(state.time)?.end)) ?? timestamp });
            acc.toolResult(id, isError);
          }
        } else if (type === 'file') {
          await acc.event({ ...common, kind: 'attachment', role, text: str(pd.filename) ?? str(pd.url), filePath: str(pd.filename) });
        } else if (type === 'step-start' || type === 'step-finish' || type === 'snapshot' || type === 'patch' || type === 'agent' || type === 'subtask' || type === 'compaction' || type === 'retry') {
          await acc.event({ ...common, kind: 'meta' });
        } else {
          await acc.event({ ...common, kind: 'unknown', text: `Unrecognized OpenCode part type "${type}"` });
        }
      }

      if (role === 'user' && userTexts.length) {
        const text = userTexts.join('\n');
        const human = !userSynthetic && !d.isSubagent;
        const seq = await acc.event({ ...userRaw, kind: 'user_message', role: 'user', text, isMeta: !human, subtype: human ? undefined : d.isSubagent ? 'delegated_prompt' : 'injected', timestamp: mTime });
        if (human) acc.humanPrompt(seq, text, mTime, String(m.id));
        else acc.injectedUser();
      }
      if (err) {
        const text = str(asRecord(err.data)?.message) ?? str(err.name) ?? compactJson(err, 600);
        await acc.event({ kind: 'error', rawType: 'message', role: 'assistant', text, isError: true, timestamp: mTime, ...rawOf('message', m) });
        acc.apiError(text);
      }
    }

    if (hasTable(db, 'todo')) {
      const todos = db.prepare('SELECT content, status, priority FROM todo WHERE session_id = ? ORDER BY position').all(d.externalId) as Row[];
      acc.setTodos(todos.map((t) => ({ key: String(t.content), content: String(t.content), status: String(t.status ?? 'pending'), priority: str(t.priority) })));
    }

    const done = await acc.finish();
    Object.assign(done.providerMeta, { partTypeCounts: partTypes, database: path.basename(d.sourcePath) });
    return done;
  },
};
