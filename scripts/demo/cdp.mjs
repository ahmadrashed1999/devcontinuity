/**
 * Minimal headless Chromium (Edge or Chrome) driver over the DevTools protocol, shared by the
 * screenshot and GIF scripts. No dependencies: Node's fetch and WebSocket only.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function findBrowser() {
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

/** Starts a headless browser, runs fn({ send, once, page }), then closes it. */
export async function withBrowser(fn, { port = 9333 } = {}) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-shots-'));
  const browser = spawn(findBrowser(), ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--disable-gpu', '--force-color-profile=srgb', 'about:blank'], { stdio: 'ignore' });
  try {
    let wsUrl;
    for (let i = 0; i < 50 && !wsUrl; i++) {
      await sleep(200);
      try {
        const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        wsUrl = targets.find((t) => t.type === 'page')?.webSocketDebuggerUrl;
      } catch {
        /* browser still starting */
      }
    }
    if (!wsUrl) throw new Error('The browser did not start its DevTools endpoint.');
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', rej, { once: true });
    });
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
    await send('Runtime.enable');

    const page = {
      async viewport(width, height, scale = 1, mobile = false) {
        await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile });
      },
      async goto(url, wait = 1200) {
        const loaded = once('Page.loadEventFired');
        await send('Page.navigate', { url });
        await loaded;
        await sleep(wait);
      },
      /** Evaluates an expression in the page (async allowed) and returns its JSON value. */
      async eval(expression) {
        const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
        return r.result.value;
      },
      /** Clicks the first element whose text contains `text` (optionally within a CSS selector). */
      async click(text, selector = 'button, a, summary, label') {
        const ok = await page.eval(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.textContent.includes(${JSON.stringify(text)})); if (!el) return false; el.scrollIntoView({ block: 'center' }); el.click(); return true; })()`);
        if (!ok) throw new Error(`Nothing to click with text "${text}".`);
      },
      async screenshot() {
        // fromSurface + a fresh frame avoids half-composited tiles when overlays just opened.
        await send('Runtime.evaluate', { expression: 'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))', awaitPromise: true });
        const { data } = await send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
        return Buffer.from(data, 'base64');
      },
      async cookie(name, value, url) {
        await send('Network.setCookie', { name, value, url });
      },
    };
    const result = await fn({ send, once, page });
    ws.close();
    return result;
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
