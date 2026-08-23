// ============================================================================
// SIM Campus Timetable — grab today's schedule
//
// Run this on https://scheduling.sim.edu.sg/rad/campus.htm?id=SIM
//
// Easiest way: use the bookmarklet from https://sim-timetable.vercel.app —
// click it while on the scheduling page and it opens the viewer, reads the
// schedule, and hands it straight over. No files, no pasting.
//
// Otherwise: open DevTools -> Console (F12), paste this whole file, Enter.
//
// It reads the page's OWN data source, /rad/rest/campus?id=..., which returns
// every building, room and activity in a single response. That is why this is
// instant, and why it knows about rooms with no bookings at all — the rendered
// table only ever lists rooms that are busy.
//
// The site's WAF refuses non-browser clients, which is why this runs in a tab
// rather than on a server. It uploads nothing: the only cross-origin contact is
// a postMessage handing your own data to your own viewer tab.
// ============================================================================

(async function simTimetable() {
  // scripts/fetch-schedule.mjs sets this: it wants the payload returned rather
  // than a viewer tab or a download. One implementation, two callers.
  const HEADLESS = !!window.__SIM_SCRAPE_HEADLESS__;

  // The landing page rewrites this placeholder to its own origin when you copy
  // the script or build the bookmarklet, so local dev hands off to localhost.
  let VIEWER_ORIGIN = '__VIEWER_ORIGIN__';
  if (VIEWER_ORIGIN.slice(0, 2) === '__') VIEWER_ORIGIN = 'https://sim-timetable.vercel.app';

  const CAMPUS = new URLSearchParams(location.search).get('id') || 'SIM';
  const API_PATH = '/rad/rest/campus?id=' + encodeURIComponent(CAMPUS);

  // Open the viewer NOW, while the click that started us still counts as a user
  // gesture — waiting until the fetch finishes would get the popup blocked.
  let viewerWin = null;
  if (!HEADLESS) {
    try {
      viewerWin = window.open(VIEWER_ORIGIN + '/viewer?awaiting=1', 'simTimetableViewer');
    } catch (err) {
      viewerWin = null;
    }
    if (!viewerWin) {
      console.log('Could not open the viewer tab (popup blocked?) — will download the JSON instead.');
    }
  }

  // ---- read the campus API ----

  if (!/scheduling\.sim\.edu\.sg$/i.test(location.hostname)) {
    const msg = 'Run this on scheduling.sim.edu.sg — the campus API is same-origin only.';
    console.error(msg);
    if (viewerWin) try { viewerWin.close(); } catch (err) { /* best effort */ }
    throw new Error(msg);
  }

  const res = await fetch(API_PATH, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error('campus API returned HTTP ' + res.status);
  const api = await res.json();
  if (!api || !api.success || !api.data) {
    throw new Error('campus API reported failure: ' + ((api && api.message) || 'no message'));
  }

  // ---- transform ----

  /* "SIM Campus Block A" -> "A"; falls back to the room code's ".X." group. */
  function blockOf(buildingName, roomCode) {
    let m = /Block\s+([A-Za-z])\b/i.exec(buildingName || '');
    if (m) return m[1].toUpperCase();
    m = /\.([A-Za-z])\./.exec(roomCode || '');
    return m ? m[1].toUpperCase() : null;
  }

  /* LT.A.1.08 -> 1. Deliberately no trailing-digit fallback: "TR.1" is Tutor
   * Room 1, not floor 1, and guessing is worse than admitting we don't know. */
  function floorOf(roomCode) {
    const m = /\.[A-Za-z]\.(\d+)\./.exec(roomCode || '') || /\.(\d+)\./.exec(roomCode || '');
    return m ? parseInt(m[1], 10) : null;
  }

  /* "2026-08-24 15:30:00" -> {min: 930, label: "3:30 PM", date: "2026-08-24"} */
  function parseStamp(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(s || '');
    if (!m) return null;
    const h = parseInt(m[4], 10), mi = parseInt(m[5], 10);
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return {
      min: h * 60 + mi,
      label: h12 + ':' + String(mi).padStart(2, '0') + ' ' + (h < 12 ? 'AM' : 'PM'),
      date: m[1] + '-' + m[2] + '-' + m[3],
    };
  }

  const rooms = [];
  const rows = [];
  const dates = new Set();

  for (const building of api.data.buildings || []) {
    for (const room of building.rooms || []) {
      const code = room.code || room.name || '';
      const block = blockOf(building.name, code);
      const floor = floorOf(code);
      const activities = room.activities || [];

      rooms.push({
        room: code,
        description: room.description || '',
        building: building.name || '',
        block,
        floor,
        activities: activities.length,
      });

      for (const act of activities) {
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
          status: '',
          description: act.description || '',
          room_description: room.description || '',
        });
      }
    }
  }

  if (rooms.length === 0) throw new Error('campus API returned no rooms');

  // Status relative to now, the same way the site's own table shows it. The
  // viewer recomputes this from the clock when it renders, so a payload read at
  // midnight does not still claim everything is UPCOMING at 3pm.
  const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
  for (const r of rows) {
    if (r.start_min === null || r.end_min === null) continue;
    r.status = r.end_min <= nowMin ? 'PAST' : (r.start_min <= nowMin ? 'CURRENT' : 'UPCOMING');
  }

  const payload = {
    version: 2,
    source: location.origin + API_PATH,
    campus: api.data.name || CAMPUS,
    scraped_at: new Date().toISOString(),
    schedule_dates: [...dates].sort(),
    incomplete: false,
    site_total: rows.length,
    rooms,
    rows,
  };

  const freeAllDay = rooms.filter(r => r.activities === 0).length;
  console.log(
    `Read ${rows.length} bookings across ${rooms.length} rooms ` +
    `(${freeAllDay} free all day) for ${payload.schedule_dates.join(', ') || 'no dated activities'}.`
  );

  if (HEADLESS) {
    window.simTimetable = payload;
    return payload;
  }

  // ---- hand off to the viewer tab ----

  /* Pushes the payload to the viewer until it acknowledges. We retry on a timer
   * rather than wait for a "ready" ping, so neither tab has to win a race. */
  function handOff(win) {
    return new Promise(resolve => {
      let settled = false;
      let tries = 0;

      function finish(ok) {
        if (settled) return;
        settled = true;
        window.removeEventListener('message', onAck);
        resolve(ok);
      }

      function onAck(e) {
        if (e.source !== win) return;
        if (!e.data || e.data.type !== 'sim-timetable:received') return;
        finish(true);
      }

      window.addEventListener('message', onAck);

      (function pump() {
        if (settled) return;
        if (win.closed || tries++ > 40) return finish(false);
        try {
          win.postMessage({ type: 'sim-timetable:payload', payload }, VIEWER_ORIGIN);
        } catch (err) {
          return finish(false);
        }
        setTimeout(pump, 300);
      })();
    });
  }

  let delivered = false;
  if (viewerWin && !viewerWin.closed) {
    delivered = await handOff(viewerWin);
    if (delivered) {
      console.log('Handed to the viewer tab.');
      try { viewerWin.focus(); } catch (err) { /* focus is best-effort */ }
    } else {
      console.warn('The viewer tab never acknowledged — falling back to a download.');
    }
  }

  // ---- fallback: download + clipboard ----

  if (!delivered) {
    const json = JSON.stringify(payload, null, 2);

    const blob = new Blob([json], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'sim-timetable.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);

    try {
      await navigator.clipboard.writeText(json);
      console.log('Copied the JSON to your clipboard as well.');
    } catch (err) {
      console.log('Clipboard copy was blocked (that is fine) — use the downloaded file instead.');
    }

    console.log('Open the viewer and drop in sim-timetable.json.');
  }

  window.simTimetable = payload;
  return payload;
})();
