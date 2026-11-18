#!/usr/bin/env node
/**
 * Captures the README screenshots from the demo workspace (npm run demo -- --serve) by driving a
 * headless Chromium browser (Edge or Chrome) over the DevTools protocol. No extra dependencies.
 *
 *   npm run demo:screenshots                # expects the demo at http://localhost:3299
 *   BROWSER=/path/to/chrome npm run demo:screenshots
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const base = process.env.DEMO_URL || 'http://localhost:3299';
const out = path.join(root, 'docs', 'images');
const PORT = 9333;

const SHOTS = [
  { name: 'overview', url: '/', width: 1440, height: 1040 },
  { name: 'sessions', url: '/sessions', width: 1440, height: 980 },
  { name: 'session', url: '/sessions/{firstSession}', width: 1440, height: 980 },
  { name: 'agents', url: '/agents', width: 1440, height: 1040, wait: 2500 },
  { name: 'search', url: '/search?q=checkout', width: 1440, height: 900 },
  { name: 'mobile', url: '/', width: 390, height: 844, mobile: true, scale: 2 },
  { name: 'arabic', url: '/', width: 1440, height: 980, lang: 'ar' },
  // Banner / GitHub social preview (1280x640), rendered from a local page that embeds overview.png.
  { name: 'banner', file: path.join('scripts', 'demo', 'banner.html'), width: 1280, height: 640, scale: 2 },
];

function findBrowser() {
  if (process.env.BROWSER) return process.env.BROWSER;
  const c = process.platform === 'win32'
    ? ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe']
    : process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Chromium.app/Contents/MacOS/Chromium']
      : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'];
  const found = c.find((p) => fs.existsSync(p));
  if (!found) throw new Error('No Chromium-based browser found. Set BROWSER=/path/to/chrome.');
  return found;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  fs.mkdirSync(out, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-shots-'));
  const browser = spawn(findBrowser(), ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
  try {
    let wsUrl;
    for (let i = 0; i < 50 && !wsUrl; i++) {
      await sleep(200);
      try {
        const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
        wsUrl = targets.find((t) => t.type === 'page')?.webSocketDebuggerUrl;
      } catch {
        /* browser still starting */
      }
    }
    if (!wsUrl) throw new Error('The browser did not start its DevTools endpoint.');
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => ws.addEventListener('open', res, { once: true }) || ws.addEventListener('error', rej, { once: true }));
    let seq = 0;
    const pending = new Map();
    const waiters = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      } else if (msg.method) {
        for (const w of [...waiters]) if (w.method === msg.method) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve(msg.params);
        }
      }
    });
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
    const once = (method, timeout = 20_000) => Promise.race([new Promise((resolve) => waiters.push({ method, resolve })), sleep(timeout)]);
    await send('Page.enable');
    await send('Network.enable');

    // A real session id for the session-detail shot.
    const list = await (await fetch(`${base}/sessions?agent=claude-code`)).text();
    const firstSession = list.match(/\/sessions\/([a-z0-9]{20,})/)?.[1] ?? '';

    for (const s of SHOTS) {
      await send('Network.setCookie', { name: 'dc_lang', value: s.lang ?? 'en', url: base });
      await send('Emulation.setDeviceMetricsOverride', { width: s.width, height: s.height, deviceScaleFactor: s.scale ?? 1, mobile: !!s.mobile });
      const loaded = once('Page.loadEventFired');
      const target = s.file ? pathToFileURL(path.join(root, s.file)).href : base + s.url.replace('{firstSession}', firstSession);
      await send('Page.navigate', { url: target });
      await loaded;
      await sleep(s.wait ?? 1200);
      const { data } = await send('Page.captureScreenshot', { format: 'png' });
      const file = path.join(out, `${s.name}.png`);
      fs.writeFileSync(file, Buffer.from(data, 'base64'));
      console.log(`${s.name}.png  ${s.width}x${s.height}  ${Math.round(fs.statSync(file).size / 1024)} KB`);
    }
    ws.close();
  } finally {
    browser.kill();
    // The browser may hold its profile for a moment after exiting; a leftover temp folder is harmless.
    for (let i = 0; i < 10; i++) {
      await sleep(500);
      try {
        fs.rmSync(profile, { recursive: true, force: true });
        break;
      } catch {
        /* still locked */
      }
    }
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
