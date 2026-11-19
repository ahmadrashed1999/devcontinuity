# Launch kit (drafts)

Ready-to-post texts and the places to submit DevContinuity. **Nothing here has been posted or
submitted.** Post them yourself after `npx devcontinuity` is live on npm and v2.1.1 is released.

Before posting:

- [ ] `npm publish` done, and `npx devcontinuity` works on a clean machine
- [ ] GitHub release v2.1.1 created (the tag triggers it)
- [ ] Social preview uploaded (repository Settings → General → Social preview → `docs/images/banner.png`)
- [ ] Repository topics set: `ai-agents claude-code codex cursor mcp developer-tools local-first`
- [ ] Discussions enabled (the issue templates link to them)
- [ ] Optional: hosted demo deployed (docs/DEMO.md) and its link added below

Links used below: repository `https://github.com/ahmadrashed1999/devcontinuity`, demo GIF
`docs/images/demo.gif`.

---

## Show HN

**Title** (80 characters max):

> Show HN: DevContinuity – one local log for Claude Code, Codex, Cursor and 15 more agents

**Text:**

> I use several AI coding agents in a day: Claude Code until it hits its usage limit, then Codex,
> Cursor for UI work, Copilot in VS Code. Each keeps its history in its own folder and format, and
> none of them knows what the others did, so I kept re-explaining context.
>
> DevContinuity collects all of it into one searchable timeline on your machine. It reads each agent's
> own files (Claude Code, Codex, OpenCode, Antigravity, Cline/Roo/Kilo, Copilot Chat, Continue, Cursor,
> Aider, Zed, ChatGPT/Claude.ai exports) and records the rest through hooks, OpenTelemetry or MCP
> (Gemini CLI, Windsurf, Qwen Code, Copilot CLI, Kiro…). The originals are only ever read.
>
> What I use most:
> - When an agent stops on a usage limit, a card offers to continue the same work in another agent,
>   with a briefing (last request, changed files, errors, Git state) you review before it is copied.
> - An MCP tool, project_context, gives any agent a summary of what the other agents did in the folder,
>   so they stop redoing and undoing each other's work.
> - Full-text search across every prompt, command and error, and a check of agents' "done" claims
>   against Git and the files.
>
> It is local-first (SQLite, nothing uploaded unless you turn on optional AI features), MIT, English
> and Arabic. Try it with `npx devcontinuity`. Feedback on which agents' formats I got wrong is very
> welcome.
>
> https://github.com/ahmadrashed1999/devcontinuity

---

## r/ClaudeAI

**Title:** I built a free, local tool that continues your Claude Code session in another agent when you hit the usage limit

> When Claude Code says "You've hit your session limit", DevContinuity notices (it reads Claude Code's
> transcripts read-only), shows a card "Claude Code hit its limit in <project> — Continue in Codex",
> and gives the next agent a briefing: your last request, the files Claude changed, errors, Git state.
> You see the exact text before it is copied, with secrets highlighted.
>
> It also adds an MCP server so Claude Code can ask what other agents did in the same folder
> (project_context) and leave notes for them (log_summary).
>
> Local, MIT, `npx devcontinuity`. Works with Codex, Cursor, Gemini CLI, Copilot and more too.
> GIF in the README: https://github.com/ahmadrashed1999/devcontinuity
>
> Would love feedback, especially from people who switch between several agents.

## r/ChatGPTCoding

**Title:** One searchable log for every AI coding agent you use (Claude Code, Codex, Cursor, Copilot, Aider, ChatGPT exports…)

> If you bounce between agents, their histories are scattered: ~/.claude, ~/.codex, VS Code storage,
> SQLite databases, encrypted stores. DevContinuity imports them into one local timeline (read-only),
> lets you search every prompt and command, and hands a project from one agent to another with a
> reviewed briefing. It also does an "AI Coding Wrapped" for the month and compares agents (completion,
> interruption and error rates, tools per prompt, cost per finished session where cost is recorded).
>
> Free, MIT, runs locally: `npx devcontinuity`. https://github.com/ahmadrashed1999/devcontinuity

## r/cursor

**Title:** Cursor + Claude Code + Codex in one history, with Cursor connected through hooks

> Cursor keeps chats in an internal database, so DevContinuity offers two ways in: it reads Cursor's
> local store, and `npx devcontinuity connect cursor` adds hooks (previewed and backed up first) that
> log prompts, edits and shell commands as they happen. Then you can search across Cursor and your
> other agents, and continue a Cursor session in Claude Code or Codex with a briefing.
>
> Local and open source: https://github.com/ahmadrashed1999/devcontinuity

