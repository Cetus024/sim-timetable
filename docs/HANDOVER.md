# Handover — pick this project up cold

Read this first when starting a new session on `sim-timetable`. It is the state of
the work, the rules that must not be broken, and the traps that have already cost time.
Last updated: **2026-09-03**.

- **Live:** https://sim-timetable.vercel.app
- **Repo:** https://github.com/Cetus024/sim-timetable (public) · local: `C:\Users\ASUS\.copilot\repos\sim-timetable`
- **Vercel:** https://vercel.com/cetus024s-projects/sim-timetable (account `cetus024`)

Deeper docs: [PRD](PRD.md) · [Architecture](../ARCHITECTURE.md) · [Technical design](TECHNICAL-DESIGN.md) ·
[README](../README.md)

---

## 1. What this is, in three sentences

A GitHub Action reads SIM's own public campus API once a day and commits `data/latest.json`
to this repo. A static site on Vercel fetches that file and renders it as a timetable, a
per-room availability view, and a page per room and per class. Nothing is uploaded, there is
no backend, no login, and no build step.

## 2. The rules that must not be relaxed

These are not style preferences. Each one exists because the alternative produced something
wrong, and a future change that quietly reverses one is a regression even if nothing errors.

1. **"Unbooked" is NOT "open".** SIM marks rooms students may use with an explicit booking
   named **Free Access**. That is the *only* positive signal. A room with nothing booked is
   unallocated and usually locked — around 170 of 326 rooms on a normal day, mostly labs,
   tutor rooms and foyers. It is reported as a count with an explanation, never listed as
   somewhere to go. Gaps render as **GAP**, never FREE. A reader once asked whether "free all
   day" just meant "locked all day"; they were right, and that is why this rule exists.
2. **One implementation of read-and-transform.** `scraper/scrape.js` is it. The bookmarklet
   runs it directly; CI evaluates *that same file* headless with
   `window.__SIM_SCRAPE_HEADLESS__ = true`. Never write a second parser.
3. **One renderer.** `assets/timetable.js` is `mount()` and does no I/O. That is what lets the
   standalone export inline the same file and stay identical to the live viewer.
4. **One feed URL.** It lives in `assets/feed.js` as `SIMFeed.URL`. `viewer.html` reads it from
   there. Do not paste the raw.githubusercontent URL anywhere else.
5. **A failed fetch must never destroy good data.** The daily job refuses a payload with zero
   rooms or zero bookings and exits non-zero, leaving yesterday's file. The viewer renders
   local data first and only replaces it when the feed is *newer*.
6. **Colour is never the only carrier.** OPEN/BUSY/GAP are words too. The day bar is
   `aria-hidden` and everything it draws is written out underneath.
7. **Run `node scripts/check-contrast.mjs` after any colour change.** It fails the build of
   your confidence, not the site — but it catches real AA regressions. See §6.

## 3. Where things are

```
index.html      landing: what this is, and the bookmarklet
viewer.html     the main timetable: feed loading, import, export, bookmarklet handoff
room.html       /room  — one classroom (or a searchable index with no ?code)
class.html      /class — one class    (or a searchable index with no ?code)

assets/timetable.js   parsing + the viewer's renderer. Inlined into the export.
assets/detail.js      renders BOTH detail pages; one implementation, two modes
assets/feed.js        SIMFeed.URL + SIMFeed.load()  ← the only place the URL lives
assets/styles.css     all styling, and the colour tokens check-contrast.mjs reads
assets/toast.js       progress/status toasts

scraper/scrape.js            the ONLY read-and-transform
scripts/fetch-schedule.mjs   evaluates scrape.js headless; writes data/latest.json
scripts/lib/cdp.mjs          dependency-free CDP client (open/evaluate/send)
scripts/serve.mjs            local static server, mirrors Vercel clean URLs
scripts/check-contrast.mjs   WCAG AA check over the palette
scripts/test-handoff.mjs     end-to-end test of the bookmarklet handoff
data/latest.json             published daily by the Action
.github/workflows/daily-schedule.yml   the 00:05 SGT job
```

## 4. Data shape you will actually use

`data/latest.json` is `version: 2`:

- `rows[]` — every booking: `start`/`end` (display), `start_min`/`end_min` (minutes since
  midnight — **all logic uses these**), `block`, `floor`, `room`, `event`, `room_description`.
- `rooms[]` — the full inventory including rooms with `activities: 0` (nothing booked).
  The rendered SIM table can only show busy rooms, so this array is the only way to know
  a room exists at all.
- `schedule_dates[]`, `scraped_at`, `auto`.

**Never trust `status` from the payload** — it was written at 00:05 and would still say
UPCOMING at 3pm. `SIMTimetable.liveStatus(row)` recomputes it from the reader's clock.

### Parsing a class out of an event title

`SIMTimetable.parseClass(event)` → `{code, section, title}` or `null`.

It splits on the **first `" : "`**, then takes the section from the **last `" - "`** on the
left. That order matters: codes can contain a hyphen (`"SMM- - L01 : ..."`) and titles almost
always do (`"... - RMIT"`), so a single regex gets one or the other wrong.

