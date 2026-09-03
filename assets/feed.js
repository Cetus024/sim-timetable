/* Loading the published schedule, shared by every page that needs it.
 *
 * The URL lives here and nowhere else. viewer.html reads SIMFeed.URL rather
 * than keeping its own copy, so the detail pages and the viewer cannot end up
 * pointing at different files.
 */
(function (global) {
  'use strict';

  var STORAGE_KEY = 'sim-timetable-payload';

  // Published every day at ~00:05 SGT by .github/workflows/daily-schedule.yml.
  // Read from raw.githubusercontent.com, which sends Access-Control-Allow-Origin.
  // The campus API itself is same-origin only, which is why this file exists.
  var URL_ = 'https://raw.githubusercontent.com/Cetus024/sim-timetable/main/data/latest.json';

  function coerce(raw) {
    var parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (Array.isArray(parsed)) parsed = { rows: parsed };
    if (!parsed || !Array.isArray(parsed.rows)) {
      throw new Error('Expected an object with a "rows" array, or an array of rows.');
    }
    if (!parsed.rows.length) throw new Error('That file has no rows in it.');
    return parsed;
  }

  /* Resolves with a payload, preferring whatever is already in localStorage so
   * a detail page opened from the viewer renders instantly, then upgrading if
   * the published feed turns out to be newer.
   *
   * onLocal is called first when there is stored data, so a page can paint
   * before the network answers. */
  function load(onLocal) {
    var local = null;
    try {
      var saved = localStorage.getItem(STORAGE_KEY);
      if (saved) local = coerce(saved);
    } catch (e) {
      try { localStorage.removeItem(STORAGE_KEY); } catch (e2) { /* ignore */ }
    }
    if (local && typeof onLocal === 'function') onLocal(local);

    function stamp(p) {
      var t = Date.parse(p && p.scraped_at);
      return isNaN(t) ? 0 : t;
    }

    return fetch(URL_, { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (raw) {
        var remote = coerce(raw);
        if (!local || stamp(remote) > stamp(local)) {
          try { localStorage.setItem(STORAGE_KEY, JSON.stringify(remote)); } catch (e) { /* quota */ }
          return remote;
        }
        return local;
      })
      .catch(function (err) {
        // Never take away data the reader already has; only report when there
        // is nothing at all to show.
        if (local) return local;
        throw err;
      });
  }

  global.SIMFeed = { URL: URL_, STORAGE_KEY: STORAGE_KEY, coerce: coerce, load: load };
})(typeof window !== 'undefined' ? window : this);
