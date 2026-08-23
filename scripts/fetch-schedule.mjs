// Fetches the campus schedule and writes data/latest.json.
//
//   node scripts/fetch-schedule.mjs             fetch + write
//   node scripts/fetch-schedule.mjs --publish   also git commit + push
//   node scripts/fetch-schedule.mjs --campus SIM
//
// This does NOT reimplement the read. It opens the scheduling page in a headless
// browser and evaluates scraper/scrape.js — the very same file the bookmarklet
// runs — with window.__SIM_SCRAPE_HEADLESS__ set, so the script returns its
// payload instead of opening a viewer tab. One implementation, two callers; a
// second copy would drift and the drift would be invisible.
//
// A browser is needed at all because the site's WAF answers 464 to plain HTTP
// clients — curl is refused even for the HTML page. See scripts/lib/cdp.mjs.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { withBrowser, sleep } from './lib/cdp.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, 'data', 'latest.json');

const argv = process.argv.slice(2);
const PUBLISH = argv.includes('--publish');
const campusIdx = argv.indexOf('--campus');
const CAMPUS = campusIdx !== -1 ? argv[campusIdx + 1] : 'SIM';

const PAGE_URL = `https://scheduling.sim.edu.sg/rad/campus.htm?id=${CAMPUS}`;

const log = (...a) => console.log(new Date().toISOString(), ...a);

const scraperSource = readFileSync(join(ROOT, 'scraper', 'scrape.js'), 'utf8');

log(`Reading ${PAGE_URL} through a headless browser.`);

let payload;
try {
  payload = await withBrowser(async (session) => {
    const { sessionId, targetId } = await session.open(PAGE_URL);

    // Wait for the app to boot — it is the page load that gets us past the WAF.
    let ready = false;
    for (let i = 0; i < 30 && !ready; i++) {
      await sleep(1000);
      ready = await session.evaluate(
        `!!document.querySelector('tbody.MuiTableBody-root tr') || !!window.fetch`,
        sessionId
      );
    }

    await session.evaluate('window.__SIM_SCRAPE_HEADLESS__ = true;', sessionId);
    const result = await session.evaluate(scraperSource, sessionId);

    if (!result) {
      const where = await session.evaluate(
        'JSON.stringify({url: location.href, title: document.title})', sessionId);
      throw new Error('the scraper returned nothing. Landed on: ' + where);
    }

    await session.close(targetId);
    return result;
  });
} catch (err) {
  console.error('FAILED:', err.message);
  process.exit(1);
}

// Refuse to publish something obviously broken over known-good data.
if (!payload.rooms || payload.rooms.length === 0) {
  console.error('FAILED: no rooms returned — refusing to overwrite the last good data');
  process.exit(1);
}
if (!payload.rows || payload.rows.length === 0) {
  console.error('FAILED: no bookings returned — refusing to overwrite the last good data');
  process.exit(1);
}

payload.auto = true;   // provenance: the viewer shows "updated automatically"

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(payload, null, 2) + '\n');

const freeAllDay = payload.rooms.filter(r => r.activities === 0).length;
log(`${payload.rows.length} bookings across ${payload.rooms.length} rooms ` +
    `(${freeAllDay} free all day) for ${payload.schedule_dates.join(', ') || 'no dated activities'}`);
log(`Wrote ${OUT}`);

if (PUBLISH) {
  const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).trim();
  if (!git('status', '--porcelain', 'data/latest.json')) {
    log('data/latest.json unchanged — nothing to publish.');
  } else {
    git('add', 'data/latest.json');
    git('-c', 'user.name=sim-timetable-bot',
        '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com',
        'commit', '-m', `Daily schedule: ${payload.rows.length} bookings`);
    git('push', 'origin', 'HEAD:main');
    log('Pushed data/latest.json.');
  }
}
