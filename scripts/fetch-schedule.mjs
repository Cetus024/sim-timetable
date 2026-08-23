// Fetches the campus schedule from SIM's own REST API and writes data/latest.json.
//
//   node scripts/fetch-schedule.mjs            fetch + write
//   node scripts/fetch-schedule.mjs --publish  also git commit + push
//   node scripts/fetch-schedule.mjs --campus SIM
//
// The page at scheduling.sim.edu.sg is a front end over /rad/rest/campus?id=…,
// which returns every building, every room, and every activity in one response.
// That is strictly better than scraping the rendered table: no pagination, no
// auto-advance race, exact timestamps, and — the part the table can never show —
// the rooms with NO bookings at all, which are precisely the rooms free all day.
//
// It still runs through a browser because the site's WAF rejects plain HTTP
// clients; see scripts/lib/cdp.mjs.

import { writeFileSync, mkdirSync } from 'node:fs';
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
const API_PATH = `/rad/rest/campus?id=${CAMPUS}`;

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------- transform ----------

/** "SIM Campus Block A" -> "A"; falls back to the room code's ".X." group. */
function blockOf(buildingName, roomCode) {
  let m = /Block\s+([A-Za-z])\b/i.exec(buildingName || '');
  if (m) return m[1].toUpperCase();
  m = /\.([A-Za-z])\./.exec(roomCode || '');
  return m ? m[1].toUpperCase() : null;
}

/**
 * Floor from codes like LT.A.1.08 -> 1.
 * Deliberately does NOT fall back to trailing digits: "TR.1" is Tutor Room 1,
 * not floor 1, and guessing there would be worse than admitting we don't know.
 */
function floorOf(roomCode) {
  const m = /\.[A-Za-z]\.(\d+)\./.exec(roomCode || '') || /\.(\d+)\./.exec(roomCode || '');
  return m ? parseInt(m[1], 10) : null;
}

/** "2026-08-24 15:30:00" -> {min: 930, label: "3:30 PM", date: "2026-08-24"} */
function parseStamp(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(s || '');
  if (!m) return null;
  const h = parseInt(m[4], 10), mi = parseInt(m[5], 10);
  const ap = h < 12 ? 'AM' : 'PM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return {
    min: h * 60 + mi,
    label: `${h12}:${String(mi).padStart(2, '0')} ${ap}`,
    date: `${m[1]}-${m[2]}-${m[3]}`,
  };
}

function transform(api) {
  const data = api.data || {};
  const rooms = [];
  const rows = [];
  const dates = new Set();

  for (const building of data.buildings || []) {
    for (const room of building.rooms || []) {
      const code = room.code || room.name || '';
      const block = blockOf(building.name, code);
      const floor = floorOf(code);

      rooms.push({
        room: code,
        description: room.description || '',
        building: building.name || '',
        block,
        floor,
        activities: (room.activities || []).length,
      });

      for (const act of room.activities || []) {
        const s = parseStamp(act.startDateTime);
        const e = parseStamp(act.endDateTime);
        if (s) dates.add(s.date);
        rows.push({
          start: s ? s.label : null,
          end: e ? e.label : null,
          start_min: s ? s.min : null,
          end_min: e ? e.min : null,
          block,
          floor,
          room: code,
          event: act.name || '',
          status: '',              // filled in below, relative to fetch time
          description: act.description || '',
          room_description: room.description || '',
        });
      }
    }
  }

  // Status is relative to when we looked, exactly as the site's own table shows it.
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  for (const r of rows) {
    if (r.start_min === null || r.end_min === null) continue;
    r.status = r.end_min <= nowMin ? 'PAST' : (r.start_min <= nowMin ? 'CURRENT' : 'UPCOMING');
  }

  return { rooms, rows, dates: [...dates].sort() };
}

// ---------- fetch ----------

log(`Fetching ${API_PATH} via a real browser (the WAF refuses plain HTTP clients).`);

let payload;
try {
  payload = await withBrowser(async (session) => {
    const { sessionId, targetId } = await session.open(PAGE_URL);

    // Let the app boot: it is the page load that gets us past the WAF and sets
    // the ALB cookies the API call rides on.
    let apiText = null;
    for (let attempt = 0; attempt < 20 && !apiText; attempt++) {
      await sleep(1000);
      apiText = await session.evaluate(`
        (async () => {
          try {
            const r = await fetch(${JSON.stringify(API_PATH)}, { headers: { Accept: 'application/json' } });
            if (!r.ok) return null;
            const t = await r.text();
            return t && t.length > 100 ? t : null;
          } catch (e) { return null; }
        })()
      `, sessionId);
    }

    if (!apiText) {
      const where = await session.evaluate('JSON.stringify({url: location.href, title: document.title})', sessionId);
      throw new Error('could not read the campus API. Landed on: ' + where);
    }

    await session.close(targetId);
    return apiText;
  });
} catch (err) {
  console.error('FAILED:', err.message);
  process.exit(1);
}

let api;
try {
  api = JSON.parse(payload);
} catch (err) {
  console.error('FAILED: API response was not JSON:', err.message);
  process.exit(1);
}

if (!api.success || !api.data) {
  console.error('FAILED: API reported failure:', api.message || '(no message)');
  process.exit(1);
}

const { rooms, rows, dates } = transform(api);

// Refuse to publish something obviously broken over known-good data.
if (rooms.length === 0) {
  console.error('FAILED: API returned no rooms — refusing to overwrite the last good data');
  process.exit(1);
}

const out = {
  version: 2,
  source: 'https://scheduling.sim.edu.sg' + API_PATH,
  campus: api.data.name || CAMPUS,
  scraped_at: new Date().toISOString(),
  schedule_dates: dates,
  auto: true,
  incomplete: false,
  site_total: rows.length,
  rooms,
  rows,
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');

const freeAllDay = rooms.filter(r => r.activities === 0).length;
log(`${rows.length} bookings across ${rooms.length} rooms ` +
    `(${freeAllDay} with nothing booked all day) for ${dates.join(', ') || 'no dated activities'}`);
log(`Wrote ${OUT}`);

if (PUBLISH) {
  const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).trim();
  const status = git('status', '--porcelain', 'data/latest.json');
  if (!status) {
    log('data/latest.json unchanged — nothing to publish.');
  } else {
    git('add', 'data/latest.json');
    git('-c', 'user.name=sim-timetable-bot',
        '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com',
        'commit', '-m', `Daily schedule: ${rows.length} bookings, ${rooms.length} rooms`);
    git('push', 'origin', 'HEAD:main');
    log('Pushed data/latest.json.');
  }
}
