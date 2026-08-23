# Technical Design — SIM Campus Timetable

**Last updated:** 2026-08-23 · **Companion docs:** [PRD](PRD.md) · [Architecture](../ARCHITECTURE.md)

This is the engineering-detail document: contracts, algorithms, edge cases, failure modes, and the
reasoning behind choices that aren't obvious from the code.

---

## 1. Data contract

### 1.1 The payload (v1)

```jsonc
{
  "version": 1,                          // bump on breaking row-shape changes
  "source": "https://…",                 // location.href at scrape time — provenance
  "scraped_at": "2026-08-23T02:00:00Z",  // ISO 8601; drives the staleness display
  "site_total": 112,                     // the site's own claimed row count, or null
  "incomplete": false,                   // true = coverage NOT verified (§3.3)
  "rows": [ /* Row */ ]
}
```

### 1.2 `Row`

| Field | Type | Notes |
| --- | --- | --- |
| `start`, `end` | `string \| null` | Display form, e.g. `"4:00 PM"`. Never used for comparisons. |
| `start_min`, `end_min` | `number \| null` | Minutes since midnight. **All logic uses these.** |
| `block` | `string \| null` | Single uppercase letter. |
| `floor` | `number \| null` | Integer. |
| `room` | `string` | The grouping key in availability view. |
| `event` | `string` | `"Free Access"` is semantically special (§4.1). |
| `status` | `string` | `CURRENT` / `UPCOMING`; styled, not filtered on. |

`null` is used deliberately for "the source didn't give us this", and is rendered `?` rather than
being hidden — a missing field should be visible, not silently absent.

### 1.3 Accepted inputs

`coerce()` in `viewer.html` accepts, in order of preference:

1. A full v1 payload.
2. A **bare array** of rows (convenience for hand-edited data).
3. Rows carrying only the **raw scraped columns** (`time`, `event`, `building`, `room`, `status`) —
   `SIMTimetable.normalize()` re-derives the parsed fields.

Case 3 exists so that a payload from an older/simpler scrape still renders. `normalize()` detects
an already-parsed row by the presence of both `start_min` and `block`, and passes it through
untouched rather than re-parsing.

Rejections throw with a specific message (`Expected an object with a "rows" array…`,
`That file has no rows in it.`) which the viewer shows verbatim. Silent failure is the thing to
avoid here — a blank screen after a 30-second scrape is a terrible outcome.

## 2. Reading the schedule

The scheduling page is a front end over `GET /rad/rest/campus?id=SIM`, which returns the whole
campus in one response:

```
data.buildings[] → .rooms[] → .activities[]
                    code, description        name, description
                    (capacity lives here)    startDateTime, endDateTime
```

`scraper/scrape.js` is the only implementation of the read and the transform. The bookmarklet
runs it directly; `scripts/fetch-schedule.mjs` evaluates *that same file* in a headless page with
`window.__SIM_SCRAPE_HEADLESS__ = true`, which makes it return the payload instead of opening a
viewer tab. There is deliberately no second copy of the parsing to drift out of sync.

### 2.1 Derived fields

```
blockOf("SIM Campus Block A", code)  → "A"    building name first, room code as fallback
floorOf("LT.A.1.08")                 → 1      the ".<letter>.<digits>." group
parseStamp("2026-08-24 15:30:00")    → {min: 930, label: "3:30 PM", date: "2026-08-24"}
```

`floorOf` deliberately has **no** trailing-digit fallback. `TR.1` is Tutor Room 1, not floor 1;
55 of 326 rooms have no parseable floor and are reported as unknown rather than guessed.

Times arrive as exact timestamps, so none of the old string parsing — 12-hour wraps, non-breaking
spaces around the hyphen — is needed any more.

### 2.2 Coverage

The response lists every room, including rooms whose `activities` array is empty. Those are the
rooms free all day: 170 of 326 on the day this was written, and structurally invisible to anyone
reading the rendered table, which only ever lists rooms that are busy.

## 3. The daily job

