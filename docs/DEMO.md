# Hosted demo

DevContinuity can run as a **read-only public demo** over the fictional demo workspace
(`npm run demo`: four made-up projects and two weeks of sessions from nine agents). Nothing real is
in it, and the demo refuses every change.

## What demo mode does

Set `DEVCONTINUITY_DEMO=1` and DevContinuity:

- serves the UI on any host name (normally it only answers `localhost`);
- refuses every API call that is not a read (`POST`, `PUT`, `PATCH`, `DELETE`): no imports, uploads,
  connect/disconnect, launches, handoff packages, backups, settings changes or AI calls;
- refuses the reads that would describe the host machine: agent detection, Claude status, MCP and
  skills inventory, GitHub, cloud backup settings, AI providers, downloads, the audit log;
- does not start the background service (no sync, no schedules);
- shows a "Demo" ribbon on every page with the install command.

The rest of the app behaves exactly as it does locally, so visitors can browse sessions, search,
open timelines, read continuation briefings and look at Wrapped and the agent comparison.

## Run it with Docker

```bash
docker build -t devcontinuity-demo .
docker run --rm -p 3000:3000 devcontinuity-demo
# open http://localhost:3000
```

The container regenerates the demo workspace on every start (about a minute), so the timeline always
ends "today". It runs as an unprivileged user and keeps nothing between restarts.

## Run it without Docker

```bash
npm install
npm run build
DEMO_DIR=/tmp/dc-demo npm run demo                       # build the fictional workspace
DEVCONTINUITY_DEMO=1 DEVCONTINUITY_DATA_DIR=/tmp/dc-demo/data HOME=/tmp/dc-demo/home PORT=3000 npm run app
```

`HOME` (or `USERPROFILE` on Windows) points at the demo's fake home folder so the Connected agents
page shows the demo's connections, not the host's. On Windows PowerShell:

```powershell
$env:DEMO_DIR = "$env:TEMP\dc-demo"; npm run demo
$env:DEVCONTINUITY_DEMO = "1"; $env:DEVCONTINUITY_DATA_DIR = "$env:TEMP\dc-demo\data"; $env:USERPROFILE = "$env:TEMP\dc-demo\home"; $env:PORT = "3000"; npm run app
```

## Deploying

Any host that runs a Dockerfile works. Give it at least 1 GB of memory. A few options:

| Host | Steps |
| --- | --- |
| Fly.io | `fly launch --no-deploy` (accept the Dockerfile, internal port 3000), then `fly deploy` |
| Render | New → Web Service → this repository → Runtime "Docker", port 3000 |
| Railway | New project → Deploy from GitHub repo; set `PORT=3000` |
| Any VPS | `docker run -d --restart unless-stopped -p 80:3000 devcontinuity-demo` behind your TLS proxy |

Put it behind HTTPS (all of the above do this for you). The demo cookie is marked `Secure` when the
proxy sends `X-Forwarded-Proto: https`.

Nothing in this repository deploys the demo automatically; deploying is a manual step.
