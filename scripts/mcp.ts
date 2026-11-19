#!/usr/bin/env node
/**
 * DevContinuity MCP server (stdio). Lets any MCP-capable agent (Claude Code, OpenCode, Codex,
 * Cursor, Antigravity, Windsurf, Gemini CLI) pull project context directly: list projects, find
 * sessions, search history and get a ready-made continuation briefing. It also lets agents log
 * what they did (log_summary / log_event) into DevContinuity's live capture. It never modifies
 * projects or the agents' own transcripts.
 *
 * Register it with "npm run dc -- connect <agent>" (or the Connected agents page).
 */
import './_env';
import readline from 'node:readline';
import { ensureDb, prisma } from '../src/server/db';
import { buildResumeContext, renderContinuationPrompt } from '../src/server/handoff/context';
import { searchEvents } from '../src/server/search';
import { agentLabel } from '../src/server/adapters';
import { projectContext, projectContextForDirectory } from '../src/server/memory';
import { appendLive, normalizeAgentId } from '../src/server/live/store';

/** Set from the MCP initialize handshake (clientInfo.name), so log calls know which agent is talking. */
let clientAgent = 'unknown';
const startedAt = new Date().toISOString().replace(/[:.]/g, '-');
const defaultSession = () => `mcp-${startedAt}`;

const log = (...a: unknown[]) => process.stderr.write(`[devcontinuity-mcp] ${a.join(' ')}\n`);
const send = (msg: unknown) => process.stdout.write(`${JSON.stringify(msg)}\n`);

