#!/usr/bin/env node
/**
 * Records the README hero animation (docs/images/demo.gif) from the demo workspace:
 * an agent hits its limit → DevContinuity notifies you → review and hand the briefing to Codex →
 * Codex's session appears in the same log.
 *
 *   npm run demo                        # build the fictional workspace (DEMO_DIR, default ./demo)
 *   PORT=3299 npm run app               # with DEVCONTINUITY_DATA_DIR=<DEMO_DIR>/data, NOT demo mode
 *   npm run demo:gif                    # expects it at http://localhost:3299
 *
 * The last step writes a few live-capture events as Codex and imports them, exactly as Codex's hooks
 * or MCP log tools would; it only touches the demo workspace.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import gifenc from 'gifenc';
import pngjs from 'pngjs';
import { sleep, withBrowser } from './cdp.mjs';

const { GIFEncoder, applyPalette, quantize } = gifenc;
const { PNG } = pngjs;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const base = process.env.DEMO_URL || 'http://localhost:3299';
const demoDir = path.resolve(process.env.DEMO_DIR?.trim() || path.join(root, 'demo'));
const token = fs.readFileSync(path.join(process.env.DEVCONTINUITY_DATA_DIR?.trim() || path.join(demoDir, 'data'), '.api-token'), 'utf8').trim();
const out = path.join(root, 'docs', 'images', 'demo.gif');
const W = 1280;
const H = 800;
const OUT_W = Number(process.env.GIF_WIDTH) || 960;

const apiCall = async (p, init = {}) => {
  const r = await fetch(`${base}/api/${p}`, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...init.headers } });
  const body = await r.json();
  if (!r.ok) throw new Error(`${p}: ${body.error ?? r.status}`);
  return body;
};

const CAPTION = (step, text) => `(() => {
  document.getElementById('dc-caption')?.remove();
  const d = document.createElement('div');
  d.id = 'dc-caption';
  d.style.cssText = 'position:fixed;left:50%;bottom:22px;transform:translateX(-50%);z-index:99999;display:flex;gap:10px;align-items:center;padding:10px 18px;border-radius:999px;background:rgba(10,14,26,.92);border:1px solid rgba(99,102,241,.6);box-shadow:0 10px 40px rgba(0,0,0,.5);font:600 17px Inter,system-ui,sans-serif;color:#fff;white-space:nowrap';
  d.innerHTML = '<span style="display:grid;place-items:center;width:26px;height:26px;border-radius:999px;background:linear-gradient(135deg,#6366f1,#06b6d4);font-size:14px">${step}</span><span>${text.replace(/'/g, "\\'")}</span>';
  document.body.appendChild(d);
})()`;

/** Downscales an RGBA frame (box filter) so the GIF stays small. */
function downscale(png, outW) {
  const scale = png.width / outW;
  const outH = Math.round(png.height / scale);
  const dst = new Uint8ClampedArray(outW * outH * 4);
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      const sx0 = Math.floor(x * scale);
      const sy0 = Math.floor(y * scale);
      const sx1 = Math.min(png.width, Math.floor((x + 1) * scale));
      const sy1 = Math.min(png.height, Math.floor((y + 1) * scale));
      let r = 0, g = 0, b = 0, n = 0;
      for (let sy = sy0; sy < Math.max(sy1, sy0 + 1); sy++) {
        for (let sx = sx0; sx < Math.max(sx1, sx0 + 1); sx++) {
          const i = (sy * png.width + sx) * 4;
          r += png.data[i];
          g += png.data[i + 1];
          b += png.data[i + 2];
          n++;
        }
      }
      const o = (y * outW + x) * 4;
      dst[o] = r / n;
      dst[o + 1] = g / n;
      dst[o + 2] = b / n;
      dst[o + 3] = 255;
    }
  }
  return { data: dst, width: outW, height: outH };
}