`.github/workflows/daily-schedule.yml` runs `05 16 * * *` UTC — 00:05 SGT — plus
`workflow_dispatch` for manual runs. It locates Chrome on the runner, runs
`scripts/fetch-schedule.mjs`, and commits `data/latest.json` with `contents: write`.

**Non-destructive failure.** The fetch refuses to write a payload with zero rooms or zero
bookings, and any error exits non-zero before touching the file, so a bad day leaves yesterday's
good data in place — with its age on screen, which is what tells a reader something is stale.

**Consumption.** The viewer reads the committed file from `raw.githubusercontent.com`, which
sends `Access-Control-Allow-Origin: *`. The campus API itself does not, which is precisely why
the feed exists rather than the page calling the API directly. Local data renders first so the
page is never blank, and is replaced only when the feed's `scraped_at` is newer. A missing or
unreachable feed is silent — it must never take away data the reader already has.

**Why a browser in CI.** See §9 and PRD §5: the WAF answers 464 to non-browser clients. Verified
working from a GitHub-hosted runner, so its datacenter IPs are not blocked.

## 4. Rendering

### 4.1 The availability timeline

`buildTimeline(bookings)` — the core algorithm — takes one room's bookings, sorted by `start_min`:

```
for each booking b, in order:
    emit  { type: isFreeAccess(b) ? free : busy, b.start_min → b.end_min }
    if there is a next booking n:
        if n.start_min > b.end_min:
            emit { type: free, b.end_min → n.start_min }        // the gap
    else:
        emit { type: free, b.end_min → null, open_ended: true } // the tail
```

Three decisions worth flagging:

- **`Free Access` is data, not absence.** The source uses it as a real booking meaning "open to
  students", so it is emitted as a FREE segment carrying its label, not skipped.
- **The tail is open-ended.** It renders as *"→ end of visible schedule"* and never as a time.
  The schedule only shows so far ahead; printing a concrete end time would assert knowledge the
  scrape does not have.
- **Overlaps are not merged.** If two bookings overlap, both are emitted as BUSY and no spurious
  gap appears (the `n.start_min > b.end_min` guard). Overlapping bookings are a source-data
  anomaly; showing both is more honest than silently coalescing them.

### 4.1a What "free" is allowed to mean

The most important semantic in this project. SIM marks rooms students may use with an explicit
booking named **"Free Access"** (or "SST Free Access") - 38 rooms carry one on a typical day.
That is the *only* positive signal that a room is open.

A room with **nothing booked** is not open. It is unallocated, and usually locked: of the 170
unbooked rooms, 25 are labs, and the rest are largely tutor rooms, foyers, courtyards and staff
lounges. An earlier version listed all 170 under "Free all day", which asserted something the
data never says. A reader asked whether it just meant "locked all day", and they were right.

So the timeline has three segment kinds, not two:

| kind | meaning | shown as |
| --- | --- | --- |
| `open` | an explicit Free Access booking | **OPEN**, green |
| `busy` | any other booking | **BUSY**, red |
| `gap` | nothing booked | **GAP**, muted, labelled "may still be locked" |

The availability view leads with the Free Access rooms and their windows. The unbooked rooms are
reported as a count with an explanation, never as a list of places to go. The "Open after/before"
filters match `open` segments only - the question is "when can I get in", not "when is nothing
scheduled".

### 4.1b Progress reporting

A load used to be a blank panel. `scraper/scrape.js` now streams the API response and posts
`sim-timetable:progress` messages to the viewer - bytes received while downloading, then
per-building counts while transforming ("2 of 4 buildings, 180 rooms, 210 bookings so far").
The viewer renders these in a toast (`assets/toast.js`) and in the waiting panel.

Two honesty notes: the response is gzipped, so Content-Length is the compressed size while the
streamed chunks are decompressed - bytes received are reported, never a fabricated percentage.
And "pages" are not reported at all, because there is no longer any pagination to count.

### 4.2 Filtering

All filters compose, evaluated per row, then availability filters apply per room afterwards:

