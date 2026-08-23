// ============================================================================
// SIM Campus Timetable — scraper
//
// Run this on the SIM scheduling page (it needs your logged-in session, which
// is why it runs in your browser rather than on a server).
//
// Easiest way: use the bookmarklet from https://sim-timetable.vercel.app —
// click it while on the scheduling page and it opens the viewer, scrapes, and
// hands the data straight over. No files, no pasting.
//
// Otherwise: open DevTools -> Console (F12), paste this whole file, Enter.
// If the viewer tab can't be opened (popup blocked), it falls back to
// downloading sim-timetable.json and copying it to your clipboard.
//
// It uploads nothing. The only cross-origin contact is a postMessage handing
// your own data to your own viewer tab.
// ============================================================================

(async function scrapeSIMTimetable() {
  const sleep = ms => new Promise(res => setTimeout(res, ms));

  // The landing page rewrites this placeholder to its own origin when you copy
  // the script or build the bookmarklet, so local dev hands off to localhost.
  let VIEWER_ORIGIN = '__VIEWER_ORIGIN__';
  if (VIEWER_ORIGIN.slice(0, 2) === '__') VIEWER_ORIGIN = 'https://sim-timetable.vercel.app';

  // Open the viewer NOW, while the click that started us still counts as a user
  // gesture — waiting until the scrape finishes would get the popup blocked.
  let viewerWin = null;
  try {
    viewerWin = window.open(VIEWER_ORIGIN + '/viewer?awaiting=1', 'simTimetableViewer');
  } catch (err) {
    viewerWin = null;
  }
  if (!viewerWin) {
    console.log('Could not open the viewer tab (popup blocked?) — will download the JSON instead.');
  }

  // ---- helpers to defend against the site's own auto-advancing pagination ----

  function getPaginationInfoText() {
    // MUI's "labelDisplayedRows" text, e.g. "8-14 of 112" — used to know the true total
    // and to notice if the page jumped further than expected between our own clicks.
    const candidates = Array.from(document.querySelectorAll('p, span, div'))
      .map(el => el.innerText || '')
      .filter(t => /\d+\s*[-–]\s*\d+\s+of\s+\d+/i.test(t));
    return candidates[0] || null;
  }

  function parsePaginationInfo(text) {
    if (!text) return null;
    const m = text.match(/(\d+)\s*[-–]\s*(\d+)\s+of\s+(\d+)/i);
    if (!m) return null;
    return { from: parseInt(m[1], 10), to: parseInt(m[2], 10), total: parseInt(m[3], 10) };
  }

  function nextPageButton() {
    return document.querySelector('button[aria-label="Go to next page"]');
  }

  function prevPageButton() {
    return document.querySelector(
      'button[aria-label="Go to previous page"], button[aria-label="Previous Page"]'
    );
  }

  function isDisabled(btn) {
    return !btn || btn.disabled || btn.classList.contains('Mui-disabled');
  }

  async function resetToFirstPage() {
    // Try a direct "first page" button if the site has one.
    const firstBtn = document.querySelector(
      'button[aria-label="Go to first page"], button[aria-label="First Page"], button[aria-label="first page"]'
    );
    if (!isDisabled(firstBtn)) {
      firstBtn.click();
      await sleep(1200);
      return;
    }
    // Otherwise, click "previous page" repeatedly until it's disabled (i.e. we're on page 1).
    let guard = 0;
    while (!isDisabled(prevPageButton()) && guard < 30) {
      prevPageButton().click();
      await sleep(900);
      guard++;
    }
  }

  console.log('Resetting to page 1 (in case the page auto-advanced already)...');
  await resetToFirstPage();

  // ---- scrape every page of the live table ----

  const rawRows = [];
  let expectedTotal = null;
  let skippedPageWarning = false;

  while (true) {
    const infoBefore = parsePaginationInfo(getPaginationInfoText());
    if (infoBefore && expectedTotal === null) expectedTotal = infoBefore.total;

    document.querySelectorAll('tbody.MuiTableBody-root tr').forEach(tr => {
      const cells = tr.querySelectorAll('th,td');
      rawRows.push({
        time: cells[0] && cells[0].innerText.trim() || '',
        event: cells[1] && cells[1].innerText.trim() || '',
        building: cells[2] && cells[2].innerText.trim() || '',
        room: cells[3] && cells[3].innerText.trim() || '',
        status: cells[4] && cells[4].innerText.trim() || '',
      });
    });

    if (isDisabled(nextPageButton())) break;
    nextPageButton().click();
    await sleep(1200);

    // Sanity check: after our click the visible range should have advanced by roughly
    // one page's worth of rows, not more — a bigger jump means the site's own auto-scroll
    // fired in between and we likely missed a page.
    const infoAfter = parsePaginationInfo(getPaginationInfoText());
    if (infoBefore && infoAfter) {
      const pageSize = infoBefore.to - infoBefore.from + 1;
      if (infoAfter.from > infoBefore.to + pageSize) skippedPageWarning = true;
    }
  }

  // ---- dedupe + report coverage ----

  const uniqueRaw = Array.from(new Set(rawRows.map(r => JSON.stringify(r)))).map(s => JSON.parse(s));

  if (skippedPageWarning) {
    console.warn(
      'Warning: the page seemed to auto-advance faster than this script during scraping — ' +
      'some rows may be missing. Re-run if the total below looks low.'
    );
  }
  if (expectedTotal !== null) {
    console.log(`Site reports ${expectedTotal} total rows; scraped ${uniqueRaw.length} unique rows.`);
    if (uniqueRaw.length < expectedTotal) {
      console.warn('Fewer unique rows than the site reports — some pages may have been missed. Re-running is recommended.');
    }
  }

  // ---- parse into the shape the viewer expects ----

  function toMinutes(t) {
    if (!t) return null;
    const m = String(t).match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
    if (!m) return null;
    let h = parseInt(m[1], 10), min = parseInt(m[2], 10);
    const ap = m[3].toUpperCase();
    if (ap === 'PM' && h !== 12) h += 12;
    if (ap === 'AM' && h === 12) h = 0;
    return h * 60 + min;
  }

  function parseTimeRange(timeStr) {
    const clean = (timeStr || '').replace(/\u00a0/g, ' ').trim();
    const parts = clean.split(/\s*-\s*/);
    if (parts.length !== 2) return { start: null, end: null, start_min: null, end_min: null };
    const start = parts[0].trim(), end = parts[1].trim();
    return { start, end, start_min: toMinutes(start), end_min: toMinutes(end) };
  }

  function parseBlock(building, room) {
    let m = (building || '').match(/Block\s+([A-Za-z])/i);
    if (m) return m[1].toUpperCase();
    m = (room || '').match(/\.([A-Za-z])\./);
    if (m) return m[1].toUpperCase();
    return null;
  }

  function parseFloor(room) {
    let m = (room || '').match(/\.(\d+)\./);
    if (m) return parseInt(m[1], 10);
    m = (room || '').match(/\.(\d+)$/);
    if (m) return parseInt(m[1], 10);
    return null;
  }

  const rows = uniqueRaw.map(r => {
    const { start, end, start_min, end_min } = parseTimeRange(r.time);
    return {
      start, end, start_min, end_min,
      block: parseBlock(r.building, r.room),
      floor: parseFloor(r.room),
      room: r.room,
      event: r.event,
      status: r.status,
    };
  });

  const payload = {
    version: 1,
    source: location.href,
    scraped_at: new Date().toISOString(),
    site_total: expectedTotal,
    incomplete: skippedPageWarning || (expectedTotal !== null && uniqueRaw.length < expectedTotal),
    rows,
  };

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
      console.log(`Done — ${rows.length} events handed to the viewer tab.`);
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

    console.log(`Done — ${rows.length} events. Open the viewer and drop in sim-timetable.json.`);
  }

  // Also leave it on window so you can poke at it in the console.
  window.simTimetable = payload;
  return payload;
})();
