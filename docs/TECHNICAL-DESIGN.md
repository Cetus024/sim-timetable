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

## 2. Parsing

All four parsers are pure and live in `assets/timetable.js`, duplicated in `scrape.js` only
because the scraper must be a **single self-contained paste** with no imports.

```
toMinutes("4:00 PM")      → 960          12-hour → minutes since midnight;
                                          handles the 12AM/12PM wrap explicitly
parseTimeRange("9:00 AM - 12:00 PM")     splits on "-", strips U+00A0 first (§2.1)
parseBlock("Block B", "TR.B.5.14") → "B" building column wins; falls back to the room code
parseFloor("TR.B.5.14")   → 5            first ".<digits>." group, else a trailing ".<digits>"
```

### 2.1 The non-breaking space

The source table renders times with `&nbsp;` around the hyphen. A naive `split('-')` on the raw
`innerText` yields tokens with U+00A0 attached, `toMinutes` returns `null`, and the row silently
becomes untimed — dropped from availability view entirely. `parseTimeRange` normalises U+00A0 to a
plain space **before** splitting. It is written as the escape `\u00a0` in the source rather
than as a literal character, so it survives any encoding round-trip.

### 2.2 Why parse at scrape time

Parsing runs once, in the scraper, and the results are stored in the JSON. The viewer re-derives
only when fields are missing. This keeps the render path free of string parsing, makes the JSON
self-describing when read by a human, and means a parser fix can be applied to old data by
re-running `normalize()` on it.

## 3. Scraping

### 3.1 The race

The scheduling page advances its own pagination on a timer. A naive `while (next) { read; click; }`
loses rows whenever the site's timer fires between the read and the click — and the output is
indistinguishable from a good scrape, just shorter. Since the product claims rooms are *free*, an
undetected gap means asserting "free" where the truth is "unknown". **Silent under-collection is
the worst failure this system can have.**

### 3.2 Mitigations, in order

1. **Reset to page 1 first.** The page may have drifted before the user pasted anything.
   Prefers a "first page" control; otherwise clicks "previous" until disabled, capped at 30
   iterations so a mis-selected button can't spin forever.
2. **Read the site's own total.** MUI's `labelDisplayedRows` renders `"8-14 of 112"`. Scanning for
   that pattern yields both the page size and the authoritative row count.
3. **Range-advance check.** After each of *our* clicks, the visible range should move forward by
   about one page. If `infoAfter.from > infoBefore.to + pageSize`, something else advanced it too —
   flag `skippedPageWarning`.
4. **Dedupe.** Rows are deduped by `JSON.stringify` identity, so re-reading a page (which the
   reset step can cause) is harmless rather than duplicating.
5. **Reconcile.** Compare unique rows against `site_total`.

### 3.3 The honesty rule

```js
incomplete: skippedPageWarning || (expectedTotal !== null && uniqueRaw.length < expectedTotal)
```

The scraper never claims coverage it cannot demonstrate. When `incomplete` is true the viewer
shows a warning in the header. **Do not "simplify" any of §3.2 away** — each step exists because
the naive version produced quietly wrong timetables.

### 3.4 Timing

Fixed 1200ms waits after pagination clicks (900ms when rewinding). Crude but adequate: the table
is small and re-renders fast. A `MutationObserver` on the tbody would be more precise and is the
obvious upgrade if the site gets slower; the coverage checks in §3.2 are what make the crude
version *safe*, since a too-short wait shows up as a count mismatch rather than as bad data.

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

## 6. Persistence

`localStorage['sim-timetable-payload']` holds the last imported payload. On load, the viewer
restores it and skips the import panel; a corrupt entry is caught and cleared rather than
throwing. Every write is wrapped in `try/catch` for private-mode and quota failures — persistence
is a convenience and must never break the app.

Filter state is intentionally **not** persisted: reopening with a stale filter silently hiding
rooms is a worse failure than retyping one field.

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

There is no automated test suite — a deliberate call at this size, given the app's only real
integration point is a DOM this project doesn't control. The parsers and `buildTimeline` are pure
and are the obvious first candidates if tests are added.
