/* SIM Campus Timetable — shared parsing + rendering.
 *
 * Used by viewer.html, and inlined verbatim into the standalone HTML export.
 * Deliberately dependency-free and ES5-ish so the exported file opens anywhere.
 */
(function (global) {
  'use strict';

  // ---------- parsing ----------

  function toMinutes(t) {
    if (!t) return null;
    var m = String(t).match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
    if (!m) return null;
    var h = parseInt(m[1], 10), min = parseInt(m[2], 10);
    var ap = m[3].toUpperCase();
    if (ap === 'PM' && h !== 12) h += 12;
    if (ap === 'AM' && h === 12) h = 0;
    return h * 60 + min;
  }

  function parseTimeRange(timeStr) {
    var clean = (timeStr || '').replace(/\u00a0/g, ' ').trim();
    var parts = clean.split(/\s*-\s*/);
    if (parts.length !== 2) return { start: null, end: null, start_min: null, end_min: null };
    var start = parts[0].trim(), end = parts[1].trim();
    return { start: start, end: end, start_min: toMinutes(start), end_min: toMinutes(end) };
  }

  function parseBlock(building, room) {
    var m = (building || '').match(/Block\s+([A-Za-z])/i);
    if (m) return m[1].toUpperCase();
    m = (room || '').match(/\.([A-Za-z])\./);
    if (m) return m[1].toUpperCase();
    return null;
  }

  function parseFloor(room) {
    var m = (room || '').match(/\.(\d+)\./);
    if (m) return parseInt(m[1], 10);
    m = (room || '').match(/\.(\d+)$/);
    if (m) return parseInt(m[1], 10);
    return null;
  }

  /* Accepts either raw scraped rows ({time, event, building, room, status})
   * or rows that already carry start/end/block/floor, and returns the parsed shape. */
  function normalize(rows) {
    return (rows || []).map(function (r) {
      if (r && typeof r.start_min !== 'undefined' && typeof r.block !== 'undefined') return r;
      var t = parseTimeRange(r.time);
      return {
        start: t.start, end: t.end, start_min: t.start_min, end_min: t.end_min,
        block: parseBlock(r.building, r.room),
        floor: parseFloor(r.room),
        room: r.room || '',
        event: r.event || '',
        status: r.status || ''
      };
    });
  }

  /* Pulls a course code and section out of a booking title.
   *
   *   "MTH131 - L01 : Mathematical Anly for Mgt - UB"
   *     -> { code: "MTH131", section: "L01", title: "Mathematical Anly for Mgt - UB" }
   *
   * Split on the FIRST " : ", then take the section from the LAST " - " on the
   * left. Doing it that way survives codes that themselves contain a hyphen
   * ("SMM- - L01 : ...") and titles that contain one ("... - RMIT"), both of
   * which a single regex gets wrong.
   *
   * Returns null for everything that is not a taught class — Free Access, club
   * bookings, briefings, rehearsals. About 25% of a day's rows, and they must
   * not be invented into classes. */
  function parseClass(event) {
    var s = String(event || '').trim();
    if (!s) return null;

    var colon = s.indexOf(' : ');
    if (colon === -1) return null;

    var left = s.slice(0, colon).trim();
    var title = s.slice(colon + 3).trim();

    var dash = left.lastIndexOf(' - ');
    if (dash === -1) return null;

    var code = left.slice(0, dash).trim();
    var section = left.slice(dash + 3).trim();
    if (!code || !section) return null;

    return { code: code, section: section, title: title };
  }

  // ---------- helpers ----------

  function esc(s) {
    return String(s === null || typeof s === 'undefined' ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function uniqueSorted(values, cmp) {
    var seen = {}, out = [];
    values.forEach(function (v) {
      var k = String(v);
      if (!seen[k]) { seen[k] = 1; out.push(v); }
    });
    return cmp ? out.sort(cmp) : out.sort();
  }

  /* SIM marks rooms students may actually use with an explicit booking named
   * "Free Access" (or "SST Free Access"). This is the ONLY positive signal that
   * a room is open — an unbooked room is not known to be open, it is just not
   * booked, and is very often locked. */
  function isFreeAccess(b) {
    return /free access/i.test((b.event || '').trim());
  }

  /* The feed is fetched once a day, so a status stored at 00:05 would read
   * UPCOMING for everything forever. What a reader wants at 2pm is whether the
   * room is busy *now*, so derive it from the clock whenever we have times. */
  function liveStatus(r) {
    if (r.start_min === null || typeof r.start_min === 'undefined' ||
        r.end_min === null || typeof r.end_min === 'undefined') {
      return r.status || '';
    }
    var now = new Date();
    var nowMin = now.getHours() * 60 + now.getMinutes();
    if (r.end_min <= nowMin) return 'PAST';
    if (r.start_min <= nowMin) return 'CURRENT';
    return 'UPCOMING';
  }

  /* Turns one room's bookings into a timeline of three kinds of segment:
   *   open  - an explicit "Free Access" booking; students may use the room
   *   busy  - any other booking
   *   gap   - nothing booked. NOT the same as open: an unbooked room is simply
   *           unallocated and is very often locked, so it is never presented as
   *           somewhere to go. */
  function buildTimeline(bookings) {
    bookings = bookings.slice().sort(function (a, b) { return a.start_min - b.start_min; });
    var timeline = [];
    bookings.forEach(function (b, i) {
      var free = isFreeAccess(b);
      timeline.push({
        type: free ? 'open' : 'busy',
        start_min: b.start_min, end_min: b.end_min,
        start: b.start, end: b.end,
        event: b.event,
        open_ended: false
      });
      var nxt = bookings[i + 1];
      if (nxt) {
        if (nxt.start_min > b.end_min) {
          // Unbooked, which is NOT the same as open to students.
          timeline.push({
            type: 'gap', start_min: b.end_min, end_min: nxt.start_min,
            start: b.end, end: nxt.start, open_ended: false, event: ''
          });
        }
      } else {
        timeline.push({
          type: 'gap', start_min: b.end_min, end_min: null,
          start: b.end, end: null, open_ended: true, event: ''
        });
      }
    });
    return timeline;
  }

  // ---------- UI ----------

  /* Every control is labelled with an explicit for/id pair rather than a
   * wrapping <label>. A label that wraps a <select> pulls the option text into
   * the accessible name, so "Block" was being announced as "Block All A B C D".
   * The two time filters carry visible hints rather than title= tooltips,
   * which keyboard and touch users never see. */
  var TOOLBAR_HTML = [
    '<details class="filters" data-el="filterShell">',
    '<summary class="filters-summary">Filters</summary>',
    '<div class="toolbar" role="group" aria-label="Filter the schedule">',
    '  <p class="field"><label for="stt-block">Block</label>',
    '    <select id="stt-block" data-f="block"><option value="">All</option></select></p>',
    '  <p class="field"><label for="stt-floor">Floor</label>',
    '    <select id="stt-floor" data-f="floor"><option value="">All</option></select></p>',
    '  <p class="field"><label for="stt-room">Room contains</label>',
    '    <input id="stt-room" data-f="room" type="text" placeholder="e.g. LT.B.5" /></p>',
    '  <p class="field"><label for="stt-exclude">Exclude contains</label>',
    '    <input id="stt-exclude" data-f="exclude" type="text" placeholder="e.g. LAB, MPSH" /></p>',
    '  <p class="field"><label for="stt-endtime">Ends at</label>',
    '    <select id="stt-endtime" data-f="endtime"><option value="">Any</option></select></p>',
    '  <div class="time-filters" data-el="timeFilters">',
    '    <p class="field"><label for="stt-after">Open after</label>',
    '      <input id="stt-after" data-f="after" type="text" placeholder="e.g. 4:00 PM"',
    '        aria-describedby="stt-after-hint" />',
    '      <span class="field-hint" id="stt-after-hint">Opens at or after this time</span></p>',
    '    <p class="field"><label for="stt-before">Open before</label>',
    '      <input id="stt-before" data-f="before" type="text" placeholder="e.g. 10:00 PM"',
    '        aria-describedby="stt-before-hint" />',
    '      <span class="field-hint" id="stt-before-hint">Opens before this time</span></p>',
    '  </div>',
    '  <div class="spacer"></div>',
    '  <button class="btn" data-el="resetBtn" type="button">Reset filters</button>',
    '  <div class="seg-toggle" role="group" aria-label="View">',
    '    <button data-el="tableBtn" type="button" aria-pressed="false">Table</button>',
    '    <button data-el="availBtn" type="button" aria-pressed="true">Availability</button>',
    '  </div>',
    '</div>',
    '</details>',
    '<div class="results-head"><p class="count" data-el="meta"></p></div>',
    // Announced on a debounce so typing in a filter does not spam a screen
    // reader with a result count on every keystroke.
    '<p class="visually-hidden" data-el="announce" role="status" aria-live="polite"></p>',
    '<div data-el="results"></div>'
  ].join('\n');

  function nowMinutes() {
    var d = new Date();
    return d.getHours() * 60 + d.getMinutes();
  }

  /* The standalone export is opened from file://, where "/room?code=..." would
   * 404. So the detail links exist only when we are actually being served —
   * the export renders the same text, just not linked. */
  var CAN_LINK = typeof location !== 'undefined' &&
    (location.protocol === 'http:' || location.protocol === 'https:');

  function roomLink(room) {
    var label = esc(room || '?');
    if (!CAN_LINK || !room) return label;
    return '<a href="/room?code=' + encodeURIComponent(room) + '">' + label + '</a>';
  }

  function eventLink(event) {
    var label = esc(event);
    if (!CAN_LINK) return label;
    var c = parseClass(event);
    if (!c) return label;
    return '<a href="/class?code=' + encodeURIComponent(c.code) + '">' + label + '</a>';
  }

  function fmtMinutes(m) {
    var h = Math.floor(m / 60), mm = m % 60;
    var ap = h >= 12 ? 'PM' : 'AM';
    var h12 = h % 12; if (h12 === 0) h12 = 12;
    return h12 + (mm ? ':' + (mm < 10 ? '0' + mm : mm) : '') + ' ' + ap;
  }

  /* The window the day bar spans: the real extent of the day's bookings,
   * rounded out to whole hours, never narrower than a normal teaching day. */
  function dayRange(rows) {
    var lo = 8 * 60, hi = 22 * 60;
    rows.forEach(function (r) {
      if (typeof r.start_min === 'number') lo = Math.min(lo, r.start_min);
      if (typeof r.end_min === 'number') hi = Math.max(hi, r.end_min);
    });
    lo = Math.floor(lo / 60) * 60;
    hi = Math.ceil(hi / 60) * 60;
    if (hi - lo < 120) hi = lo + 120;
    return { lo: lo, hi: hi };
  }

  /* A proportional strip of the day. Decorative by design: it is aria-hidden,
   * and everything it draws is also written out underneath, because a coloured
   * bar cannot be read aloud and colour must never be the only carrier. */
  function dayBarHtml(timeline, range) {
    var span = range.hi - range.lo || 1;
    var pct = function (m) { return ((m - range.lo) / span) * 100; };

    var segs = timeline.map(function (sg) {
      if (sg.type === 'gap') return '';
      var from = Math.max(range.lo, sg.start_min);
      var to = Math.min(range.hi, sg.end_min === null ? range.hi : sg.end_min);
      if (!(to > from)) return '';
      return '<span class="daybar-seg is-' + sg.type + '" style="left:' +
        pct(from).toFixed(2) + '%;width:' + (pct(to) - pct(from)).toFixed(2) + '%"></span>';
    }).join('');

    var now = nowMinutes();
    var marker = (now > range.lo && now < range.hi)
      ? '<span class="daybar-now" style="left:' + pct(now).toFixed(2) + '%"></span>'
      : '';

    var mid = range.lo + Math.round((span / 2) / 60) * 60;
    return '<div class="daybar" aria-hidden="true">' + segs + marker + '</div>' +
      '<div class="daybar-scale" aria-hidden="true"><span>' + fmtMinutes(range.lo) +
      '</span><span>' + fmtMinutes(mid) + '</span><span>' + fmtMinutes(range.hi) + '</span></div>';
  }

  function mount(root, rows, opts) {
    opts = opts || {};
    var data = normalize(rows);
    /* Full room inventory, when the source provides one. Used to report how
     * many rooms are simply unbooked, and to populate the block/floor filters.
     * Unbooked rooms are deliberately NOT offered as available - see
     * buildTimeline on why a gap is not an invitation. */
    var inventory = opts.rooms || [];
    root.innerHTML = TOOLBAR_HTML;

    var f = {};
    root.querySelectorAll('[data-f]').forEach(function (node) {
      f[node.getAttribute('data-f')] = node;
    });
    var el = {};
    root.querySelectorAll('[data-el]').forEach(function (node) {
      el[node.getAttribute('data-el')] = node;
    });

    // Dropdowns come from bookings *and* inventory, so a block or floor whose
    // rooms are all free today still appears as a choice.
    var placeSource = data.concat(inventory);

    uniqueSorted(placeSource.map(function (d) { return d.block; }).filter(Boolean))
      .forEach(function (b) { f.block.add(new Option(b, b)); });

    uniqueSorted(
      placeSource.map(function (d) { return d.floor; })
        .filter(function (x) { return x !== null && typeof x !== 'undefined'; }),
      function (a, b) { return a - b; }
    ).forEach(function (fl) { f.floor.add(new Option('Floor ' + fl, String(fl))); });

    uniqueSorted(
      data.map(function (d) { return d.end; }).filter(Boolean),
      function (a, b) { return (toMinutes(a) || 0) - (toMinutes(b) || 0); }
    ).forEach(function (t) { f.endtime.add(new Option(t, t)); });

    var initial = opts.initial || {};
    Object.keys(f).forEach(function (k) {
      if (initial[k] !== null && typeof initial[k] !== 'undefined' && initial[k] !== '') {
        f[k].value = String(initial[k]);
      }
    });

    /* One scale for every bar on the page. Per-room ranges would make two bars
     * of different lengths mean the same thing, which is worse than no bar. */
    var range = dayRange(data);

    /* Above 620px the filter panel is always open and its summary is hidden by
     * CSS, so nothing is hidden behind a click on a desktop. Below that it
     * starts closed, so the results are the first thing on screen. */
    var wide = window.matchMedia('(min-width: 621px)');
    function syncFilterShell() {
      // Collapse only when we positively know the viewport is narrow. A zero or
      // unknown width (hidden tab, print, an embedding context) should show the
      // filters rather than hide them behind a control nobody asked for.
      var narrow = window.innerWidth > 0 && !wide.matches;
      el.filterShell.open = !narrow;
    }
    syncFilterShell();
    if (wide.addEventListener) wide.addEventListener('change', syncFilterShell);
    else if (wide.addListener) wide.addListener(syncFilterShell);   // older Safari

    /* Visible count updates immediately; the screen-reader announcement waits
     * for typing to stop, so filtering does not narrate every keystroke. */
    var announceTimer = null;
    function setCount(text) {
      el.meta.textContent = text;
      if (announceTimer) clearTimeout(announceTimer);
      announceTimer = setTimeout(function () {
        el.announce.textContent = text;
      }, 600);
    }

    var mode = opts.mode === 'table' ? 'table' : 'available';

    function setMode(m) {
      mode = m;
      // aria-pressed, not a class: the active view has to be announced, not
      // just coloured in.
      el.tableBtn.setAttribute('aria-pressed', String(m === 'table'));
      el.availBtn.setAttribute('aria-pressed', String(m === 'available'));
      el.timeFilters.classList.toggle('show', m === 'available');
      render();
    }

    el.tableBtn.addEventListener('click', function () { setMode('table'); });
    el.availBtn.addEventListener('click', function () { setMode('available'); });

    el.resetBtn.addEventListener('click', function () {
      Object.keys(f).forEach(function (k) { f[k].value = ''; });
      render();
    });

    root.querySelectorAll('.toolbar input, .toolbar select').forEach(function (input) {
      input.addEventListener('input', render);
      input.addEventListener('change', render);
    });

    /* Filters that describe a *place* rather than a booking. Shared so that a
     * room with no bookings is filtered exactly like one with them. */
    function matchesPlace(d) {
      var block = f.block.value;
      var floor = f.floor.value;
      var room = f.room.value.trim().toUpperCase();
      var excludeRaw = f.exclude.value.trim().toUpperCase();
      var excludeTerms = excludeRaw
        ? excludeRaw.split(',').map(function (s) { return s.trim(); }).filter(Boolean)
        : [];

      if (block && d.block !== block) return false;
      if (floor && String(d.floor) !== floor) return false;
      if (room && (d.room || '').toUpperCase().indexOf(room) === -1) return false;
      if (excludeTerms.length && excludeTerms.some(function (t) {
        return (d.room || '').toUpperCase().indexOf(t) !== -1;
      })) return false;
      return true;
    }

    function getFiltered() {
      var endtime = f.endtime.value;
      return data.filter(function (d) {
        if (!matchesPlace(d)) return false;
        if (endtime && d.end !== endtime) return false;
        return true;
      });
    }

    /* Rooms the inventory says have no bookings at all today. Reported as a
     * count only: nothing marks them open, and most are labs, tutor rooms and
     * foyers. Excluded when an "ends at" filter is set, since a room with no
     * bookings has no end time to match. */
    function freeAllDayRooms() {
      if (f.endtime.value) return [];
      return inventory.filter(function (r) {
        return r.activities === 0 && matchesPlace(r);
      });
    }

    function renderTable(rows) {
      rows = rows.slice().sort(function (a, b) { return (a.end_min || 0) - (b.end_min || 0); });
      setCount(rows.length + (rows.length === 1 ? ' booking' : ' bookings'));
      var body = rows.map(function (r) {
        var floorText = (r.floor === null || typeof r.floor === 'undefined') ? '?' : r.floor;
        var st = liveStatus(r);
        return '<tr>' +
          '<td class="num">' + esc(r.start || '?') + '</td>' +
          '<td class="num">' + esc(r.end || '?') + '</td>' +
          '<td>' + esc(r.block || '?') + '</td>' +
          '<td>' + esc(floorText) + '</td>' +
          '<th scope="row">' + roomLink(r.room) + '</th>' +
          '<td>' + eventLink(r.event) + '</td>' +
          '<td class="status-' + esc(st) + '">' + esc(st) + '</td>' +
          '</tr>';
      }).join('');
      // The scroll container is focusable and labelled, so a keyboard user can
      // actually reach and scroll a table that is wider than the screen.
      el.results.innerHTML =
        '<div class="table-scroll" tabindex="0" role="region" aria-label="All bookings, scrollable">' +
        '<table>' +
        '<caption class="visually-hidden">Every booking matching the current filters, ' +
        'earliest finishing first.</caption>' +
        '<thead><tr>' +
        '<th scope="col">Start</th><th scope="col">End</th><th scope="col">Block</th>' +
        '<th scope="col">Floor</th><th scope="col">Room</th><th scope="col">Event</th>' +
        '<th scope="col">Status</th></tr></thead>' +
        '<tbody>' + (body || '<tr><td colspan="7">No bookings match these filters.</td></tr>') +
        '</tbody></table></div>';
    }

    function renderAvailability(rows) {
      var afterMin = toMinutes(f.after.value);
      var beforeMin = toMinutes(f.before.value);

      var groups = {};
      rows.forEach(function (r) {
        if (r.start_min === null || r.end_min === null) return;
        (groups[r.room] = groups[r.room] || []).push(r);
      });

      var cards = [];
      Object.keys(groups).sort().forEach(function (room) {
        var bookings = groups[room];
        var info = bookings[0];
        var timeline = buildTimeline(bookings);

        var hasMatchingFree = timeline.some(function (seg) {
          if (seg.type !== 'open') return false;
          if (afterMin !== null && seg.start_min < afterMin) return false;
          if (beforeMin !== null && seg.start_min >= beforeMin) return false;
          return true;
        });
        if ((afterMin !== null || beforeMin !== null) && !hasMatchingFree) return;

        var segHtml = timeline.map(function (seg) {
          if (seg.type === 'busy') {
            return '<li class="segment"><span class="tag busy">BUSY</span>' +
              '<span class="seg-time">' + esc(seg.start) + ' – ' + esc(seg.end) + '</span>' +
              '<span class="seg-label">' + eventLink(seg.event) + '</span></li>';
          }
          if (seg.type === 'open') {
            return '<li class="segment"><span class="tag free">OPEN</span>' +
              '<span class="seg-time">' + esc(seg.start) + ' – ' + esc(seg.end) + '</span>' +
              '<span class="seg-label">' + eventLink(seg.event) + '</span></li>';
          }
          var until = seg.open_ended ? 'end of day' : esc(seg.end);
          return '<li class="segment"><span class="tag gap">GAP</span>' +
            '<span class="seg-time">' + esc(seg.start) + ' → ' + until + '</span>' +
            '<span class="seg-label muted">nothing booked – may still be locked</span></li>';
        }).join('');

        var floorText = (info.floor === null || typeof info.floor === 'undefined') ? '?' : info.floor;
        var desc = info.room_description ? ' · ' + info.room_description : '';
        var openSegs = timeline.filter(function (sg) { return sg.type === 'open'; });
        var busyCount = timeline.filter(function (sg) { return sg.type === 'busy'; }).length;

        // The summary has to stand on its own: it is what a screen reader
        // announces, and what everyone reads before deciding to expand.
        var summary = openSegs.length
          ? 'Open ' + openSegs.map(function (sg) {
              return esc(sg.start) + ' – ' + esc(sg.end);
            }).join(', ') + ' · ' + busyCount + ' other booking' + (busyCount === 1 ? '' : 's')
          : busyCount + ' booking' + (busyCount === 1 ? '' : 's') + ' · no Free Access window';

        // Only the positive case gets a badge. 131 of 155 cards would otherwise
        // carry a "not marked open" pill, which is noise that buries the 24
        // that matter — and the summary line already says it in words.
        var flag = openSegs.length ? '<span class="room-flag">OPEN TODAY</span>' : '';

        cards.push(
          '<li class="room-card">' +
          '<div class="room-head">' +
          '<h3 class="room-name">' + roomLink(room) + '</h3>' +
          '<span class="room-sub">Block ' + esc(info.block || '?') +
          ' · Floor ' + esc(floorText) + esc(desc) + '</span>' +
          flag +
          '</div>' +
          dayBarHtml(timeline, range) +
          '<details class="seg-details"><summary>' + summary + '</summary>' +
          '<ul class="segments">' + segHtml + '</ul></details>' +
          '</li>'
        );
      });

      // Lead with the rooms SIM has explicitly opened to students today. An
      // unbooked room is NOT an open room — most of the ones with nothing
      // booked are labs, tutor rooms and foyers that are simply locked — so
      // they are reported as a count, not offered as somewhere to go.
      var openRooms = [];
      Object.keys(groups).sort().forEach(function (room) {
        var windows = buildTimeline(groups[room]).filter(function (sg) { return sg.type === 'open'; });
        if (!windows.length) return;
        if (afterMin !== null || beforeMin !== null) {
          var ok = windows.some(function (sg) {
            if (afterMin !== null && sg.start_min < afterMin) return false;
            if (beforeMin !== null && sg.start_min >= beforeMin) return false;
            return true;
          });
          if (!ok) return;
        }
        openRooms.push({ room: room, info: groups[room][0], windows: windows });
      });

      // Rooms open right now sort to the front — at 3pm the useful question is
      // "where can I go now", not "what opens at 8am".
      var now = nowMinutes();
      openRooms.forEach(function (o) {
        o.openNow = o.windows.some(function (sg) {
          return sg.start_min <= now && now < sg.end_min;
        });
      });
      openRooms.sort(function (a, b) {
        if (a.openNow !== b.openNow) return a.openNow ? -1 : 1;
        return a.room < b.room ? -1 : a.room > b.room ? 1 : 0;
      });

      var openNowCount = openRooms.filter(function (o) { return o.openNow; }).length;

      var openHtml = '';
      if (openRooms.length) {
        openHtml =
          '<section class="hero" aria-labelledby="stt-open-h">' +
          '<div class="hero-head"><h2 id="stt-open-h">Open to students</h2></div>' +
          '<p class="hero-sub">' + openRooms.length + ' room' +
          (openRooms.length === 1 ? '' : 's') + ' with a Free Access window today' +
          (openNowCount ? ' · <strong>' + openNowCount + ' open right now</strong>' : '') +
          '</p>' +
          '<ul class="open-grid">' +
          openRooms.map(function (o) {
            var times = o.windows.map(function (sg) {
              return esc(sg.start) + ' – ' + esc(sg.end);
            }).join(', ');
            return '<li class="open-item' + (o.openNow ? ' is-now' : '') + '">' +
              '<p class="open-room">' + roomLink(o.room) +
              (o.openNow ? '<span class="now-badge">OPEN NOW</span>' : '') + '</p>' +
              '<p class="open-when">' + times + '</p>' +
              (o.info.room_description
                ? '<p class="open-desc">' + esc(o.info.room_description) + '</p>' : '') +
              '</li>';
          }).join('') +
          '</ul></section>';
      }

      var unbooked = freeAllDayRooms();
      var unbookedNote = unbooked.length
        ? '<p class="footnote"><strong>' + unbooked.length + ' more rooms</strong> have nothing ' +
          'booked today, but nothing marks them as open — mostly labs, tutor rooms and foyers, ' +
          'which are usually locked. They are not listed as available.</p>'
        : '';

      var cardsHtml = cards.length
        ? '<h2 class="visually-hidden">Rooms with bookings</h2>' +
          '<ul class="room-list">' + cards.join('') + '</ul>'
        : '';

      setCount(
        openRooms.length + ' open to students · ' +
        cards.length + ' with bookings' +
        (unbooked.length ? ' · ' + unbooked.length + ' unbooked (status unknown)' : '')
      );

      el.results.innerHTML = (openHtml + cardsHtml + unbookedNote) ||
        '<p class="empty">No rooms match these filters. Try clearing one of them.</p>';
    }

    function render() {
      var filtered = getFiltered();
      if (mode === 'table') renderTable(filtered);
      else renderAvailability(filtered);
    }

    setMode(mode);

    return {
      render: render,
      getData: function () { return data; },
      getState: function () {
        var s = {};
        Object.keys(f).forEach(function (k) { s[k] = f[k].value; });
        return s;
      },
      getMode: function () { return mode; }
    };
  }

  global.SIMTimetable = {
    toMinutes: toMinutes,
    parseTimeRange: parseTimeRange,
    parseBlock: parseBlock,
    parseFloor: parseFloor,
    parseClass: parseClass,
    normalize: normalize,
    buildTimeline: buildTimeline,
    isFreeAccess: isFreeAccess,
    liveStatus: liveStatus,
    fmtMinutes: fmtMinutes,
    dayRange: dayRange,
    dayBarHtml: dayBarHtml,
    escapeHtml: esc,
    mount: mount
  };
})(typeof window !== 'undefined' ? window : this);