async function main() {
  const limits = await apiCall('handoff/limits');
  const item = limits.items[0];
  if (!item) throw new Error('No pending limit stop in the demo workspace. Re-run "npm run demo".');
  const frames = [];

  await withBrowser(async ({ send, page }) => {
    await page.viewport(W, H);
    await page.cookie('dc_lang', process.env.GIF_LANG || 'en', base);
    await send('Browser.grantPermissions', { origin: new URL(base).origin, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] }).catch(() => undefined);
    const shot = async (step, caption, delay) => {
      await page.eval(CAPTION(step, caption));
      await sleep(250);
      frames.push({ png: await page.screenshot(), delay });
      console.log(`frame ${frames.length}: ${caption}`);
    };

    // 1. The limit stop is on the Overview, and the bell has a notification.
    await page.goto(`${base}/`, 1800);
    await shot(1, 'Claude Code hits its usage limit in the middle of a task', 2600);

    // 2. The notification.
    await page.eval(`document.querySelector('button[title="Notifications"]').click()`);
    await sleep(900);
    await shot(2, 'DevContinuity notices and tells you', 2400);

    // 3. Following it highlights the card.
    await page.goto(`${base}/?handoff=${item.sessionId}`, 1600);
    await shot(3, 'One click continues the same work in another agent', 2400);

    // 4–5. Review exactly what will be shared.
    await page.click('Review & copy briefing');
    await sleep(1500);
    await shot(4, 'Review the briefing before it leaves your machine', 2600);
    await page.eval(`(() => { const s = [...document.querySelectorAll('[role=dialog] label')].find((l) => l.textContent.includes('Last user request')); s?.scrollIntoView({ block: 'start' }); })()`);
    await sleep(500);
    await shot(5, 'Last request, files it touched, errors, Git state', 2600);

    // 6. Copy for Codex. Headless browsers have no real clipboard, so the recording page gets a stand-in.
    await page.eval(`Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => {} }, configurable: true })`);
    await page.click('Copy for', '[role=dialog] button');
    await sleep(1600);
    await shot(6, 'Paste it into Codex (or let DevContinuity open Codex for you)', 2400);

    // 7. Codex continues; its session lands in the same log (as Codex's hooks / MCP would record it).
    const cwd = item.cwd;
    const session = `codex-continue-${Date.now().toString(36)}`;
    await apiCall('ingest/event', {
      method: 'POST',
      body: JSON.stringify({
        agent: 'codex',
        session,
        cwd,
        events: [
          { kind: 'prompt', text: `Continue: ${item.project?.name ?? 'acme-shop-api'}. Read the DevContinuity briefing and finish: ${item.title}` },
          { kind: 'tool_call', tool: 'shell', command: 'npm test -- checkout' },
          { kind: 'tool_result', tool: 'shell', text: 'Tests: 14 passed, 14 total' },
          { kind: 'assistant', text: 'The sliding-window limiter now returns 429 with Retry-After; the two failing checkout tests pass.' },
          { kind: 'summary', title: 'Rate limiting for checkout', status: 'done', text: 'Finished the work Claude Code started: sliding window per API key (60/min), 429 + Retry-After, tests green.', filesChanged: ['src/middleware/rateLimit.ts', 'src/routes/checkout.ts'] },
        ],
      }),
    });
    const job = await apiCall('import', { method: 'POST', body: JSON.stringify({ agents: ['live'], includeAssets: false }) });
    for (let i = 0; i < 120; i++) {
      const j = await apiCall(`jobs/${job.jobId}`);
      if (j.status !== 'running' && j.status !== 'queued') break;
      await sleep(500);
    }
    await page.goto(`${base}/`, 1800);
    await shot(7, 'Codex picks it up, and its session appears in the same log', 3000);

    const codex = (await apiCall('sessions?agent=codex&limit=1')).rows[0];
    if (codex) {
      await page.goto(`${base}/sessions/${codex.id}`, 1800);
      await shot(8, 'Every agent, one searchable timeline', 3000);
    }
  });

  // GIF_FRAMES_DIR=<dir> keeps the full-size frames for inspection.
  if (process.env.GIF_FRAMES_DIR) {
    fs.mkdirSync(process.env.GIF_FRAMES_DIR, { recursive: true });
    frames.forEach((f, i) => fs.writeFileSync(path.join(process.env.GIF_FRAMES_DIR, `frame-${i + 1}.png`), f.png));
  }

  // Encode.
  const gif = GIFEncoder();
  for (const f of frames) {
    const img = downscale(PNG.sync.read(f.png), OUT_W);
    const palette = quantize(img.data, 256, { format: 'rgb565' });
    gif.writeFrame(applyPalette(img.data, palette, 'rgb565'), img.width, img.height, { palette, delay: f.delay });
  }
  gif.finish();
  fs.writeFileSync(out, gif.bytes());
  const total = frames.reduce((a, f) => a + f.delay, 0) / 1000;
  console.log(`\n${path.relative(root, out)}: ${frames.length} frames, ${total.toFixed(1)} s, ${(fs.statSync(out).size / 1024 / 1024).toFixed(2)} MB`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
