#!/usr/bin/env node
/**
 * Arabic / right-to-left layout check: opens every main page in Arabic at phone (390 px) and desktop
 * (1440 px) width and fails if any page scrolls sideways or still shows untranslated headings.
 *
 *   npm run demo -- --serve   (or any running DevContinuity)
 *   node scripts/demo/rtl-check.mjs            # DEMO_URL defaults to http://localhost:3299
 */
import { withBrowser } from './cdp.mjs';

const base = process.env.DEMO_URL || 'http://localhost:3299';
const PAGES = ['/', '/tasks', '/import', '/settings', '/settings?tab=agents', '/settings?tab=remote','/handoff', '/projects', '/knowledge', '/worktrees', '/verify', '/costs', '/prompts', '/backups', '/wrapped', '/skills', '/agents', '/agents?tab=compare', '/sessions', '/search?q=test'];
const WIDTHS = [390, 1440];

const firstProject = await (await fetch(`${base}/projects`)).text().then((h) => h.match(/\/projects\/([a-z0-9]{20,})/)?.[1]);
if (firstProject) PAGES.push(`/projects/${firstProject}`, `/projects/${firstProject}?tab=git`);

const problems = [];
await withBrowser(async ({ page }) => {
  await page.cookie('dc_lang', 'ar', base);
  for (const w of WIDTHS) {
    await page.viewport(w, 900, 1, w < 768);
    for (const p of PAGES) {
      await page.goto(base + p, 900);
      const r = await page.eval(`(() => {
        const doc = document.documentElement;
        const overflow = doc.scrollWidth - doc.clientWidth;
        const offenders = overflow > 1 ? [...document.querySelectorAll('body *')].filter((e) => { const b = e.getBoundingClientRect(); return b.width > 0 && (b.right > doc.clientWidth + 1 || b.left < -1) && getComputedStyle(e).position !== 'fixed' && !e.closest('.overflow-x-auto, .overflow-auto, .dc-scroll, pre, table'); }).slice(0, 3).map((e) => e.tagName.toLowerCase() + '.' + String(e.className).split(' ').slice(0, 3).join('.')) : [];
        const h1 = document.querySelector('h1')?.textContent ?? '';
        return { dir: doc.dir, overflow, offenders, h1, latinHeading: /^[A-Za-z][A-Za-z &]+$/.test(h1.trim()) };
      })()`);
      const tag = `${p} @${w}px`;
      if (r.dir !== 'rtl') problems.push(`${tag}: page is not right-to-left`);
      if (r.overflow > 1) problems.push(`${tag}: scrolls sideways by ${r.overflow}px ${r.offenders.join(', ')}`);
      if (r.latinHeading) problems.push(`${tag}: heading not translated ("${r.h1}")`);
      console.log(`${r.overflow > 1 ? 'FAIL' : 'ok  '} ${tag}${r.overflow > 1 ? ` overflow ${r.overflow}px` : ''}`);
    }
  }
});
if (problems.length) {
  console.error(`\n${problems.length} problem(s):\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log('\nAll pages are right-to-left with no horizontal overflow at 390 px and 1440 px.');
