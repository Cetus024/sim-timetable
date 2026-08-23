// End-to-end test of the bookmarklet -> viewer postMessage handoff.
// Drives headless Edge over CDP, because the handoff needs a real popup and a
// real user gesture (Runtime.evaluate userGesture:true) to be exercised honestly.
//
// Start the dev server first (node scripts/serve.mjs), then:
//
//   node scripts/test-handoff.mjs [baseUrl]
//
// Override the browser with BROWSER_PATH=<path to a Chromium-based browser>.

import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.argv[2] || 'http://localhost:4173';
const EDGE = process.env.BROWSER_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9333;

const profile = mkdtempSync(join(tmpdir(), 'handoff-'));
const edge = spawn(EDGE, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-popup-blocking',
  'about:blank',
], { stdio: 'ignore' });

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function browserWs() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      const j = await r.json();
      if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error('Edge did not expose a debugging endpoint');
}

// Minimal CDP client with flattened sessions.
function connect(url) {
  const ws = new WebSocket(url);
  let id = 0;
  const pending = new Map();
  const ready = new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  ws.onmessage = ev => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    }
  };

  return {
    ready,
    close: () => ws.close(),
    send(method, params = {}, sessionId) {
      const msgId = ++id;
      return new Promise((resolve, reject) => {
        pending.set(msgId, { resolve, reject });
        ws.send(JSON.stringify({ id: msgId, method, params, sessionId }));
      });
    },
  };
}

// The opener-side script: exactly what scrape.js does after it finishes scraping.
const OPENER_SCRIPT = `(async () => {
  const VIEWER_ORIGIN = window.location.origin;
  const payload = await (await fetch('/sample/sim-timetable.sample.json')).json();
  payload.scraped_at = new Date().toISOString();

  const win = window.open(VIEWER_ORIGIN + '/viewer?awaiting=1', 'simTimetableViewer');
  if (!win) return JSON.stringify({ fatal: 'popup blocked' });

  let pumps = 0;
  const acknowledged = await new Promise(resolve => {
    let settled = false, tries = 0;
    function finish(v) { if (settled) return; settled = true; pumps = tries; window.removeEventListener('message', onAck); resolve(v); }
    function onAck(e) { if (e.source === win && e.data && e.data.type === 'sim-timetable:received') finish(true); }
    window.addEventListener('message', onAck);
    (function pump() {
      if (settled) return;
      if (win.closed || tries++ > 40) return finish(false);
      try { win.postMessage({ type: 'sim-timetable:payload', payload }, VIEWER_ORIGIN); } catch (e) { return finish(false); }
      setTimeout(pump, 300);
    })();
  });

  await new Promise(r => setTimeout(r, 800));
  const d = win.document;
  const result = {
    acknowledged,
    pumps,
    viewerUrl: win.location.pathname + win.location.search,
    waitingPanelHidden: d.getElementById('waitingPanel').hidden,
    importPanelHidden: d.getElementById('importPanel').hidden,
    appHidden: d.getElementById('app').hidden,
    header: d.getElementById('source').textContent,
    rooms: d.querySelectorAll('.room-card').length,
    persisted: !!win.localStorage.getItem('sim-timetable-payload'),
  };
  win.close();
  return JSON.stringify(result);
})()`;

// A hostile-origin check: a page that did NOT open the viewer must not be able
// to inject data into it.
const SPOOF_SCRIPT = `(async () => {
  const O = window.location.origin;
  const win = window.__t = window.open(O + '/viewer?awaiting=1', 'spoofTarget');
  if (!win) return JSON.stringify({ fatal: 'popup blocked' });
  await new Promise(r => setTimeout(r, 900));

  // A genuine third party: a same-origin iframe. Its contentWindow is NOT the
  // viewer's opener, so e.source must not match and the payload must be ignored.
  // (Posting via postMessage.call(win, ...) from this page would NOT be a spoof —
  // e.source is set by the calling context, which here is the real opener.)
  const f = document.createElement('iframe');
  f.src = O + '/sample/sim-timetable.sample.json';
  document.body.appendChild(f);
  await new Promise(r => { f.onload = r; setTimeout(r, 1500); });

  const fake = { rows: [{ room: 'FAKE', event: 'x', start: '12:00 AM', end: '1:00 AM', start_min: 0, end_min: 60, block: 'Z', floor: 9, status: 'UPCOMING' }] };
  try {
    f.contentWindow.eval('window.top.__t.postMessage(' + JSON.stringify({ type: 'sim-timetable:payload', payload: fake }) + ', ' + JSON.stringify(O) + ')');
  } catch (e) { /* if eval is blocked the post never happens, which also passes */ }
  await new Promise(r => setTimeout(r, 800));

  const d = win.document;
  const out = {
    stillWaiting: !d.getElementById('waitingPanel').hidden,
    appHidden: d.getElementById('app').hidden,
    fakeRendered: d.body.innerHTML.includes('FAKE'),
  };
  win.close();
  return JSON.stringify(out);
})()`;

async function evalInNewTab(cdp, url, script) {
  const { targetId } = await cdp.send('Target.createTarget', { url });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Page.enable', {}, sessionId);
  await sleep(1200);
  const res = await cdp.send('Runtime.evaluate', {
    expression: script,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,          // <- this is what makes window.open legal
  }, sessionId);
  await cdp.send('Target.closeTarget', { targetId });
  if (res.exceptionDetails) throw new Error(JSON.stringify(res.exceptionDetails));
  return JSON.parse(res.result.value);
}

const cdp = connect(await browserWs());
await cdp.ready;

let failures = 0;
function check(name, pass, detail) {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : '  → ' + detail}`);
  if (!pass) failures++;
}

try {
  console.log('--- handoff: scraper tab hands data to viewer tab ---');
  const r = await evalInNewTab(cdp, BASE + '/', OPENER_SCRIPT);
  if (r.fatal) throw new Error(r.fatal);
  check('viewer acknowledged the payload', r.acknowledged === true);
  // Local delivery lands in 1-2 pumps, production in ~3; anything beyond ~10 (3s)
  // means the pump loop or the acknowledgement is actually broken.
  check('delivered promptly', r.pumps <= 10, `${r.pumps} pump(s)`);
  check('waiting panel hidden after delivery', r.waitingPanelHidden === true);
  check('import panel stays hidden', r.importPanelHidden === true);
  check('timetable is showing', r.appHidden === false);
  check('rendered all sample rooms', r.rooms === 6, `${r.rooms} rooms`);
  check('persisted to localStorage', r.persisted === true);
  check('query string cleaned from URL', !r.viewerUrl.includes('awaiting'), r.viewerUrl);
  check('header shows freshness', /just now|min ago/.test(r.header), JSON.stringify(r.header));

  console.log('\n--- origin check: a non-opener must not inject data ---');
  const s = await evalInNewTab(cdp, BASE + '/', SPOOF_SCRIPT);
  if (s.fatal) throw new Error(s.fatal);
  check('spoofed payload rejected', s.fakeRendered === false);
  check('viewer still waiting', s.stillWaiting === true);
} catch (err) {
  console.error('ERROR:', err.message);
  failures++;
} finally {
  cdp.close();
  edge.kill();
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
