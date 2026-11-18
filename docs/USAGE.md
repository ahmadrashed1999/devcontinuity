# Using DevContinuity

This guide takes you from a fresh install to a working, cross-agent log in about ten minutes.

## 1. Install and start

```bash
git clone https://github.com/ahmadrashed1999/devcontinuity.git
cd devcontinuity
npm install
npm run setup
npm run build
npm run app
```

Open **http://localhost:3210**. Leave `npm run app` running: it serves the UI and keeps every agent in sync in the background.

| Platform | Run it | Start automatically |
| --- | --- | --- |
| Windows | `npm run tray` (tray icon) or `npm run app` | `npm run startup:install` (undo: `npm run startup:remove`) |
| macOS / Linux | `npm run app` | Add `npm run app` to your login items, a `launchd` agent or a `systemd --user` service |

To keep data somewhere else (an external disk, a synced folder), set `DEVCONTINUITY_DATA_DIR` in `.env.local` before `npm run setup`.

## 2. First import

Open **Import Center**. DevContinuity scans the usual locations of every supported agent, read-only, and shows what it found: number of sessions, size, and anything it cannot recover. Click **Import**.

- Nothing is moved or changed. Each source file is copied once into `data/archives/` and parsed from that copy.
- Imports are incremental. Re-running only processes sessions that changed.
- Agent data from another computer (a copied `.claude` or `.codex` folder) or a chat export (`.json`, `.jsonl`, `.zip`) can be imported from the same page.

After the first import, the background service picks up new sessions automatically, usually within a minute of an agent going quiet.

## 3. Connect the agents that need it

Open **Connected agents**. Agents with readable history (Claude Code, Codex, OpenCode, Antigravity, Cline, Copilot, Continue) are already covered. For the others:

1. Click **Connect** on the agent's card (Gemini CLI, Cursor, Windsurf…).
2. Review the preview: it lists every config file it will change.
3. Click **Apply**. The originals are backed up to `data/backups/agent-config/`.
4. Restart the agent.

From the command line the same thing is `npm run dc -- connect <agent>` (preview) and `npm run dc -- connect <agent> --yes` (apply).

Optional extras:

- **+ Telemetry** (Claude Code, Codex, Gemini CLI) adds exact token and cost data per session through OpenTelemetry.
- **MCP** is registered with every connection. It lets the agent call `recent_activity` before starting work and `log_summary` when it finishes. Add a line to your agent rules such as: *"Before starting, call DevContinuity `recent_activity` for this folder. When you finish a task, call `log_summary`."* (Project → **Agent rules** writes this into CLAUDE.md, AGENTS.md, the Cursor rules file and GEMINI.md for you.)

## 4. Daily use

**Overview** answers "what happened?": sessions per agent over the last two weeks, the latest sessions from every agent, and anything that needs you (a session that hit a usage limit, stopped mid-tool, or never got an answer).

**Sessions** lists everything. Click an agent chip to see only that agent; filter by project, outcome or date. Open a session to see its full timeline (prompts, answers, tool calls, output, errors), the files it touched, and the tasks it produced.

**Search** (the box at the top of every page) finds any text in any session: an error message, a command, a file name, a decision.

**Projects** groups sessions by repository, from every agent, with the current Git state, changed files and worktrees.

## 5. Continue work with another agent

When an agent hits a limit or you want a second opinion:

1. Open the session (or the project) and choose **Continue**.
2. Pick the target agent. DevContinuity builds a briefing: the last request, the last answer, unfinished tasks, files changed, recent errors and the current Git state.
3. Copy it, or click **Open in Claude Code / Codex / OpenCode / Cursor** to start that agent in the right folder with the briefing loaded.

`npm run dc -- handoff --project my-app --drop-in` writes the full package into the repository (`.devcontinuity/RESUME.md`), so any agent can be told "read `.devcontinuity/RESUME.md` and continue".

## 6. Verify what agents claimed

Agents often say "done" when they are not. Every such claim becomes a task marked **Needs checking**. **Verify & Triage** compares each claim with evidence (were the edits really made? does the commit exist?) and lets you run your test or build command. A task only becomes **Completed** when you confirm it.

## 7. Back up

**Backups** creates a snapshot of the database and knowledge (optionally the full archive). It can encrypt with a passphrase and copy to a synced folder (Google Drive, OneDrive, Dropbox) or Cloudflare R2.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| An agent shows 0 sessions | Check **Import Center** for its folder. Add non-default locations in **Settings → Agents**, or set `CLAUDE_CONFIG_DIR` / `CODEX_HOME` / `CONTINUE_GLOBAL_DIR`. |
| A connected agent logs nothing | Restart the agent after connecting. For Gemini CLI, run `/hooks` to confirm the hooks are listed. Live events land in `data/live/<agent>/`; check `data/logs/hook-errors.log`. |
| New sessions appear late | They are imported after about 45 seconds of quiet. **Import Center → Import** forces it. |
| Port 3210 is taken | `PORT=4000 npm run app` (and use that port in `connect`'s generated config). |
| `npm run setup` says the client could not be regenerated | DevContinuity is running and Windows locks the database engine. Stop it and run setup again, or ignore the warning: the existing client keeps working. |
| You want to start over | Stop DevContinuity and move or delete the `data/` folder. Your agents' own files are untouched either way. |
