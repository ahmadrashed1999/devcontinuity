import fs from 'node:fs';
import path from 'node:path';
import { homeDir } from '../config';
import { pathKey } from '../security/paths';
import { hasTable, openWorkingCopy } from './sqlite-util';
import { AgentAdapter, AgentInventory, DiscoveredSession, ParseContext, SessionAccumulator, SessionSink, asRecord, compactJson, str, toDate } from './types';

type Rec = Record<string, unknown>;

function parse(v: unknown): Rec | undefined {
  const s = typeof v === 'string' ? v : Buffer.isBuffer(v) || v instanceof Uint8Array ? Buffer.from(v as Uint8Array).toString('utf8') : undefined;
  if (!s) return undefined;
  try {
    return asRecord(JSON.parse(s));
  } catch {
    return undefined;
  }
}

/**
 * Cursor keeps agent ("composer") conversations in a VS Code style key-value SQLite store.
 * The layout is undocumented and has changed between releases, so this adapter is best-effort:
 * it reads `composerData:*` and `bubbleId:*` entries from globalStorage/state.vscdb and keeps
 * every record it does not understand as an `unknown` event.
 */
export const cursorAdapter: AgentAdapter = {
  id: 'cursor',
  label: 'Cursor Agent',
  capabilities: {
    toolCalls: true,
    toolResults: true,
    thinking: true,
    subagents: false,
    fileSnapshots: false,
    todos: false,
    gitMetadata: false,
    maturity: 'experimental',
    notes: 'Best-effort reader for Cursor composer conversations. Cursor is not installed on this machine, so this adapter is verified only against synthetic fixtures. Conversations are not linked to a project folder automatically.',
  },

  defaultRoots() {
    const appData = process.env.APPDATA ?? path.join(homeDir(), 'AppData', 'Roaming');
    return [path.join(appData, 'Cursor', 'User')];
  },

  async scan(root: string): Promise<AgentInventory> {
    const inv: AgentInventory = { agent: 'cursor', label: 'Cursor Agent', root, exists: fs.existsSync(root), sessions: [], projectDirs: [], assets: [], notes: [], unrecoverable: [], errors: [] };
    if (!inv.exists) return inv;
    const file = path.join(root, 'globalStorage', 'state.vscdb');
    if (!fs.existsSync(file)) {
      inv.notes.push('globalStorage/state.vscdb was not found.');
      return inv;
    }
    let w: ReturnType<typeof openWorkingCopy> | undefined;
    try {
      w = openWorkingCopy(file);
      if (!hasTable(w.db, 'cursorDiskKV')) {
        inv.notes.push('state.vscdb has no cursorDiskKV table; this Cursor version stores conversations differently.');
        return inv;
      }
      const st = fs.statSync(file);
      const rows = w.db.prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'").all() as Rec[];
      for (const r of rows) {
        const data = parse(r.value);
        const id = String(r.key).slice('composerData:'.length);
        if (!data) continue;
        const headers = Array.isArray(data.fullConversationHeadersOnly) ? data.fullConversationHeadersOnly.length : Array.isArray(data.conversation) ? data.conversation.length : 0;
        if (headers === 0) continue;
        inv.sessions.push({ agent: 'cursor', externalId: id, sourcePath: file, sourceKey: `cursor:${pathKey(file)}#${id}`, size: headers, mtime: toDate(data.lastUpdatedAt) ?? toDate(data.createdAt) ?? st.mtime, relPath: path.join('globalStorage', 'state.vscdb') });
      }
      inv.assets.push({ kind: 'database', label: 'Cursor state database', count: 1, bytes: st.size, archived: true });
    } catch (e) {
      inv.errors.push(`state.vscdb: ${(e as Error).message}`);
    } finally {
      w?.dispose();
    }
    inv.unrecoverable.push('Cursor does not record which workspace folder a conversation belonged to in a stable way; imported conversations must be assigned to a project manually.');
    return inv;
  },

  async parse(d: DiscoveredSession, sink: SessionSink, ctx: ParseContext) {
    const w = openWorkingCopy(ctx.archivePath);
    try {
      const acc = new SessionAccumulator(sink, { agent: 'cursor', externalId: d.externalId, isSubagent: false });
      const get = w.db.prepare('SELECT value FROM cursorDiskKV WHERE key = ?');
      const composer = parse((get.get(`composerData:${d.externalId}`) as Rec | undefined)?.value) ?? {};
      acc.session.title = str(composer.name);
      const rawOf = (key: string, value: unknown) => {
        const r = ctx.writeRaw?.({ key, value });
        return r ? { rawOffset: r.offset, rawLength: r.length } : {};
      };
      await acc.event({ kind: 'meta', rawType: 'composerData', timestamp: toDate(composer.createdAt), ...rawOf(`composerData:${d.externalId}`, { ...composer, conversation: undefined }) });

      const bubbles: { key: string; data: Rec }[] = [];
      if (Array.isArray(composer.conversation) && composer.conversation.length) {
        composer.conversation.forEach((b, i) => {
          const o = asRecord(b);
          if (o) bubbles.push({ key: `inline:${i}`, data: o });
        });
      } else if (Array.isArray(composer.fullConversationHeadersOnly)) {
        for (const h of composer.fullConversationHeadersOnly) {
          const bid = str(asRecord(h)?.bubbleId);
          if (!bid) continue;
          const key = `bubbleId:${d.externalId}:${bid}`;
          const data = parse((get.get(key) as Rec | undefined)?.value);
          if (data) bubbles.push({ key, data });
          else await acc.event({ kind: 'unknown', rawType: 'bubble', text: `Conversation entry ${bid} is referenced but its content is missing from the database.` });
        }
      }

      for (const { key, data } of bubbles) {
        const timestamp = toDate(data.createdAt) ?? toDate(asRecord(data.timingInfo)?.clientStartTime);
        const common = { rawType: 'bubble', uuid: str(data.bubbleId), timestamp, ...rawOf(key, data) };
        const text = str(data.text) ?? '';
        const tool = asRecord(data.toolFormerData);
        const thinking = str(asRecord(data.thinking)?.text);
        if (thinking) await acc.event({ ...common, kind: 'thinking', role: 'assistant', text: thinking });
        if (data.type === 1) {
          const seq = await acc.event({ ...common, kind: 'user_message', role: 'user', text });
          if (text.trim()) acc.humanPrompt(seq, text, timestamp, str(data.bubbleId));
        } else if (tool) {
          const name = str(tool.name) ?? `tool-${String(tool.tool ?? 'unknown')}`;
          const id = str(tool.toolCallId) ?? str(data.bubbleId);
          const args = parse(tool.rawArgs) ?? parse(tool.params) ?? {};
          const command = str(args.command);
          const filePath = str(args.target_file) ?? str(args.relative_workspace_path) ?? str(args.file_path);
          const op = /edit|write|apply|replace/i.test(name) ? 'edit' : /read/i.test(name) ? 'read' : undefined;
          const seq = await acc.event({ ...common, kind: 'tool_call', role: 'assistant', toolName: name, toolUseId: id, text: command ? `$ ${command}` : compactJson(args, 6000), command, filePath });
          acc.toolCall(seq, id, name, { filePath: op ? filePath : undefined, op, command, timestamp });
          const status = str(tool.status);
          if (tool.result != null || status === 'completed' || status === 'error') {
            const isError = status === 'error' || status === 'cancelled';
            await acc.event({ ...common, kind: 'tool_result', role: 'tool', toolUseId: id, toolName: name, text: typeof tool.result === 'string' ? tool.result : compactJson(tool.result, 12_000), isError });
            acc.toolResult(id, isError);
          }
          if (text.trim()) {
            const s2 = await acc.event({ ...common, kind: 'assistant_message', role: 'assistant', text });
            acc.assistantText(s2, text, 'unknown');
          }
        } else if (data.type === 2) {
          const seq = await acc.event({ ...common, kind: 'assistant_message', role: 'assistant', text });
          if (text.trim()) acc.assistantText(seq, text, 'unknown');
        } else {
          await acc.event({ ...common, kind: 'unknown', text: `Unrecognized Cursor entry type ${String(data.type)}` });
        }
      }
      const done = await acc.finish();
      Object.assign(done.providerMeta, { composer: { status: composer.status ?? null, unifiedMode: composer.unifiedMode ?? null }, experimentalAdapter: true });
      return done;
    } finally {
      w.dispose();
    }
  },
};
