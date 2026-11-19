## What and why

<!-- What does this change, and what problem does it solve? Link the issue: "Closes #123". -->

## How it was checked

- [ ] `npm run typecheck`, `npm run lint` and `npm test` pass
- [ ] New logic has tests (adapters: a fixture test in `tests/agents.test.ts`)
- [ ] UI changes: checked in English and Arabic (`npm run demo:rtl`), at phone and desktop width
- [ ] Screenshots or a GIF for visible changes (from the demo workspace, `npm run demo`, never real history)

## Safety

- [ ] Agents' original files are still only read
- [ ] No new database reset; migrations are additive
- [ ] No private data (transcripts, tokens, home paths) in code, tests, fixtures or screenshots
