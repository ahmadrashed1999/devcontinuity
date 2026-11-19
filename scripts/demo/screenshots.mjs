#!/usr/bin/env node
/**
 * Captures the README screenshots from the demo workspace (npm run demo -- --serve) by driving a
 * headless Chromium browser (Edge or Chrome) over the DevTools protocol. No extra dependencies.
 *
 *   npm run demo:screenshots                # expects the demo at http://localhost:3299
 *   BROWSER=/path/to/chrome npm run demo:screenshots
 *   ONLY=skills npm run demo:screenshots    # just one (or a comma-separated list of) image(s)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { withBrowser } from './cdp.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const base = process.env.DEMO_URL || 'http://localhost:3299';
const out = path.join(root, 'docs', 'images');

const SHOTS = [
  { name: 'overview', url: '/', width: 1440, height: 1040 },
  { name: 'sessions', url: '/sessions', width: 1440, height: 980 },
  { name: 'session', url: '/sessions/{firstSession}', width: 1440, height: 980 },
  { name: 'agents', url: '/agents', width: 1440, height: 1040, wait: 2500 },
  { name: 'compare', url: '/agents?tab=compare', width: 1440, height: 760 },
  { name: 'search', url: '/search?q=checkout', width: 1440, height: 900 },
  { name: 'wrapped', url: '/wrapped', width: 1440, height: 1100 },
  { name: 'skills', url: '/skills', width: 1440, height: 1000 },
  { name: 'mobile', url: '/', width: 390, height: 844, mobile: true, scale: 2 },
  { name: 'arabic', url: '/', width: 1440, height: 980, lang: 'ar' },
  // Banner / GitHub social preview (1280x640), rendered from a local page that embeds overview.png.
  { name: 'banner', file: path.join('scripts', 'demo', 'banner.html'), width: 1280, height: 640, scale: 2 },
];

async function main() {
  fs.mkdirSync(out, { recursive: true });
  // A real session id for the session-detail shot.
  const list = await (await fetch(`${base}/sessions?agent=claude-code`)).text();
  const firstSession = list.match(/\/sessions\/([a-z0-9]{20,})/)?.[1] ?? '';
  await withBrowser(async ({ page }) => {
    // ONLY=skills,arabic regenerates just those images.
    const only = process.env.ONLY?.split(',').map((x) => x.trim());
    for (const s of SHOTS.filter((x) => !only || only.includes(x.name))) {
      await page.cookie('dc_lang', s.lang ?? 'en', base);
      await page.viewport(s.width, s.height, s.scale ?? 1, !!s.mobile);
      const target = s.file ? pathToFileURL(path.join(root, s.file)).href : base + s.url.replace('{firstSession}', firstSession);
      await page.goto(target, s.wait ?? 1200);
      const file = path.join(out, `${s.name}.png`);
      fs.writeFileSync(file, await page.screenshot());
      console.log(`${s.name}.png  ${s.width}x${s.height}  ${Math.round(fs.statSync(file).size / 1024)} KB`);
    }
  });
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
