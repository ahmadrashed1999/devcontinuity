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
- **Automatic handoff when an agent hits its limit:** sessions that stop on a usage, rate or billing
  limit raise a notification and an Overview card ("Claude Code hit its limit in … — Continue in
  Codex") that opens the next agent with the briefing, or copies it. Preferred fallback agent in
  Settings → Agents.
- Opening an agent with a briefing now works on macOS (iTerm or Terminal) and Linux
  (x-terminal-emulator, gnome-terminal, konsole, xfce4-terminal, kitty, alacritty, xterm).
- **Review before sharing:** briefings and handoff packages show the exact text first, highlight
  redacted secrets, secret-looking strings, e-mail addresses and home-folder paths, and let you leave
  out sections or whole files.
- **Shared memory across agents:** the `project_context` MCP tool (and a richer `recent_activity`)
  summarizes what every agent did in a project, open tasks and last errors; the Agent rules sync can
  tell agents to call it at the start and `log_summary` at the end.
- **AI Coding Wrapped** (`/wrapped`, `dc wrapped --month|--year`): a month or year in numbers per
  agent, with a 1200×630 share image drawn in the browser, in English or Arabic.
- **Compare agents:** completion, interruption and error rates, tools per prompt, files per session
  and cost per finished session, with "not enough data" for small samples.
- **Skills Shop** (`/skills`): a curated catalog of the best MCP servers, skills, plugins, rules and
  extensions per agent, by category, with benefits, install steps for ten agents and usage examples.
- **More agents:** Aider, ChatGPT and Claude.ai data exports, Zed (experimental), and live-capture
  recipes for Qwen Code, Copilot CLI and Kiro (experimental).
- Claude Code sessions now record token usage.
- **Hosted demo readiness:** `DEVCONTINUITY_DEMO=1` read-only mode with a Demo ribbon, a Dockerfile
  and docs/DEMO.md.
- README hero GIF (`npm run demo:gif`), refreshed screenshots, and `npm run demo:rtl` (Arabic layout
  check at phone and desktop width).
- Community files: issue and pull request templates, code of conduct, roadmap with good first
  issues, and a launch kit.

### Changed

- The experimental AI organization moved into `src/modules/org` with its pages under `app/(org)`;
  while it is off its pages and API answer 404. Its data and migrations are unchanged. The Prompts
  and Schedules pages no longer create the org chart.
- Every remaining page (Tasks, Import Center, Settings, Handoff, Projects, Knowledge, Worktrees,
  Verify, Costs, Prompts, Backups) is translated into Arabic.
- Manual imports from the CLI raise the same limit and error notifications as the background sync.

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
