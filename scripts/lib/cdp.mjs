// Minimal Chrome DevTools Protocol client — enough to launch a headless
// Chromium-based browser, open a page, and evaluate JavaScript in it.
//
// Why a browser at all, for what is just an HTTP GET: scheduling.sim.edu.sg sits
// behind a WAF that answers 464 to plain HTTP clients regardless of headers
// (curl is refused even for the HTML page, so it is not a cookie or User-Agent
// check). A real browser engine gets through; nothing else tried does.
//
// No dependencies on purpose — Node 22+ has a global WebSocket.

import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const sleep = ms => new Promise(r => setTimeout(r, ms));

const CANDIDATES = [
  process.env.BROWSER_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

export function findBrowser() {
  for (const p of CANDIDATES) {
    // On PATH-style entries existsSync is still the right check; all candidates
    // are absolute paths.
    if (existsSync(p)) return p;
  }
  throw new Error(
    'No Chromium-based browser found. Set BROWSER_PATH to Chrome/Edge/Chromium.\nTried:\n  ' +
    CANDIDATES.join('\n  ')
  );
}

function connect(url) {
  const ws = new WebSocket(url);
  let id = 0;
  const pending = new Map();
  const ready = new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
    }
  };

  return {
    ready,
    close: () => { try { ws.close(); } catch { /* already closed */ } },
    send: (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      const i = ++id;
      pending.set(i, { resolve, reject });
      ws.send(JSON.stringify({ id: i, method, params, sessionId }));
    }),
  };
}

/**
 * Launches a headless browser and hands it to `fn` as a small session object.
 * Always tears the browser down, including on throw.
 *
 * fn receives { open(url), evaluate(expr, sessionId, opts) }.
 */
export async function withBrowser(fn, { port = 9455, args = [] } = {}) {
  const exe = findBrowser();
  const profile = mkdtempSync(join(tmpdir(), 'cdp-'));

  const proc = spawn(exe, [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--no-sandbox',            // required on CI runners; harmless locally
    ...args,
    'about:blank',
  ], { stdio: 'ignore' });

  let wsUrl = null;
  for (let i = 0; i < 80 && !wsUrl; i++) {
    try {
      const j = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
      wsUrl = j.webSocketDebuggerUrl;
    } catch { /* still starting */ }
    if (!wsUrl) await sleep(250);
  }
  if (!wsUrl) {
    proc.kill();
    throw new Error('browser did not expose a debugging endpoint within 20s');
  }

  const cdp = connect(wsUrl);
  await cdp.ready;

  const session = {
    async open(url) {
      const { targetId } = await cdp.send('Target.createTarget', { url });
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
      await cdp.send('Page.enable', {}, sessionId);
      await cdp.send('Runtime.enable', {}, sessionId);
      return { targetId, sessionId };
    },
    async evaluate(expression, sessionId, opts = {}) {
      const res = await cdp.send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
        ...opts,
      }, sessionId);
      if (res.exceptionDetails) {
        throw new Error('page threw: ' + (res.exceptionDetails.exception?.description
          || JSON.stringify(res.exceptionDetails)));
      }
      return res.result.value;
    },
    close: (targetId) => cdp.send('Target.closeTarget', { targetId }),
  };

  try {
    return await fn(session);
  } finally {
    cdp.close();
    proc.kill();
    await sleep(300);
  }
}
