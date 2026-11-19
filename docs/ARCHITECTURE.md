# Architecture

DevContinuity is a Next.js app (UI + REST API), a background service (the orchestrator), a CLI and an MCP server, all sharing one local SQLite database.

```
src/
  app/                    Next.js pages (server components) and the REST API (app/api/[...path])
  components/dc/          UI components
  modules/org/            optional "AI organization" module (server, API routes, UI), off by default
  app/(org)/              its pages, 404 while the module is off
  lib/                    shared client/server code: i18n, formatting, review helpers, Skills Shop catalog
  server/
    adapters/             one module per agent + the unified model (types.ts)
    live/                 live capture: spool store, normalizer, OTLP, connect, dedupe
    import/               safe archive copies, project resolution, the importer
    sync/watcher.ts       auto-sync: watches agent folders + the live spool
    handoff/              continuation briefings, handoff packages, limit handoffs (limit.ts)
    memory.ts             cross-agent shared memory for the project_context MCP tool
    wrapped.ts, compare.ts  AI Coding Wrapped and the agent comparison
    demo.ts               read-only demo mode (DEVCONTINUITY_DEMO=1)
    scheduler.ts, defaults.ts  schedules and default prompts/schedules
    intelligence/         task candidates, repository facts, knowledge documents
    verify/               evidence-based triage and allow-listed test runs
    git/                  read-only Git inspection, worktree analysis
    ai/                   optional AI gateway (Anthropic + OpenAI-compatible providers)
    security/             path safety, secret redaction, encrypted key vault
scripts/
  dc.ts                   CLI
  mcp.ts                  MCP server (stdio)
  hook.mjs                hook recorder (dependency-free, never blocks the agent)
  orchestrator.ts         background service
  paths.mjs               app root + data folder rules shared by every entry point
  setup.mjs / serve.mjs   cross-platform setup and launcher
  pack-check.mjs          packs, scans and test-installs the npm package
  demo/                   demo workspace, screenshots, GIF, RTL check
bin/devcontinuity.mjs     the npx entry point
  tray.ps1 / startup.ps1  Windows tray icon and start-with-Windows
prisma/                   schema and migrations
tests/                    vitest suites with fixtures for every adapter and the live path
```

## Data flow

1. **Discovery (read-only).** Each adapter's `scan()` lists sessions in the agent's folders without changing anything.
2. **Safe copy.** The importer copies each source file (and companion files) byte-for-byte into `data/archives/<agent>/…`. SQLite sources are read through a private working copy, so WAL recovery or locks can never touch the original. A source that shrank is kept under a new name instead of being overwritten.
3. **Parse.** The adapter's `parse()` reads only the copy and emits a unified representation through `SessionAccumulator`: events (prompt, answer, thinking, tool call/result, error…), file operations, prompts with their outcome, todos, Git operations, plans, and the end state.
4. **Store.** Events, file operations and sessions go into SQLite; text is indexed with FTS5. Raw records stay addressable by byte offset for "show original".
5. **Derive.** Task candidates (claims are never auto-completed), plans and knowledge items are created with evidence pointing back at the exact event.

Imports are incremental (size + mtime) and run in the background service after a quiet period, with a five-minute polling fallback.

## Live capture

For agents whose history cannot be read (encrypted, undocumented, or not written at all), DevContinuity records what the agent reports itself:

| Channel | Used by | Endpoint / file |
| --- | --- | --- |
| Hook recorder `scripts/hook.mjs` | Gemini CLI, Cursor, Windsurf | writes `data/live/<agent>/<session>.jsonl` directly (works while the app is down) |
| OpenTelemetry logs (JSON) | Claude Code, Codex, Gemini CLI | `POST /api/otlp/v1/logs` (Bearer token, or a token-in-path variant for exporters that cannot send headers) |
| HTTP API | anything | `POST /api/ingest/event`, `POST /api/ingest/hook/<agent>` |
| MCP tools | any MCP client | `log_summary`, `log_event` |

Every record is stored raw (`{ v, at, source, agent, session, cwd, payload }`). `live/normalize.ts` translates each agent's dialect (Claude/Gemini-style, Cursor and Windsurf hooks, OTel events, generic events) into the same steps, and the `live` adapter imports the files like any other source. When a session is captured both from the agent's own files and live, the file-based session wins and the live copy's usage numbers are attached to it.

`live/connect.ts` writes agent configuration (hooks, MCP server, telemetry) with a preview, backups, and a strict rule: only DevContinuity's own entries are ever added or removed.

## Adding an agent

See [CONTRIBUTING.md](../CONTRIBUTING.md#adding-an-agent).

## Safety guarantees

- Agents' original files are opened read-only and never modified, moved, renamed or deleted. Credential files (`auth.json`, `.credentials.json`, shell snapshots…) are never read.
- Local-only by default: requests with a non-localhost `Host` are refused; API calls need the local token (HttpOnly SameSite=Strict cookie for the UI, Bearer token for scripts); cross-origin requests are refused.
- Secrets are redacted before storage, export, handoff and AI calls.
- Migrations only ever move forward (`npm run setup` runs `prisma migrate deploy`). **Never run `prisma migrate reset` or `migrate dev`**: the full-text tables make Prisma propose a reset, which would delete imported history.
- No telemetry.

## Limitations

| Area | Limitation |
| --- | --- |
| Antigravity | Tool calls and their results are stored by Antigravity only as undocumented protobuf; messages, titles, folders, sub-agent links and plans are imported. Sub-agent conversations have no indexed text, so only their title, folder and timing are shown. Connect it via MCP to log summaries. |
| Cursor | Its own chat database is not parsed (undocumented); use hooks (`connect cursor`). |
| Windsurf | Its history is encrypted; hooks are the only source. |
| Gemini CLI | Keeps no readable transcript by default; hooks and telemetry are the source. Its hook settings format has changed across versions: confirm with `/hooks` after connecting. |
| Copilot Chat | VS Code stores summaries of tool results, not full output. Inline completions are not logged. |
| Codex | Reasoning is stored encrypted by Codex; only reasoning summaries are readable. |
| Hidden state | No tool can recover an agent's hidden model state; continuation briefings say so explicitly. |
| Platform | "Open in <agent>" buttons launch a terminal on Windows only; elsewhere copy the briefing. The tray icon is Windows-only; use `npm run app` elsewhere. |
| Event size | Event text is capped at 12,000 characters in the database; the full original is always available from the archive. |