| Filter | Semantics |
| --- | --- |
| block / floor | Exact match on the parsed field. |
| room contains | Case-insensitive substring. |
| exclude contains | Comma-separated; a row matching **any** term is dropped. |
| ends at | Exact match on the display string (the dropdown is built from the data). |
| free after / before | Room-level: keeps rooms with a free segment **starting** in the window. |

Free-after/before are deliberately about the *start* of a free segment — "I'm free at 4, what can I
walk into" — not about segments merely overlapping the window.

### 4.3 Escaping

`esc()` is applied to every interpolated value, including `status` (which lands inside a `class`
attribute). The original prototype interpolated `event` and `room` raw; a room name containing `<`
would have broken the render. Room names come from a system of record, not from users, so this is
robustness rather than a live XSS — but the renderer is also reused by the export, and cheap
correctness at the boundary is worth it.

### 4.4 The `mount()` contract

```js
SIMTimetable.mount(rootElement, rows, { mode, initial }) → controller
```

- Injects its own toolbar and result container; the host page supplies only an empty element.
- Elements are addressed via `data-f` (filters) and `data-el` (chrome) attributes scoped to
  `root`, **not** by global `getElementById` — so two instances on one page would not collide.
- Returns `{ render, getData, getState, getMode }`. `getState`/`getMode` exist so the export can
  capture the user's current view (§5).
- **Does no I/O.** No fetch, no storage. This is what lets it be inlined into the export unchanged.

## 5. Standalone export

The viewer fetches the *source text* of `assets/styles.css` and `assets/timetable.js`, inlines
both into a generated document alongside `JSON.stringify(rows)`, and calls the same `mount()` with
the current filter state and mode.

- Every `<` inside the inlined JSON is escaped as `\u003c`, so no data value can terminate the
  `<script>` block early.
- The result is ~21KB, fully offline, and has no dependency on this site continuing to exist.
- Because it reuses the live renderer's source rather than reimplementing it, the export cannot
  drift from the app — the property that motivated the whole split (see ARCHITECTURE.md).

## 5b. Cross-tab handoff

The bookmarklet flow removes the file step entirely: the scraper opens the viewer itself and
delivers the payload by `postMessage`.

**Ordering.** The viewer tab is opened at the *very top* of the script, before any scraping,
because `window.open` is only allowed while the click that started the script still counts as
a user gesture. Opening it 30 seconds later, after the scrape, gets it popup-blocked.

**Delivery.** The scraper re-posts the payload every 300ms (up to ~12s) until the viewer replies
`sim-timetable:received`. Retrying beats a ready-handshake here: neither tab has to win a race,
and a viewer that is slow to load simply gets the payload on a later pump. In practice delivery
lands on the first or second pump.

**Acceptance rules on the viewer side.** A message is only acted on when all of these hold:

1. the viewer was opened as `/viewer?awaiting=1` **and** has a `window.opener`;
2. `e.source === window.opener` — the sender is the tab that opened it;
3. `e.data.type === 'sim-timetable:payload'`;
4. the payload survives `coerce()`, the same validation every other import goes through.

The scraper posts with an explicit `targetOrigin`, so the data is only ever released to the
expected origin. Rule 2 is what stops an unrelated page from injecting a fabricated timetable;
note that posting via `postMessage.call(viewerWin, …)` from the opener is *not* a spoof, since
`e.source` is set by the calling context — a real third party has to be a different window,
which is what `scripts/test-handoff.mjs` exercises.

**Fallbacks.** Popup blocked, viewer closed, or no acknowledgement within ~12s → the scraper
downloads `sim-timetable.json` and copies it to the clipboard exactly as before. The manual
import path is never removed, only bypassed.

**Origin wiring.** `scrape.js` ships with a `__VIEWER_ORIGIN__` placeholder that the landing
page rewrites to its own origin when building the copy text and the bookmarklet, so a local dev
copy hands off to localhost. The raw file falls back to the production origin if never rewritten.

## 6. Persistence

