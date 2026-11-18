import fs from 'node:fs';
import path from 'node:path';
import { liveDir, type LiveRecord } from '../live/store';
import { normalizeLive } from '../live/normalize';
import { readJsonl } from '../parsers/jsonl';
import { pathKey } from '../security/paths';
import { AgentAdapter, AgentInventory, DiscoveredSession, ParseContext, SessionAccumulator, SessionSink, clip, compactJson } from './types';

/** Imports what agents report themselves: hook payloads, OpenTelemetry logs and MCP log calls (data/live). */
export const liveAdapter: AgentAdapter = {
  id: 'live',
  label: 'Live capture (hooks, OpenTelemetry, MCP)',
  capabilities: {
    toolCalls: true,
    toolResults: true,
    thinking: true,
    subagents: false,
    fileSnapshots: false,
    todos: false,
    gitMetadata: false,
    maturity: 'tested-with-fixtures',
    notes: 'Works with any agent that can run a hook command, export OpenTelemetry logs or call an MCP tool: Gemini CLI, Cursor, Windsurf, Antigravity, Claude Code, Codex and others. Set up with "npm run dc -- connect <agent>". The originals stay in data/live.',
  },

  defaultRoots() {
    return [liveDir()];
  },

  async scan(root: string): Promise<AgentInventory> {
    const inv: AgentInventory = { agent: 'live', label: 'Live capture', root, exists: fs.existsSync(root), sessions: [], projectDirs: [], assets: [], notes: [], unrecoverable: [], errors: [] };
    if (!inv.exists) return inv;
    for (const agent of fs.readdirSync(root)) {
      const dir = path.join(root, agent);
      if (!fs.statSync(dir).isDirectory()) continue;
      let n = 0;
      let bytes = 0;
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.jsonl')) continue;
        const file = path.join(dir, f);
        const st = fs.statSync(file);
        if (st.size === 0) continue;
        n++;
        bytes += st.size;
        inv.sessions.push({ agent: 'live', reportedAgent: agent, externalId: f.slice(0, -6), sourcePath: file, sourceKey: `live:${pathKey(file)}`, size: st.size, mtime: st.mtime, relPath: path.join(agent, f) });
      }
      if (n) inv.projectDirs.push({ name: agent, sessions: n, subagents: 0, bytes, lastWrite: undefined });
    }
    inv.assets.push({ kind: 'transcripts', label: 'Live streams', count: inv.sessions.length, bytes: inv.sessions.reduce((a, s) => a + s.size, 0), archived: true });
    return inv;
  },

  async parse(d: DiscoveredSession, sink: SessionSink, ctx: ParseContext) {
    const acc = new SessionAccumulator(sink, { agent: 'live', externalId: d.externalId, isSubagent: false });
    const s = acc.session;
    const pending = new Map<string, string[]>(); // tool name → open call ids, for agents whose hooks carry no call id
    const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, requests: 0 };
    const sources = new Set<string>();
    const transcripts = new Set<string>();
    let n = 0;

    for await (const line of readJsonl(ctx.archivePath)) {
      const raw = { rawOffset: line.offset, rawLength: line.length, lineNo: line.lineNo };
      if (line.error) {
        await acc.malformed(line.lineNo, line.error, line.preview, { offset: line.offset, length: line.length });
        continue;
      }
      const rec = line.value as LiveRecord;
      if (!rec || typeof rec !== 'object' || rec.v !== 1) {
        await acc.event({ ...raw, kind: 'unknown', text: 'Not a DevContinuity live record.' });
        continue;
      }
      sources.add(rec.source);
      const nl = normalizeLive(rec);
      const timestamp = nl.timestamp;
      acc.noteCwd(nl.cwd);
      acc.noteModel(nl.model);
      if (nl.title && !s.title) s.title = clip(nl.title, 200);
      if (nl.transcriptPath) transcripts.add(nl.transcriptPath);
      const common = { ...raw, rawType: `${rec.source}:${nl.event}`, timestamp, meta: { source: rec.source, event: nl.event } };

      for (const op of nl.ops) {
        switch (op.op) {
          case 'prompt': {
            const seq = await acc.event({ ...common, kind: 'user_message', role: 'user', text: op.text });
            acc.humanPrompt(seq, op.text, timestamp);
            break;
          }
          case 'assistant': {
            acc.noteModel(op.model);
            const seq = await acc.event({ ...common, kind: 'assistant_message', role: 'assistant', text: op.text, model: op.model ?? nl.model });
            acc.assistantText(seq, op.text, op.final ? 'final' : 'unknown');
            break;
          }
          case 'thinking':
            await acc.event({ ...common, kind: 'thinking', role: 'assistant', text: op.text });
            acc.assistantPartial();
            break;
          case 'tool_call': {
            const id = op.id ?? `${op.name}#${n++}`;
            if (!op.id) pending.set(op.name, [...(pending.get(op.name) ?? []), id]);
            const seq = await acc.event({ ...common, kind: 'tool_call', role: 'assistant', toolName: op.name, toolUseId: id, text: op.command ? `$ ${op.command}` : compactJson(op.input ?? {}, 6000), command: op.command, filePath: op.filePath });
            acc.toolCall(seq, id, op.name, { filePath: op.filePath, op: op.fileOp, command: op.command, timestamp });
            break;
          }
          case 'tool_result': {
            let id = op.id;
            if (!id && op.name) {
              const q = pending.get(op.name);
              id = q?.shift();
            }
            if (!id) {
              // Agents that only report "after" events: record the call and its result together.
              id = `${op.name ?? 'tool'}#${n++}`;
              const seq = await acc.event({ ...common, kind: 'tool_call', role: 'assistant', toolName: op.name, toolUseId: id, text: op.command ? `$ ${op.command}` : compactJson(op.input ?? {}, 6000), command: op.command, filePath: op.filePath });
              acc.toolCall(seq, id, op.name, { filePath: op.filePath, op: op.fileOp, command: op.command, timestamp });
            }
            await acc.event({ ...common, kind: 'tool_result', role: 'tool', toolName: op.name, toolUseId: id, text: op.output == null ? undefined : compactJson(op.output, 12_000), isError: op.isError });
            acc.toolResult(id, op.isError);
            break;
          }
          case 'turn_end':
            await acc.event({ ...common, kind: 'meta', subtype: 'turn_end', text: op.reason });
            if (op.isError) acc.apiError(op.reason ?? 'The agent stopped with an error.');
            else if (op.interrupted) acc.userInterrupt();
            else acc.turnEndedByTool(nl.event);
            break;
          case 'error':
            await acc.event({ ...common, kind: 'error', text: op.text, isError: true });
            acc.apiError(op.text);
            break;
          case 'usage':
            acc.noteModel(op.model);
            usage.requests++;
            usage.inputTokens += op.inputTokens ?? 0;
            usage.outputTokens += op.outputTokens ?? 0;
            usage.cacheReadTokens += op.cacheReadTokens ?? 0;
            usage.cacheWriteTokens += op.cacheWriteTokens ?? 0;
            usage.costUsd += op.costUsd ?? 0;
            await acc.event({ ...common, kind: 'meta', subtype: 'usage', model: op.model, meta: { ...common.meta, usage: op } });
            break;
          case 'summary': {
            const body = [op.text, op.status ? `Status: ${op.status}` : '', op.filesChanged?.length ? `Files changed:\n${op.filesChanged.map((f) => `- ${f}`).join('\n')}` : '', op.nextSteps?.length ? `Next steps:\n${op.nextSteps.map((f) => `- ${f}`).join('\n')}` : ''].filter(Boolean).join('\n\n');
            const seq = await acc.event({ ...common, kind: 'summary', role: 'assistant', text: body });
            if (op.title && !s.title) s.title = clip(op.title, 200);
            s.plans.push({ text: `${op.title ?? 'Agent report'}\n\n${body}`, seq, timestamp });
            acc.assistantText(seq, body, 'final');
            break;
          }
          case 'meta':
            await acc.event({ ...common, kind: 'meta', subtype: op.name, text: op.text });
            break;
        }
      }
    }

    const done = await acc.finish();
    Object.assign(done.providerMeta, {
      liveSources: [...sources],
      reportedAgent: d.reportedAgent,
      transcriptPaths: [...transcripts].slice(0, 5),
      usage: usage.requests ? { ...usage, costUsd: usage.costUsd || null } : null,
    });
    if (!done.title) done.title = done.firstUserPrompt ? clip(done.firstUserPrompt.split('\n')[0], 120) : `${d.reportedAgent} session`;
    return done;
  },
};
