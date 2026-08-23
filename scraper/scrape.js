// ============================================================================
// SIM Campus Timetable — scraper
//
// Run this on the SIM scheduling page (it needs your logged-in session, which
// is why it runs in your browser rather than on a server).
//
//   1. Open the scheduling page and log in.
//   2. Open DevTools -> Console (F12).
//   3. Paste this whole file, press Enter.
//   4. It scrapes every page, then downloads sim-timetable.json AND copies the
//      same JSON to your clipboard.
//   5. Open the viewer, paste or drop the JSON in.
//
// It does not send anything anywhere — everything stays in your browser.
// ============================================================================

(async function scrapeSIMTimetable() {
  const sleep = ms => new Promise(res => setTimeout(res, ms));

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

  const json = JSON.stringify(payload, null, 2);

  // ---- hand it over: download + clipboard ----

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

  // Also leave it on window so you can poke at it in the console.
  window.simTimetable = payload;
  return payload;
})();
