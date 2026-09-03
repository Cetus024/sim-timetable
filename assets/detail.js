/* Detail pages: one classroom, or one class, for the whole of today.
 *
 * room.html  -> SIMDetail.init('room')   /room?code=LT.A.1.08
 * class.html -> SIMDetail.init('class')  /class?code=MTH131
 *
 * Both modes are the same shape — pick a subject, show its day as a bar, list
 * its free gaps, then list its sessions — so they share one implementation
 * rather than two that drift.
 *
 * Rendering rules inherited from the viewer, and not to be relaxed here:
 *   - "Free Access" is the ONLY positive signal a room is open to students.
 *     An unbooked gap is unallocated, usually locked, and is never presented
 *     as somewhere to go.
 *   - the day bar is decorative (aria-hidden); everything it draws is also
 *     written out in words underneath.
 */
(function (global) {
  'use strict';

  var T = global.SIMTimetable;
  var esc = T.escapeHtml;

  function qs(name) {
    return new URLSearchParams(location.search).get(name) || '';
  }

  function nowMin() {
    var d = new Date();
    return d.getHours() * 60 + d.getMinutes();
  }

  function el(id) { return document.getElementById(id); }

  // ---------- shared pieces ----------

  function freshnessLine(p) {
    var bits = [];
    if (p.schedule_dates && p.schedule_dates.length) bits.push(p.schedule_dates.join(', '));
    if (p.scraped_at) {
      var d = new Date(p.scraped_at);
      if (!isNaN(d)) {
        bits.push('updated ' + d.toLocaleString());
        if (d.toDateString() !== new Date().toDateString()) {
          bits.push('<span class="warn">⚠ this is a previous day’s schedule</span>');
        }
      }
    }
    return bits.join(' · ');
  }

  /* buildTimeline starts at the first booking, so the morning before it is
   * missing — and "free until my 12 o'clock" is exactly what a reader wants.
   * Added here rather than in buildTimeline so the viewer's room cards keep the
   * shape they were verified with.
   *
   * Labelled "before <first>" rather than given a start time: the day range
   * begins at 8am by convention, and the schedule does not actually assert
   * anything about the hours before its first booking. */
  function withLeadingGap(timeline) {
    if (!timeline.length) return timeline;
    var first = timeline[0];
    if (first.start_min === null || typeof first.start_min === 'undefined') return timeline;
    return [{
      type: 'gap',
      start_min: null, end_min: first.start_min,
      start: null, end: first.start,
      leading: true, open_ended: false, event: ''
    }].concat(timeline);
  }

  /* Turns a room's timeline into the two lists a reader actually wants:
   * when they can get in, and when the room merely has nothing booked. */
  function gapsHtml(timeline, mode) {
    var open = timeline.filter(function (s) { return s.type === 'open'; });
    var gaps = timeline.filter(function (s) { return s.type === 'gap'; });
    var now = nowMin();
    var out = '';

    if (mode === 'room') {
      out += '<h2>When you can get in</h2>';
      if (open.length) {
        out += '<ul class="segments">' + open.map(function (s) {
          var live = s.start_min <= now && now < s.end_min;
          return '<li class="segment"><span class="tag free">OPEN</span>' +
            '<span class="seg-time">' + esc(s.start) + ' – ' + esc(s.end) + '</span>' +
            '<span class="seg-label">' + esc(s.event || 'Free Access') +
            (live ? '<span class="now-badge">NOW</span>' : '') + '</span></li>';
        }).join('') + '</ul>';
      } else {
        out += '<p class="empty">SIM has not marked this room as Free Access today, so there is ' +
          'no time it is known to be open to students.</p>';
      }
    }

    out += '<h2>' + (mode === 'room' ? 'Nothing booked' : 'Free between classes') + '</h2>';
    if (gaps.length) {
      out += '<ul class="segments">' + gaps.map(function (s) {
        // Three shapes: before the first booking, between two, and after the last.
        var when = s.leading
          ? 'before ' + esc(s.end)
          : esc(s.start) + ' → ' + (s.open_ended ? 'end of day' : esc(s.end));

        var mins = (s.start_min === null || s.end_min === null)
          ? null : s.end_min - s.start_min;

        // An open-ended or leading gap has no measurable duration to show.
        var parts = [];
        if (mins !== null) {
          var h = Math.floor(mins / 60), m = mins % 60;
          parts.push((h ? h + 'h ' : '') + m + 'm');
        }
        parts.push(mode === 'room' ? 'nothing booked, may still be locked' : 'free');
        return '<li class="segment"><span class="tag gap">GAP</span>' +
          '<span class="seg-time">' + when + '</span>' +
          '<span class="seg-label muted">' + parts.join(' · ') + '</span></li>';
      }).join('') + '</ul>';
    } else {
      out += '<p class="empty">No gaps — booked back to back.</p>';
    }

    if (mode === 'room' && gaps.length) {
      out += '<p class="footnote">A gap means nothing is scheduled, <strong>not</strong> that the ' +
        'room is open. Unallocated rooms are usually locked. Only the OPEN windows above are ' +
        'a positive signal.</p>';
    }
    return out;
  }

  function sessionsHtml(rows, mode) {
    var now = nowMin();
    return '<h2>Today’s sessions</h2>' +
      '<ul class="segments">' + rows.slice().sort(function (a, b) {
        return (a.start_min || 0) - (b.start_min || 0);
      }).map(function (r) {
        var st = T.liveStatus(r);
        var cls = T.parseClass(r.event);
        var live = r.start_min <= now && now < r.end_min;
        var right = mode === 'room'
          ? (cls
              ? '<a href="/class?code=' + encodeURIComponent(cls.code) + '">' +
                esc(cls.code) + ' · ' + esc(cls.section) + '</a> — ' + esc(cls.title)
              : esc(r.event))
          : '<a href="/room?code=' + encodeURIComponent(r.room) + '">' + esc(r.room) + '</a>' +
            (cls ? ' · ' + esc(cls.section) : '') +
            (r.room_description ? ' <span class="room-sub">' + esc(r.room_description) + '</span>' : '');
        return '<li class="segment">' +
          '<span class="tag ' + (T.isFreeAccess(r) ? 'free' : 'busy') + '">' +
          (T.isFreeAccess(r) ? 'OPEN' : 'CLASS') + '</span>' +
          '<span class="seg-time">' + esc(r.start) + ' – ' + esc(r.end) +
          (live ? '<span class="now-badge">NOW</span>' : '') + '</span>' +
          '<span class="seg-label status-' + esc(st) + '">' + right + '</span></li>';
      }).join('') + '</ul>';
  }

  // ---------- pickers, shown when no code is given ----------

  function pickerHtml(items, mode) {
    var label = mode === 'room' ? 'room' : 'class';
    return '<div class="card">' +
      '<h2 style="margin-top:0">Pick a ' + label + '</h2>' +
      '<p class="field" style="max-width:340px"><label for="pick">Search</label>' +
      '<input id="pick" type="text" autocomplete="off" placeholder="' +
      (mode === 'room' ? 'e.g. LT.A.1.08' : 'e.g. MTH131') + '"' +
      ' aria-describedby="pick-hint" />' +
      '<span class="field-hint" id="pick-hint">' + items.length + ' ' + label +
      's with something scheduled today</span></p>' +
      '<ul class="open-grid" id="pickList">' + items.map(function (it) {
        return '<li class="open-item" data-search="' + esc((it.key + ' ' + it.sub).toUpperCase()) + '">' +
          '<p class="open-room"><a href="/' + mode + '?code=' + encodeURIComponent(it.key) + '">' +
          esc(it.key) + '</a></p>' +
          '<p class="open-desc">' + esc(it.sub) + '</p></li>';
      }).join('') + '</ul>' +
      '<p class="empty" id="pickEmpty" hidden>Nothing matches that.</p>' +
      '</div>';
  }

  function wirePicker() {
    var input = el('pick');
    if (!input) return;
    var items = [].slice.call(document.querySelectorAll('#pickList li'));
    var empty = el('pickEmpty');
    input.addEventListener('input', function () {
      var q = input.value.trim().toUpperCase();
      var shown = 0;
      items.forEach(function (li) {
        var hit = !q || li.getAttribute('data-search').indexOf(q) !== -1;
        li.hidden = !hit;
        if (hit) shown++;
      });
      empty.hidden = shown > 0;
    });
  }

  // ---------- the two modes ----------

  function renderRoom(p, code) {
    var rows = T.normalize(p.rows).filter(function (r) { return r.room === code; });
    var info = (p.rooms || []).filter(function (r) { return r.room === code; })[0];

    if (!rows.length && !info) return null;

    var timed = rows.filter(function (r) {
      return r.start_min !== null && r.end_min !== null;
    });
    var timeline = timed.length ? T.buildTimeline(timed) : [];
    var range = T.dayRange(T.normalize(p.rows));

    var first = rows[0] || {};
    var block = info ? info.block : first.block;
    var floor = info ? info.floor : first.floor;
    var desc = (info && info.description) || first.room_description || '';

    var now = nowMin();
    var openNow = timeline.some(function (s) {
      return s.type === 'open' && s.start_min <= now && now < s.end_min;
    });
    var busyNow = timeline.some(function (s) {
      return s.type === 'busy' && s.start_min <= now && now < s.end_min;
    });

    var state = openNow
      ? '<p class="state is-open">Open to students right now</p>'
      : busyNow
        ? '<p class="state is-busy">In use right now</p>'
        : '<p class="state is-gap">Nothing booked right now — but nothing says it is open either</p>';

    return {
      title: code,
      sub: 'Block ' + (block || '?') + ' · Floor ' +
        (floor === null || typeof floor === 'undefined' ? '?' : floor) +
        (desc ? ' · ' + desc : ''),
      body: state +
        (timeline.length ? T.dayBarHtml(timeline, range) : '') +
        gapsHtml(withLeadingGap(timeline), 'room') +
        (timed.length
          ? sessionsHtml(timed, 'room')
          : '<h2>Today’s sessions</h2><p class="empty">Nothing at all is booked in this room ' +
            'today. That is not the same as open — see above.</p>')
    };
  }

  function renderClass(p, code) {
    var all = T.normalize(p.rows);
    var rows = all.filter(function (r) {
      var c = T.parseClass(r.event);
      return c && c.code === code;
    }).filter(function (r) {
      return r.start_min !== null && r.end_min !== null;
    });

    if (!rows.length) return null;

    var cls = T.parseClass(rows[0].event);
    var timeline = T.buildTimeline(rows);
    var range = T.dayRange(all);
    var sections = {};
    rows.forEach(function (r) {
      var c = T.parseClass(r.event);
      if (c) sections[c.section] = 1;
    });

    return {
      title: code,
      sub: (cls ? cls.title + ' · ' : '') + rows.length + ' session' +
        (rows.length === 1 ? '' : 's') + ' today · ' +
        Object.keys(sections).sort().join(', '),
      body: T.dayBarHtml(timeline, range) +
        sessionsHtml(rows, 'class') +
        gapsHtml(withLeadingGap(timeline), 'class')
    };
  }

  // ---------- entry point ----------

  function init(mode) {
    var code = qs('code');
    var head = el('detailHead');
    var body = el('detailBody');
    var meta = el('detailMeta');

    function fail(msg) {
      head.textContent = mode === 'room' ? 'Room not found' : 'Class not found';
      body.innerHTML = '<p class="empty">' + esc(msg) + '</p>' +
        '<p><a class="btn" href="/' + mode + '">See all ' +
        (mode === 'room' ? 'rooms' : 'classes') + '</a></p>';
    }

    SIMFeed.load().then(function (p) {
      meta.innerHTML = freshnessLine(p);

      if (!code) {
        head.textContent = mode === 'room' ? 'Rooms' : 'Classes';
        document.title = (mode === 'room' ? 'Rooms' : 'Classes') + ' — SIM Campus Timetable';

        var items;
        if (mode === 'room') {
          var seen = {};
          T.normalize(p.rows).forEach(function (r) {
            if (!r.room) return;
            (seen[r.room] = seen[r.room] || []).push(r);
          });
          items = Object.keys(seen).sort().map(function (k) {
            var rs = seen[k];
            var open = rs.filter(T.isFreeAccess).length;
            return {
              key: k,
              sub: rs.length + ' booking' + (rs.length === 1 ? '' : 's') +
                (open ? ' · open to students' : '')
            };
          });
        } else {
          var courses = {};
          T.normalize(p.rows).forEach(function (r) {
            var c = T.parseClass(r.event);
            if (!c) return;
            if (!courses[c.code]) courses[c.code] = { title: c.title, n: 0 };
            courses[c.code].n++;
          });
          items = Object.keys(courses).sort().map(function (k) {
            return {
              key: k,
              sub: courses[k].title + ' · ' + courses[k].n + ' session' +
                (courses[k].n === 1 ? '' : 's')
            };
          });
        }

        body.innerHTML = pickerHtml(items, mode);
        wirePicker();
        return;
      }

      var view = mode === 'room' ? renderRoom(p, code) : renderClass(p, code);
      if (!view) {
        fail('Nothing scheduled today for "' + code + '".');
        return;
      }
      head.textContent = view.title;
      document.title = view.title + ' — SIM Campus Timetable';
      meta.innerHTML = esc(view.sub) + ' · ' + freshnessLine(p);
      body.innerHTML = view.body;
    }).catch(function (err) {
      fail('Could not load today’s schedule (' + (err.message || err) + ').');
    });
  }

  global.SIMDetail = { init: init };
})(typeof window !== 'undefined' ? window : this);