const TOOLS = [
  { name: 'list_projects', description: 'List projects known to DevContinuity with their folder, last activity and task counts.', inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Optional filter on name or path' } } } },
  { name: 'find_project_for_directory', description: 'Find the DevContinuity project for a working directory (use your current directory).', inputSchema: { type: 'object', properties: { directory: { type: 'string' } }, required: ['directory'] } },
  { name: 'list_sessions', description: 'List recent sessions of a project (any agent).', inputSchema: { type: 'object', properties: { project: { type: 'string', description: 'Project id, slug or name' }, limit: { type: 'number' } }, required: ['project'] } },
  { name: 'get_resume_briefing', description: 'Get a complete continuation briefing for a project or a specific session: last request, last response, unfinished tasks, changed files, errors, Git state and next steps.', inputSchema: { type: 'object', properties: { project: { type: 'string' }, session_id: { type: 'string' }, agent: { type: 'string', description: 'Target agent for the wording: claude-code, codex, opencode, cursor, generic' } } } },
  { name: 'recent_activity', description: 'Short version of project_context: what every AI agent (Claude Code, Codex, Antigravity, Cursor, Copilot, Cline, Gemini CLI...) did recently in a folder, open tasks and last errors. Call this before starting work to avoid redoing or undoing work another agent did.', inputSchema: { type: 'object', properties: { directory: { type: 'string', description: 'Your current working directory' }, limit: { type: 'number', description: 'Sessions per agent (default 2)' } }, required: ['directory'] } },
  { name: 'project_context', description: 'Shared memory across agents. Call at the START of a task: a compact summary of what each AI agent did recently in this project (per agent: requests, how each session ended, last answers), summaries agents logged, open tasks, last errors and recently changed files. Call log_summary when you finish so the next agent knows.', inputSchema: { type: 'object', properties: { directory: { type: 'string', description: 'Your current working directory' }, project: { type: 'string', description: 'Project id, slug or name (instead of directory)' }, days: { type: 'number', description: 'Look back this many days (default 14)' } } } },
  { name: 'log_summary', description: 'Record what you just did in the DevContinuity cross-agent log. Call it when you finish a task (or stop with work left over) so the user and other agents can see and continue it.', inputSchema: { type: 'object', properties: { summary: { type: 'string', description: 'What was done and why, in a few sentences' }, title: { type: 'string', description: 'Short task title' }, status: { type: 'string', enum: ['done', 'partial', 'blocked', 'failed'] }, files_changed: { type: 'array', items: { type: 'string' } }, next_steps: { type: 'array', items: { type: 'string' } }, directory: { type: 'string', description: 'Your working directory' }, session_id: { type: 'string', description: 'Your session id, if you know it' } }, required: ['summary'] } },
  { name: 'log_event', description: 'Record one step (prompt, response, tool call, error) in the DevContinuity cross-agent log. Only needed for agents without hook support.', inputSchema: { type: 'object', properties: { kind: { type: 'string', enum: ['prompt', 'assistant', 'tool_call', 'tool_result', 'error', 'meta'] }, text: { type: 'string' }, tool: { type: 'string' }, command: { type: 'string' }, file: { type: 'string' }, directory: { type: 'string' }, session_id: { type: 'string' } }, required: ['kind'] } },
  { name: 'search_history', description: 'Full-text search across all imported session transcripts.', inputSchema: { type: 'object', properties: { query: { type: 'string' }, project: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] } },
  { name: 'list_tasks', description: 'List tasks for a project with status and verification level.', inputSchema: { type: 'object', properties: { project: { type: 'string' }, status: { type: 'string' } }, required: ['project'] } },
];

async function project(ref: string) {
  const db = prisma();
  const p = (await db.project.findFirst({ where: { OR: [{ id: ref }, { slug: ref }] } })) ?? (await db.project.findFirst({ where: { OR: [{ name: ref }, { name: { contains: ref } }, { rootPath: { contains: ref } }] }, orderBy: { lastActivityAt: 'desc' } }));
  if (!p) throw new Error(`No project matches "${ref}".`);
  return p;
}

async function call(name: string, a: Record<string, unknown>): Promise<string> {
  const db = prisma();
  switch (name) {
    case 'list_projects': {
      const q = typeof a.query === 'string' ? a.query : undefined;
      const rows = await db.project.findMany({ where: q ? { OR: [{ name: { contains: q } }, { rootPath: { contains: q } }] } : {}, orderBy: { lastActivityAt: 'desc' }, take: 60, include: { _count: { select: { sessions: true, tasks: true } } } });
      return rows.map((p) => `${p.slug} | ${p.rootPath} | last ${p.lastActivityAt?.toISOString().slice(0, 10) ?? '-'} | ${p._count.sessions} sessions, ${p._count.tasks} tasks`).join('\n') || 'No projects. Import sessions in DevContinuity first.';
    }
    case 'find_project_for_directory': {
      const dir = String(a.directory ?? '').replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
      const all = await db.project.findMany({ where: { pathVerified: true } });
      const best = all.filter((p) => dir === p.pathKey || dir.startsWith(`${p.pathKey}/`)).sort((x, y) => y.pathKey.length - x.pathKey.length)[0];
      return best ? `${best.slug} | ${best.rootPath}` : 'No project matches this directory.';
    }
    case 'list_sessions': {
      const p = await project(String(a.project));
      const rows = await db.session.findMany({ where: { projectId: p.id, isSubagent: false }, orderBy: { endedAt: 'desc' }, take: Math.min(Number(a.limit) || 15, 50) });
      return rows.map((s) => `${s.id} | ${s.agent} | ${s.endedAt?.toISOString().slice(0, 16) ?? '-'} | ${s.endState} | ${s.title ?? ''}`).join('\n');
    }
    case 'get_resume_briefing': {
      const projectId = typeof a.project === 'string' ? (await project(a.project)).id : undefined;
      const sessionId = typeof a.session_id === 'string' ? a.session_id : undefined;
      if (!projectId && !sessionId) throw new Error('Pass project or session_id.');
      return renderContinuationPrompt(await buildResumeContext({ projectId, sessionId }), typeof a.agent === 'string' ? a.agent : 'generic');
    }
    case 'search_history': {
      const projectId = typeof a.project === 'string' ? (await project(a.project)).id : undefined;
      const r = await searchEvents(String(a.query ?? ''), { projectId, limit: Math.min(Number(a.limit) || 15, 50) });
      return r.hits.map((h) => `[${h.timestamp?.slice(0, 16) ?? '-'}] ${h.projectName ?? '-'} / ${h.sessionTitle ?? h.sessionId} (${h.kind}, session ${h.sessionId} #${h.seq})\n  ${h.snippet.replace(/\s+/g, ' ')}`).join('\n') || 'No matches.';
    }
    case 'recent_activity':
      // Compact cross-agent view: the last session or two per agent, open tasks, last errors.
      return projectContextForDirectory(String(a.directory ?? ''), { perAgent: Math.min(Number(a.limit) || 2, 10), days: 7 });
    case 'project_context': {
      if (typeof a.project === 'string' && a.project) return projectContext((await project(a.project)).id, { perAgent: 3, days: Math.min(Number(a.days) || 14, 90) });
      return projectContextForDirectory(String(a.directory ?? ''), { perAgent: 3, days: Math.min(Number(a.days) || 14, 90) });
    }
    case 'log_summary':
    case 'log_event': {
      const agent = normalizeAgentId(clientAgent);
      const session = typeof a.session_id === 'string' && a.session_id ? a.session_id : defaultSession();
      const cwd = typeof a.directory === 'string' ? a.directory : undefined;
      const payload = name === 'log_summary'
        ? { kind: 'summary', text: String(a.summary ?? ''), title: a.title, status: a.status, filesChanged: a.files_changed, nextSteps: a.next_steps, cwd }
        : { kind: a.kind, text: a.text, tool: a.tool, command: a.command, file: a.file, cwd };
      appendLive({ source: 'mcp', agent, session, cwd, payload });
      return `Logged to DevContinuity as ${agentLabel(agent)} (session ${session}).`;
    }
    case 'list_tasks': {
      const p = await project(String(a.project));
      const rows = await db.task.findMany({ where: { projectId: p.id, status: typeof a.status === 'string' ? a.status : undefined }, orderBy: { occurredAt: 'desc' }, take: 80 });
      return rows.map((t) => `[${t.status} / ${t.verification}] ${t.title}`).join('\n') || 'No tasks.';
    }
  }
  throw new Error(`Unknown tool: ${name}`);
}

/** MCP client names → DevContinuity agent ids. */
function clientName(n: string): string {
  const s = n.toLowerCase();
  if (s.includes('claude')) return 'claude-code';
  if (s.includes('codex')) return 'codex';
  if (s.includes('antigravity')) return 'antigravity';
  if (s.includes('gemini')) return 'gemini-cli';
  if (s.includes('cursor')) return 'cursor';
  if (s.includes('windsurf') || s.includes('cascade') || s.includes('codeium')) return 'windsurf';
  if (s.includes('opencode')) return 'opencode';
  if (s.includes('copilot') || s.includes('visual studio code') || s === 'vscode') return 'copilot';
  return s.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'unknown';
}

async function handle(msg: { id?: number | string; method?: string; params?: Record<string, unknown> }) {
  const { id, method, params = {} } = msg;
  if (id === undefined) return; // notification
  try {
    if (method === 'initialize') {
      const info = params.clientInfo as { name?: string } | undefined;
      if (info?.name) clientAgent = clientName(info.name);
    }
    if (method === 'initialize') return send({ jsonrpc: '2.0', id, result: { protocolVersion: (params.protocolVersion as string) ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'devcontinuity', version: '2.1.0' } } });
    if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
    if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    if (method === 'tools/call') {
      try {
        const text = await call(String(params.name), (params.arguments as Record<string, unknown>) ?? {});
        return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } });
      } catch (e) {
        return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true } });
      }
    }
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
  } catch (e) {
    send({ jsonrpc: '2.0', id, error: { code: -32603, message: (e as Error).message } });
  }
}

ensureDb()
  .then(() => {
    log('ready');
    readline.createInterface({ input: process.stdin }).on('line', (raw) => {
      // Some Windows shells prefix piped input with a byte-order mark.
      const line = raw.replace(/^﻿/, '');
      if (!line.trim()) return;
      try {
        void handle(JSON.parse(line));
      } catch {
        send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      }
    });
  })
  .catch((e) => {
    log(`startup failed: ${(e as Error).message}`);
    process.exit(1);
  });
