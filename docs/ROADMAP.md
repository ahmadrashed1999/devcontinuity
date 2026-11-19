# Roadmap

Where DevContinuity is going. Ideas and help are welcome: open an issue, or pick a
[good first issue](#good-first-issues).

## Shipped in 2.1

- One local log for every agent: Claude Code, Codex, OpenCode, Antigravity, Cline/Roo/Kilo, Copilot
  Chat, Continue, Cursor, Aider, Zed, ChatGPT and Claude.ai exports, plus live capture for Gemini CLI,
  Cursor, Windsurf, Qwen Code, Copilot CLI, Kiro and anything that can send HTTP.
- `npx devcontinuity` one-command install.
- Automatic handoff when an agent hits its usage limit, with one-click continue in another agent.
- Shared memory across agents (`project_context` / `log_summary` MCP tools).
- AI Coding Wrapped, agent comparison, Skills Shop, review-before-sharing, English and Arabic.

## Next

1. **One-click install from the Skills Shop.** Apply an MCP server to an agent's config with the same
   preview + backup flow as `connect`.
2. **Verify experimental recipes against the real tools.** Qwen Code hooks, Copilot CLI hooks, Kiro
   hooks and Zed agent threads are built from published formats and fixtures; confirm them on real
   installs and promote them to "tested".
3. **macOS menu-bar / Linux tray.** The background service has a tray icon only on Windows.
4. **Semantic search.** Local embeddings next to the full-text index, opt-in, no cloud.
5. **Session diff view.** Show the exact changes a session made, with links to its prompts.
6. **Team mode (optional).** Share selected, redacted handoffs with teammates through a Git repository.
7. **More agents.** Amp, Trae, Augment, JetBrains AI Assistant, Goose: history formats wanted.
8. **Cost for every agent.** Price tokens from agents that only report token counts.

## Good first issues

Small, well-scoped tasks with tests to copy from. Each has a ready `gh` command below.

| # | Task | Where to start |
| --- | --- | --- |
| 1 | Add a verified entry to the Skills Shop catalog (pick one MCP server or skill you use) | `src/lib/skills/<category>.ts`, `tests/skills-shop.test.ts` |
| 2 | Show the Wrapped share card in the page as a preview before download | `src/components/dc/wrapped-share.tsx` |
| 3 | "Copy as Markdown" for a session timeline | `src/components/dc/session-timeline.tsx` |
| 4 | Add a fixture test for an Aider history with `/undo` and `/run` | `tests/agents.test.ts`, `src/server/adapters/aider.ts` |
| 6 | Linux terminal: support `wezterm` and `foot` in the launcher | `src/server/agents/launcher.ts` (`POSIX_TERMINALS`) |
| 7 | Keyboard shortcut `/` to focus the search box | `src/components/dc/shell.tsx` |

## Creating the issues (for the maintainer)

These are prepared, not run. Create the labels once, then the issues:

```bash
gh label create "good first issue" --color 7057ff --description "Small and well-scoped" --force
gh label create roadmap --color 0e8a16 --description "On the roadmap" --force
gh label create "new agent" --color 1d76db --description "Support for another agent" --force
```

```bash
gh issue create --label roadmap --title "One-click install from the Skills Shop" --body "Apply an MCP server from /skills to an agent's config with the same preview + backup flow as 'connect' (src/server/live/connect.ts). Copy-only today."
gh issue create --label roadmap --title "Verify experimental live-capture recipes on real installs" --body "Qwen Code hooks, Copilot CLI hooks, Kiro CLI hooks and Zed agent threads were built from published formats and fixture tests. Confirm on real installs, fix differences, and mark them tested. Please attach fake samples only."
gh issue create --label roadmap --title "Tray / menu-bar app for macOS and Linux" --body "The background service has a tray icon only on Windows (scripts/tray.ps1). Add a lightweight equivalent for macOS and Linux."
gh issue create --label roadmap --title "Opt-in local semantic search" --body "Local embeddings next to the FTS5 index; no network; off by default."
gh issue create --label roadmap --title "Session diff view" --body "Show the exact file changes a session made, linked to the prompts that caused them."
gh issue create --label roadmap --label "new agent" --title "Support more agents: Amp, Trae, Augment, JetBrains AI, Goose" --body "Looking for where each keeps its history and small fake samples. See the 'Support a new agent' template."
gh issue create --label roadmap --title "Price token-only agents" --body "Agents that report tokens but not cost (Codex, Gemini CLI, Copilot) should get an estimated cost from a local price table."
```

```bash
gh issue create --label "good first issue" --title "Skills Shop: add another MCP server" --body "Add one entry to the matching file in src/lib/skills/ (English + Arabic text, install steps copied from the item's own README or docs, an official URL) and run npm test; tests/skills-shop.test.ts checks every entry."
gh issue create --label "good first issue" --title "Wrapped: preview the share card before downloading" --body "Draw the card (drawWrapped in src/components/dc/wrapped-share.tsx) into a visible canvas on /wrapped."
gh issue create --label "good first issue" --title "Copy a session timeline as Markdown" --body "Add a button to the session page that copies the visible timeline as Markdown (redacted text only)."
gh issue create --label "good first issue" --title "Aider: fixture test for /undo and /run" --body "Extend the Aider fixture in tests/agents.test.ts with /undo and /run output and make sure the adapter records them sensibly."
gh issue create --label "good first issue" --title "Launcher: support wezterm and foot on Linux" --body "Add entries to POSIX_TERMINALS in src/server/agents/launcher.ts and a test in tests/growth.test.ts."
gh issue create --label "good first issue" --title "Press / to focus search" --body "Add a keyboard shortcut in src/components/dc/shell.tsx (ignore it while typing in inputs)."
```
