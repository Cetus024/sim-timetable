// Unattended nightly scrape.
//
// Drives a headless Chromium-based browser against a *persistent profile* that
// you logged into once by hand, evaluates the very same scraper/scrape.js the
// bookmarklet uses, and publishes the result to data/latest.json so the viewer
// can pick it up without anyone touching anything.
//
// No password is ever stored by this script — it reuses the session cookie in
// the profile. When that session eventually expires the scrape fails loudly and
// leaves the last good data in place; re-run `--login` to sign in again.
//
//   node scripts/auto-scrape.mjs --login     sign in once, in a visible window
//   node scripts/auto-scrape.mjs             scrape + write data/latest.json
//   node scripts/auto-scrape.mjs --publish   also git commit + push the result
//
// Config lives in scripts/scrape.config.json (see scrape.config.example.json).

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CONFIG_PATH = join(ROOT, 'scripts', 'scrape.config.json');
const PROFILE = join(ROOT, '.scrape-profile');
const OUT = join(ROOT, 'data', 'latest.json');
const PORT = 9422;

const args = new Set(process.argv.slice(2));
const LOGIN = args.has('--login');
const PUBLISH = args.has('--publish');

const log = (...a) => console.log(new Date().toISOString(), ...a);

if (!existsSync(CONFIG_PATH)) {
  console.error(
    `Missing ${CONFIG_PATH}\n` +
    `Copy scripts/scrape.config.example.json to scripts/scrape.config.json and\n` +
    `set "scheduleUrl" to the SIM scheduling page you scrape.`
  );
  process.exit(2);
}

const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
const BROWSER = process.env.BROWSER_PATH || config.browserPath ||
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

if (!config.scheduleUrl || config.scheduleUrl.includes('REPLACE_ME')) {
  console.error('Set "scheduleUrl" in scripts/scrape.config.json to the SIM scheduling page URL.');
  process.exit(2);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- login mode: a visible window, driven by a human ----------

if (LOGIN) {
  log('Opening a visible browser window using the scrape profile.');
  log('Sign in to SIM as usual, make sure the schedule table is showing, then close the window.');
  const child = spawn(BROWSER, [
    `--user-data-dir=${PROFILE}`,
    '--no-first-run',
    '--no-default-browser-check',
    config.scheduleUrl,
  ], { stdio: 'ignore' });
  await new Promise(res => child.on('exit', res));
  log('Window closed — the session is now stored in .scrape-profile (gitignored).');
  process.exit(0);
}

// ---------- CDP plumbing ----------

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
    close: () => ws.close(),
    send: (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      const i = ++id;
      pending.set(i, { resolve, reject });
      ws.send(JSON.stringify({ id: i, method, params, sessionId }));
    }),
  };
}

async function browserWs() {
  for (let i = 0; i < 60; i++) {
    try {
      const j = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
      if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl;
    } catch { /* still starting */ }
    await sleep(250);
  }
  throw new Error('browser did not expose a debugging endpoint');
}

// ---------- scrape ----------

const scraperSource = readFileSync(join(ROOT, 'scraper', 'scrape.js'), 'utf8');

log('Launching headless browser with the saved profile.');
const browser = spawn(BROWSER, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${PROFILE}`,
  '--no-first-run',
  '--no-default-browser-check',
  'about:blank',
], { stdio: 'ignore' });

let cdp;
let exitCode = 0;

try {
  cdp = connect(await browserWs());
  await cdp.ready;

  const { targetId } = await cdp.send('Target.createTarget', { url: config.scheduleUrl });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);

  // Wait for the schedule table to actually appear — if the session expired we
  // will be looking at a login page instead, and must not treat that as "no rows".
  const waitMs = config.tableTimeoutMs ?? 45000;
  const deadline = Date.now() + waitMs;
  let sawTable = false;
  while (Date.now() < deadline) {
    const probe = await cdp.send('Runtime.evaluate', {
      expression: `JSON.stringify({
        rows: document.querySelectorAll('tbody.MuiTableBody-root tr').length,
        url: location.href,
        title: document.title
      })`,
      returnByValue: true,
    }, sessionId);
    const state = JSON.parse(probe.result.value);
    if (state.rows > 0) { sawTable = true; break; }
    await sleep(1000);
  }

  if (!sawTable) {
    const probe = await cdp.send('Runtime.evaluate', {
      expression: 'JSON.stringify({url: location.href, title: document.title})',
      returnByValue: true,
    }, sessionId);
    throw new Error(
      'No schedule table appeared within ' + waitMs + 'ms. The saved session has probably ' +
      'expired — run `node scripts/auto-scrape.mjs --login` to sign in again. Landed on: ' +
      probe.result.value
    );
  }

  log('Schedule table found — running the scraper.');
  await cdp.send('Runtime.evaluate', {
    expression: 'window.__SIM_SCRAPE_HEADLESS__ = true;',
  }, sessionId);

  const res = await cdp.send('Runtime.evaluate', {
    expression: scraperSource,
    awaitPromise: true,
    returnByValue: true,
  }, sessionId);

  if (res.exceptionDetails) throw new Error('scraper threw: ' + JSON.stringify(res.exceptionDetails));

  const payload = res.result.value;
  if (!payload || !Array.isArray(payload.rows) || payload.rows.length === 0) {
    throw new Error('scraper returned no rows — refusing to overwrite the last good data');
  }

  payload.auto = true;   // provenance: the viewer says "updated automatically"

  log(`Scraped ${payload.rows.length} rows` +
      (payload.site_total ? ` (site reports ${payload.site_total})` : '') +
      (payload.incomplete ? ' — flagged INCOMPLETE' : ''));

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(payload, null, 2) + '\n');
  log(`Wrote ${OUT}`);

  if (PUBLISH) {
    const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).trim();
    // Always commits: scraped_at changes every run, and a fresh timestamp is
    // exactly what tells the viewer the data is current rather than stale.
    // One commit a night is the intended cost of that.
    git('add', 'data/latest.json');
    git('-c', 'user.name=sim-timetable-bot',
        '-c', 'user.email=noreply@users.noreply.github.com',
        'commit', '-m', `Nightly scrape: ${payload.rows.length} events`);
    git('push', 'origin', 'HEAD:main');
    log('Pushed data/latest.json to origin/main.');
  }
} catch (err) {
  console.error('FAILED:', err.message);
  exitCode = 1;
} finally {
  try { cdp?.close(); } catch { /* already gone */ }
  browser.kill();
  // Chromium leaves child processes behind when the launcher is killed; give
  // them a moment, then let the OS reap them.
  await sleep(500);
}

process.exit(exitCode);