`localStorage['sim-timetable-payload']` holds the last imported payload. On load, the viewer
restores it and skips the import panel; a corrupt entry is caught and cleared rather than
throwing. Every write is wrapped in `try/catch` for private-mode and quota failures — persistence
is a convenience and must never break the app.

Filter state is intentionally **not** persisted: reopening with a stale filter silently hiding
rooms is a worse failure than retyping one field.

Because a restored payload can be old, the header states the age in words ("3 hours ago") and
warns outright when the scrape is from a previous calendar day — schedules are per-day, so a
stale one is not merely dated, it is wrong.

## 6b. The daily job

Superseded by §3 — the local scheduled task, its saved browser profile and `auto-scrape.mjs`
were all built for a login that turned out not to exist, and have been removed. The refresh now
runs in GitHub Actions; see §3.

## 7. Hosting

`vercel.json` sets `cleanUrls: true` (so `/viewer` serves `viewer.html`), `trailingSlash: false`,
an explicit `text/javascript` content type on `/scraper/scrape.js`, and `must-revalidate` on the
scraper and assets — the scraper must never be served stale, since a cached copy could contain a
known-broken selector.

`scripts/serve.mjs` mirrors that resolution order locally (`path`, `path.html`, `path/index.html`)
so local behaviour matches production. It normalises and confines resolved paths to the project
root to prevent traversal.

## 8. Failure modes

| Failure | Detection | Behaviour |
| --- | --- | --- |
| Site DOM/selectors change | Zero rows scraped | Console shows 0; nothing to import. **Requires a code fix.** |
| Pagination race | Range-advance check, count reconciliation | `incomplete: true` → warning in viewer |
| Clipboard write blocked | `catch` on `navigator.clipboard` | Falls back to the file download; logged, not fatal |
| Clipboard read blocked | `catch` in the viewer | Message directs the user to the paste box |
| Malformed JSON imported | `coerce()` throws | Specific message shown inline |
| `localStorage` unavailable | `try/catch` | App works, just doesn't persist |
| Asset fetch fails on export | `.catch` | `Export failed: <reason>` shown |
| Scraper source fails to load | `.catch` on landing page | Snippet shows the error; copy button reports unavailable |

## 9. Environment notes

Two machine-specific quirks worth recording, since both cost time:

- **Vercel CLI + non-ASCII hostname.** The machine hostname contains U+2018, which the CLI puts
  into an HTTP header, crashing on ByteString conversion. Workaround: preload a shim overriding
  `os.hostname()` via `NODE_OPTIONS=--require <shim>`. Also seen: a transient `fetch failed` on
  the first deploy of a new project, which a plain retry resolved.
- **Microsoft Store `python.exe` silently fails to write files.** An `open(p,'w').write(...)`
  reported success while the file on disk was unchanged — twice, including with an explicit
  context manager. Use node or an editor tool for file writes on this machine; do not trust a
  zero exit code from Store Python as evidence a write landed.

## 10. Verification performed

Against both `localhost:4173` and the live deployment:

- All six routes return 200 with correct content types.
- Landing page fetches the scraper source (7,338 chars) and builds a valid `javascript:` bookmarklet.
- Sample data renders 6 rooms; `Free Access` becomes FREE segments; gaps and open-ended tails correct.
- Composed filters: exclude `LAB, MPSH` + free-after `4:00 PM` narrows 6 rooms → 4, and every
  survivor genuinely has a free segment starting after 16:00.
- Table mode: 10 of 14 events after exclusion, sorted by end time, time filters hidden.
- Export loaded into an isolated iframe renders identically (21,264 bytes) with filter state intact.
- Reload restores from `localStorage`; no console errors on any page.

`scripts/test-handoff.mjs` covers the cross-tab handoff end to end in headless Edge (real popup,
real user gesture via CDP `userGesture: true`), including the negative case. Everything else is
verified manually as above — a deliberate call at this size, given the app's only real
integration point is a DOM this project doesn't control. The parsers and `buildTimeline` are pure
and are the obvious first candidates if tests are added.