---

## X / Twitter thread

1. You use Claude Code, Codex, Cursor and Copilot. None of them knows what the others did.
   I built DevContinuity: one local log for every AI coding agent. `npx devcontinuity` 🧵
2. It reads each agent's own history (read-only) and records the rest through hooks, OpenTelemetry
   and MCP. 18+ agents, one searchable timeline. [GIF]
3. Hit your Claude Code limit? It notices and offers "Continue in Codex" with a briefing of the
   last request, changed files and errors. You review the exact text first, secrets highlighted.
4. Your agents can finally share memory: an MCP tool, project_context, tells any agent what the
   others did in this folder. log_summary leaves notes for the next one.
5. Bonus: AI Coding Wrapped for your month, a side-by-side agent comparison, and a Skills Shop with
   the best MCP servers per agent and how to install them.
6. Local-first, MIT, English + Arabic. Feedback welcome:
   https://github.com/ahmadrashed1999/devcontinuity

---

## منشور بالعربية (X / LinkedIn)

> تستخدم Claude Code وCodex وCursor وCopilot؟ كل وكيل يحفظ سجله في مكان مختلف ولا يعرف ما فعله الآخرون.
>
> بنيت DevContinuity: سجل محلي واحد لكل وكلاء البرمجة بالذكاء الاصطناعي.
> • يقرأ سجلات أكثر من 18 وكيلًا دون تعديلها، ويبحث في كل طلب وأمر وخطأ.
> • عندما يصل Claude Code إلى حد الاستخدام، يعرض عليك المتابعة في Codex أو غيره مع ملخص كامل تراجعه قبل نسخه.
> • ذاكرة مشتركة بين الوكلاء عبر أداة MCP اسمها project_context.
> • حصاد شهري لعملك مع الذكاء الاصطناعي، ومقارنة بين الوكلاء، ومتجر لأفضل المهارات لكل وكيل.
>
> مجاني ومفتوح المصدر (MIT)، يعمل على جهازك، وواجهته بالعربية والإنجليزية:
> `npx devcontinuity`
> https://github.com/ahmadrashed1999/devcontinuity

---

## Registries and lists to submit to

Check each list's current contribution rules before submitting; some only accept projects with a
minimum age or stars.

| Where | How | Entry text |
| --- | --- | --- |
| npm | `npm publish` (see README → Releasing) | package.json description is used |
| Official MCP Registry ([modelcontextprotocol/registry](https://github.com/modelcontextprotocol/registry)) | Publish a `server.json` with the `mcp-publisher` CLI; the npm package must exist first | **DevContinuity**: cross-agent memory for AI coding agents. `project_context` summarizes what every agent did in a folder; `log_summary` records your work; plus search and continuation briefings. Run with `npx -y devcontinuity mcp`. |
| [punkpeye/awesome-mcp-servers](https://github.com/punkpeye/awesome-mcp-servers) | Pull request, "Developer Tools" or "Memory" section | `[ahmadrashed1999/devcontinuity](https://github.com/ahmadrashed1999/devcontinuity) 📇 🏠 🍎 🪟 🐧 - One local log for every AI coding agent: shared memory (project_context), cross-agent history search and continuation briefings.` |
| [hesreallyhim/awesome-claude-code](https://github.com/hesreallyhim/awesome-claude-code) | Their resource submission issue form | **DevContinuity** – Local log of Claude Code and 17 other agents' sessions; continue a session in another agent when you hit the usage limit; MCP shared memory. |
| [Glama MCP directory](https://glama.ai/mcp/servers), [mcp.so](https://mcp.so), [Smithery](https://smithery.ai) | Submit the repository URL on each site | Same text as the MCP Registry |
| [e2b-dev/awesome-ai-agents](https://github.com/e2b-dev/awesome-ai-agents) | Pull request (tools section) | **DevContinuity** – Local-first log, search and handoff across AI coding agents (Claude Code, Codex, Cursor, Copilot, Gemini CLI…). MIT. |
| Product Hunt | New product, schedule for a weekday morning US time | Tagline: "One local log for every AI coding agent". First comment: the Show HN text. |
| [AlternativeTo](https://alternativeto.net) | Add as an application | Short description from package.json |
| awesome-selfhosted | Only after the project is 4+ months old (their rule) | – |

## After launch

- Answer every issue and comment in the first 48 hours.
- Turn the most-asked agents into "new agent" issues and tag them `good first issue` where possible.
- Post a short follow-up with what changed after a week of feedback.