It returns `null` for roughly a quarter of rows — Free Access, club bookings, briefings,
rehearsals, exam sessions. Those are genuinely not taught classes and must not be invented
into them.

## 5. Verifying changes — read this before you trust a screenshot

**The in-editor browser preview returns blank/dark screenshots while its pane is hidden, and
reports `window.innerWidth === 0`.** Any layout or `matchMedia` assertion made through it is
meaningless. DOM queries via `javascript_tool` still work; pixels and layout do not.

Use headless Edge over `scripts/lib/cdp.mjs` instead. `withBrowser` gives you `open`,
`evaluate` and a raw `send`, which covers:

| need | CDP call |
| --- | --- |
| real widths (320 / 390 / 1280) | `Emulation.setDeviceMetricsOverride` |
| light and dark | `Emulation.setEmulatedMedia` + `prefers-color-scheme` |
| actual pixels | `Page.captureScreenshot` |
| simulate the feed being down | `Network.setBlockedURLs` |
| make `window.open` legal | `Runtime.evaluate {userGesture: true}` |

Harness traps that produced **false failures** — all of these were my test being wrong, not
the code:

- `Page.reload` races the next `evaluate` against a document being replaced. To test a clean
  first load: clear `localStorage` in one tab, close it, open a second (storage is per-origin).
- A remote host needs ~2.5s to settle before the first evaluate; localhost needs ~0.6s.
- Do not assert a loading spinner is *visible* — on a warm connection the feed beats the first
  sample. Assert the property that matters (the import form is never shown mid-load).
- **Never hardcode a room or course code in a test.** The daily job publishes a new day and
  your fixture evaporates. `LT.A.1.08` is in the README and has had zero bookings on several
  days. Derive subjects from `data/latest.json` at test time.

## 6. Commands

```bash
node scripts/serve.mjs                 # http://localhost:4173, mirrors Vercel clean URLs
node scripts/check-contrast.mjs        # WCAG AA over the palette, both themes
node scripts/test-handoff.mjs          # bookmarklet handoff, needs a real popup
node scripts/fetch-schedule.mjs        # fetch the schedule locally (needs Chrome/Edge)
gh workflow run daily-schedule.yml     # run the daily job by hand
vercel deploy --prod --yes             # deploy the SITE
```

**Two independent pipelines, and this trips people up:**

- **Data** — the Action commits `data/latest.json`; the viewer reads it from
  raw.githubusercontent. A schedule refresh needs **no deploy**.
- **Site** — Vercel is **not** connected to GitHub. `git push` does **not** deploy. Pushing and
  deploying are separate steps.

## 7. Environment quirks on this machine

- **Vercel CLI needs a hostname shim.** The hostname contains U+2018, which crashes the CLI on
  ByteString header conversion. Preload a file that overrides `os.hostname()` via
  `NODE_OPTIONS=--require <shim>`. The scratchpad path changes every session, so rewrite it.
- **`vercel deploy` intermittently fails with `fetch failed`.** A plain retry works. Same for
  `git push` — GitHub has been unreachable for minutes at a time; retry rather than debug.
- **The daily Action pushes while you work**, so `git push` gets rejected as non-fast-forward.
  `git fetch && git rebase origin/main` — the data commits never conflict with code.
- **Bash-transmitted strings lose non-breaking spaces and collapse `\\`** (Windows argument
  quoting), silently — a `replace()` can no-op while reporting success. The Write tool
  preserves them. Build such literals with `String.fromCharCode`.
- **`.ps1` files must be ASCII-only.** Windows PowerShell 5.1 reads a BOM-less script as ANSI;
  a single em-dash in a string made `install-task.ps1` fail to parse.
- **Store Python silently fails to write files.** Use node or the Write tool.
- CRLF: the repo checks out CRLF, so multi-line `String.includes()` patches with `\n` fail.
  Split on `/\r?\n/` and patch line-wise, or use the Edit tool.

## 8. History worth knowing

- The project originally assumed the schedule was behind a SIM login and built a browser
  scraper plus a scheduled task on this laptop. **There was never a login** — the page and its
  API are public. All of that machinery was retired.
- But the API only answers browsers: the WAF returns **464** to `curl` regardless of headers.
  That is the only reason a browser is launched to perform one GET.
- The API sends no CORS header, so the viewer cannot call it directly. Hence the published
  file, and hence the bookmarklet running *on* the scheduling page.
- The DOM scraper (54 paginated pages, an auto-advance race to defend against, nbsp-separated
  time strings) is gone. If you find notes about pagination defences, they are historical.

## 9. Open ideas, not started

- Multi-day support. `schedule_dates` is an array but everything treats today as the only day;
  `start_min` has no date component. This is the largest real gap.
- A "free right now" shortcut on the landing page.
- Filter state in the URL, so a preset view can be shared.
- Capacity-aware filtering (`room_description` carries `(60pax)`).
