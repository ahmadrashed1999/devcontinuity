# Changelog

All notable changes to DevContinuity are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[semantic versioning](https://semver.org/).

## [2.1.0] - Unreleased

The first public release.

### Added

- **One-command install:** `npx devcontinuity` sets up `~/.devcontinuity`, applies the database
  migrations, starts the web UI and the background service and opens the browser. Every CLI command
  works the same way (`npx devcontinuity connect windsurf`, `agents`, `search …`), and
  `npx devcontinuity mcp` runs the MCP server. Agents connected from an npm installation use stable
  copies of the hook recorder and MCP launcher in the data folder, so they keep working after npx
  clears its cache.
- Release tooling: `npm run pack:check` packs the package, scans it for private paths, installs it
  into an empty folder and starts it against a scratch data folder; a `release` workflow does the
  same on every `v*` tag and attaches the tarball to a GitHub release.

### From the 2.1 development history

- Captures, searches and continues the work of Claude Code, Codex, OpenCode, Antigravity,
  Cline/Roo/Kilo, GitHub Copilot Chat, Continue, Gemini CLI, Cursor, Windsurf and any tool that can
  send an HTTP request.
- Adapters for every agent with readable history; originals are only read through byte-for-byte safe
  copies.
- Live capture for the rest: a dependency-free hook recorder, an OpenTelemetry receiver, an HTTP
  ingest API and MCP log tools, with connect/disconnect that previews and backs up agent configs.
- Web UI (English and Arabic, works on phones), CLI and MCP server.
- Continuation briefings and handoff packages for any agent, evidence-based verification of agent
  claims, Git worktree analysis, backups.
- Optional experimental AI organization module, off by default.
- Cross-platform setup and launcher (`npm run setup`, `npm run app`); Windows tray icon.
- `typecheck` generates Next.js route types first, so a fresh clone type-checks.
- README screenshots, banner and a reproducible fictional demo workspace (`npm run demo`,
  `npm run demo:screenshots`).

[2.1.0]: https://github.com/ahmadrashed1999/devcontinuity/releases/tag/v2.1.0
