/* Tiny toast stack — enough to tell someone that work is happening and how far
 * along it is, rather than leaving them looking at a blank panel.
 *
 * Toasts are keyed by id, so re-showing the same id updates in place instead of
 * stacking up a queue of near-identical messages.
 *
 *   Toast.show({ id: 'fetch', title: 'Reading schedule…', detail: '120 KB', progress: 0.4 });
 *   Toast.show({ id: 'fetch', title: 'Done', tone: 'success', ttl: 4000 });
 *   Toast.dismiss('fetch');
 */
(function (global) {
  'use strict';

  var container = null;
  var live = {};   // id -> { el, timer }

  function ensureContainer() {
    if (container && document.body.contains(container)) return container;
    container = document.createElement('div');
    container.className = 'toast-stack';
    // Announce updates to screen readers without stealing focus.
    container.setAttribute('role', 'status');
    container.setAttribute('aria-live', 'polite');
    document.body.appendChild(container);
    return container;
  }

  function build(opts) {
    var el = document.createElement('div');
    el.className = 'toast';
    el.innerHTML =
      '<div class="toast-row">' +
      '  <span class="toast-spinner" data-el="spinner"></span>' +
      '  <span class="toast-title" data-el="title"></span>' +
      '</div>' +
      '<div class="toast-detail" data-el="detail"></div>' +
      '<div class="toast-bar" data-el="bar"><i data-el="fill"></i></div>';
    return el;
  }

  function show(opts) {
    opts = opts || {};
    var id = opts.id || ('t' + Object.keys(live).length);
    var entry = live[id];

    if (!entry) {
      var el = build(opts);
      ensureContainer().appendChild(el);
      entry = live[id] = { el: el, timer: null };
      // Let the element land before transitioning, so it animates in.
      requestAnimationFrame(function () { el.classList.add('in'); });
    }

    var el = entry.el;
    var q = function (name) { return el.querySelector('[data-el="' + name + '"]'); };

    var tone = opts.tone || 'info';
    el.className = 'toast in tone-' + tone;

    q('title').textContent = opts.title || '';
    var detail = q('detail');
    detail.textContent = opts.detail || '';
    detail.style.display = opts.detail ? '' : 'none';

    // A spinner only makes sense while something is still running.
    q('spinner').style.display = (tone === 'info' && opts.spinner !== false) ? '' : 'none';

    var bar = q('bar');
    if (typeof opts.progress === 'number' && opts.progress >= 0) {
      bar.style.display = '';
      q('fill').style.width = Math.max(0, Math.min(1, opts.progress)) * 100 + '%';
    } else {
      bar.style.display = 'none';
    }

    if (entry.timer) { clearTimeout(entry.timer); entry.timer = null; }
    if (opts.ttl) {
      entry.timer = setTimeout(function () { dismiss(id); }, opts.ttl);
    }
    return id;
  }

  function dismiss(id) {
    var entry = live[id];
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    delete live[id];
    entry.el.classList.remove('in');
    setTimeout(function () {
      if (entry.el.parentNode) entry.el.parentNode.removeChild(entry.el);
    }, 200);
  }

  function clear() {
    Object.keys(live).forEach(dismiss);
  }

  /** Bytes -> "236 KB". Used for download progress detail. */
  function formatBytes(n) {
    if (!n && n !== 0) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }

  global.Toast = { show: show, dismiss: dismiss, clear: clear, formatBytes: formatBytes };
})(window);
