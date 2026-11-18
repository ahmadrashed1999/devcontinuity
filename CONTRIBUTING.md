# Contributing

Thanks for helping. Bug reports, agent adapters, translations and UI improvements are all welcome.

## Development setup

```bash
npm install
npm run setup        # creates ./data and the database
npm run dev          # http://localhost:3210 with hot reload
npm run orchestrator # in a second terminal, for auto-sync while developing
```

Before opening a pull request:

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

Tests use fixtures and a separate data folder (`data/tmp/test-data`); they never touch your real agent data.

### Rules that keep users safe

- Never write to an agent's own files outside the explicit `connect` flow, and never parse an original in place: read the safe copy the importer gives you (`ctx.archivePath`, `ctx.companions`).
- Never mark a task completed from an agent's claim. Claims become `requires_verification`.
- Never add a destructive migration or suggest `prisma migrate reset`.
- Redact before storing: use `SessionAccumulator`, which does it for you.

## Adding an agent

An agent is one module in `src/server/adapters/` implementing `AgentAdapter` (`types.ts`):

1. **`defaultRoots()`**: the folders where the agent keeps history (respect env overrides such as `CODEX_HOME`).
2. **`scan(root)`**: read-only discovery. Return one `DiscoveredSession` per session with a stable `sourceKey`, `size` and `mtime` (used for incremental imports). Put extra files the parser needs in `companions`; if the session's agent differs from the adapter id (a fork, a live source), set `reportedAgent`.
3. **`parse(session, sink, ctx)`**: read `ctx.archivePath` (the safe copy) and feed a `SessionAccumulator`:
   - `event({...})` for every record (unknown records too, with `kind: 'unknown'`),
   - `humanPrompt()` only for what a person typed (not injected context),
   - `assistantText(seq, text, 'final' | 'interim' | 'unknown')`,
   - `toolCall()` / `toolResult()` with matching ids (file paths and commands make the Files and Verify views work),
   - `apiError()`, `userInterrupt()`, `setTodos()`, `gitOp()` where the agent records them.
   Finish with `acc.finish()`; the end state is computed for you.
4. Register it in `src/server/adapters/index.ts`, add a colour and a display name in `src/lib/format.ts`, and a watch filter in `src/server/sync/watcher.ts` if it should auto-sync.
5. Add a fixture-based test in `tests/agents.test.ts`.

If the agent has no readable history but supports hooks, add its payload dialect to `src/server/live/normalize.ts` and a `connect` recipe to `src/server/live/connect.ts` instead.

## Translations

UI strings live in `src/lib/i18n.ts` (English and Arabic). Add a key to both dictionaries; server components use `getT()`, client components use `useT()` from `components/dc/lang.tsx`.

## Commit style

Small, focused commits with a clear message. Describe user-visible changes in the pull request.
