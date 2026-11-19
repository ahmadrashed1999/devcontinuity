# AI organization module (optional, experimental)

A CEO, departments and workers that plan and carry out owner orders in sandboxed Git worktrees, with
every merge, push, PR, deployment and client message waiting for the owner's approval.

It is **off by default** and kept apart from the core (capturing, searching and continuing every
agent's work), so the core can be read without it.

| Part | Where |
| --- | --- |
| Engine, executors, agent loop, default org chart | `src/modules/org/server/` |
| API routes (`/api/org`, `/api/orders`, `/api/decisions`, `/api/killswitch`, `/api/activity`, …) | `src/modules/org/api.ts` |
| UI components | `src/modules/org/ui.tsx` |
| Pages `/owner`, `/owner/decisions`, `/owner/reviews`, `/owner/orders`, `/org`, `/activity` | `src/app/(org)/` |

## The boundary

- Nothing under `src/server/` imports the module. `src/server/scheduler.ts` loads the engine with a
  dynamic `import()` only for the `order` schedule action, and only when the module is on. The
  background service (`scripts/orchestrator.ts`) and the API router are the two places that wire it in.
- The API router registers `orgRoutes` but answers 404 for them while the module is off.
- `src/app/(org)/layout.tsx` turns every module page into a 404 while it is off; the menu hides them.
- The orchestrator (`scripts/orchestrator.ts`) only runs the engine's tick when the module is on.
- Turning it off never deletes anything: its tables (departments, roles, orders, work items, runs,
  decisions) and migrations stay in the database.

Switch it on in **Settings → Features**.
