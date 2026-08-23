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

  var TOOLBAR_HTML = [
    '<div class="toolbar">',
    '  <label>Block<select data-f="block"><option value="">All</option></select></label>',
    '  <label>Floor<select data-f="floor"><option value="">All</option></select></label>',
    '  <label>Room contains<input data-f="room" type="text" placeholder="e.g. LT.B.5" /></label>',
    '  <label>Exclude contains<input data-f="exclude" type="text" placeholder="e.g. LAB, MPSH" /></label>',
    '  <label>Ends at<select data-f="endtime"><option value="">Any</option></select></label>',
    '  <div class="time-filters" data-el="timeFilters">',
    '    <label title="Finds rooms whose Free Access window starts at or after this time">Open after<input data-f="after" type="text" placeholder="e.g. 4:00 PM" /></label>',
    '    <label title="Finds rooms whose Free Access window starts before this time">Open before<input data-f="before" type="text" placeholder="e.g. 10:00 PM" /></label>',
    '  </div>',
    '  <div class="spacer"></div>',
    '  <button class="btn" data-el="resetBtn" type="button">Reset filters</button>',
    '  <div class="mode-toggle">',
    '    <button data-el="tableBtn" type="button">Table</button>',
    '    <button data-el="availBtn" type="button">Availability</button>',
    '  </div>',
    '</div>',
    '<div class="meta" data-el="meta"></div>',
    '<div data-el="results"></div>'
  ].join('\n');

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

    var mode = opts.mode === 'table' ? 'table' : 'available';

    function setMode(m) {
      mode = m;
      el.tableBtn.classList.toggle('active', m === 'table');
      el.availBtn.classList.toggle('active', m === 'available');
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
      el.meta.textContent = rows.length + ' event(s)';
      var body = rows.map(function (r) {
        var floorText = (r.floor === null || typeof r.floor === 'undefined') ? '?' : r.floor;
        return '<tr>' +
          '<td>' + esc(r.start || '?') + '</td>' +
          '<td>' + esc(r.end || '?') + '</td>' +
          '<td>' + esc(r.block || '?') + '</td>' +
          '<td>' + esc(floorText) + '</td>' +
          '<td>' + esc(r.room || '?') + '</td>' +
          '<td>' + esc(r.event) + '</td>' +
          '<td class="status-' + esc(liveStatus(r)) + '">' + esc(liveStatus(r)) + '</td>' +
          '</tr>';
      }).join('');
      el.results.innerHTML =
        '<div class="table-scroll"><table>' +
        '<thead><tr><th>Start</th><th>End</th><th>Block</th><th>Floor</th>' +
        '<th>Room</th><th>Event</th><th>Status</th></tr></thead>' +
        '<tbody>' + (body || '<tr><td colspan="7">No matching events found.</td></tr>') + '</tbody>' +
        '</table></div>';
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
            return '<div class="segment"><span class="tag busy">BUSY</span>' +
              '<span class="seg-time">' + esc(seg.start) + ' - ' + esc(seg.end) + '</span>' +
              '<span class="seg-label">' + esc(seg.event) + '</span></div>';
          }
          if (seg.type === 'open') {
            return '<div class="segment"><span class="tag free">OPEN</span>' +
              '<span class="seg-time">' + esc(seg.start) + ' - ' + esc(seg.end) + '</span>' +
              '<span class="seg-label">' + esc(seg.event) + '</span></div>';
          }
          var until = seg.open_ended ? 'end of day' : esc(seg.end);
          return '<div class="segment"><span class="tag gap">GAP</span>' +
            '<span class="seg-time">' + esc(seg.start) + ' &rarr; ' + until + '</span>' +
            '<span class="seg-label muted">nothing booked - may still be locked</span></div>';
        }).join('');

        var floorText = (info.floor === null || typeof info.floor === 'undefined') ? '?' : info.floor;
        var desc = info.room_description ? ', ' + info.room_description : '';
        cards.push(
          '<div class="room-card"><div class="room-title">' + esc(room) +
          ' <span class="room-sub">Block ' + esc(info.block || '?') +
          ', Floor ' + esc(floorText) + esc(desc) + '</span></div>' + segHtml + '</div>'
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

      var openHtml = '';
      if (openRooms.length) {
        openHtml =
          '<div class="room-card summary-card"><div class="room-title">Open to students ' +
          '<span class="room-sub">' + openRooms.length +
          ' room(s) with a Free Access window today</span></div>' +
          openRooms.map(function (o) {
            var times = o.windows.map(function (sg) {
              return esc(sg.start) + ' - ' + esc(sg.end);
            }).join(', ');
            return '<div class="segment"><span class="tag free">OPEN</span>' +
              '<span class="seg-time">' + esc(o.room) + '</span>' +
              '<span class="seg-label">' + times +
              (o.info.room_description ? ' &middot; ' + esc(o.info.room_description) : '') +
              '</span></div>';
          }).join('') +
          '</div>';
      }

      var unbooked = freeAllDayRooms();
      var unbookedNote = unbooked.length
        ? '<p class="empty">' + unbooked.length + ' more room(s) have nothing booked today, but ' +
          'nothing marks them as open - mostly labs, tutor rooms and foyers, which are usually ' +
          'locked. They are not listed as available.</p>'
        : '';

      el.meta.textContent =
        openRooms.length + ' room(s) open to students · ' +
        cards.length + ' with bookings' +
        (unbooked.length ? ' · ' + unbooked.length + ' unbooked (status unknown)' : '');

      el.results.innerHTML = (openHtml + cards.join('') + unbookedNote) ||
        '<p class="empty">No matching rooms found.</p>';
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
    normalize: normalize,
    buildTimeline: buildTimeline,
    escapeHtml: esc,
    mount: mount
  };
})(typeof window !== 'undefined' ? window : this);
