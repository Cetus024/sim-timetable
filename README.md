# SIM Campus Timetable

The SIM campus schedule, made useful — filter by block, floor and room, or flip to
**availability** mode to see which rooms SIM has actually opened to students today.

| | |
| --- | --- |
| **Live site** | https://sim-timetable.vercel.app |
| **Viewer** | https://sim-timetable.vercel.app/viewer |
| **Repo** | https://github.com/Cetus024/sim-timetable |
| **Vercel project** | https://vercel.com/cetus024s-projects/sim-timetable |

**Docs:** [Handover](docs/HANDOVER.md) (start here in a new session) ·
[PRD](docs/PRD.md) (problem, scope, user stories) ·
[Architecture](ARCHITECTURE.md) (diagram, components, constraints) ·
[Technical design](docs/TECHNICAL-DESIGN.md) (contracts, algorithms, failure modes)

## Using it

Open [the viewer](https://sim-timetable.vercel.app/viewer). That's it — it refreshes itself
daily and already has today's schedule.

Want the very latest state mid-day rather than last night's snapshot? Drag the bookmarklet from
the [home page](https://sim-timetable.vercel.app) to your bookmarks bar, then click it while on
[the scheduling page](https://scheduling.sim.edu.sg/rad/campus.htm?id=SIM). It opens the viewer
and hands today's schedule over in about a second.

**Export standalone HTML** in the viewer gives you a single self-contained file that works
offline and outlives this site.

## Views

- **Open to students** — the list you actually came for: rooms SIM has explicitly marked
  **Free Access** today, with their windows, and anything open *right now* sorted to the front.
  The count moves with the timetable — 24 to 42 rooms on the eight days before this was written.
- **Availability** — every room with bookings, each with a proportional bar of the day and a
  timeline of OPEN (Free Access), BUSY (booked) and GAP (nothing booked, may still be locked)
  segments. All bars share one scale, so two rooms are directly comparable. "Open after" /
  "Open before" narrow to rooms whose Free Access window starts in that range.
- **Table** — every booking, sorted by end time, with block/floor/room broken out. Status is
  computed from your clock, so it says what is busy *now*.
- **One room** (`/room?code=…`) — a single classroom's whole day: whether you can get in right
  now, its Free Access windows, what is booked, and every gap. Room names across the site link
  here; `/room` on its own is a searchable index.
- **One class** (`/class?code=…`) — every session a class has today, which room each is in, and
  the free time between them. Class names link here; `/class` is a searchable index.

Note what is *not* claimed. A room with nothing booked is **not** listed as available: unbooked
means unallocated, and most such rooms (a few dozen labs, plus tutor rooms, foyers and staff
lounges) are simply locked. They appear only as a count, with an explanation. Gaps between
bookings show as **GAP**, not FREE, for the same reason.

## Accessibility

Built against WCAG 2.2 AA. No full conformance audit has been done — but the following are
verified rather than asserted, and re-checkable:

- **Contrast is verified by a script, not by eye.** `scripts/check-contrast.mjs` parses the colour
  tokens back out of `assets/styles.css` and asserts 42 foreground/background pairs across both
  the light and dark themes. It exits non-zero on a regression, so a colour edit that makes text
  unreadable fails immediately rather than months later. (1.4.3, 1.4.11)
- **Nothing means anything by colour alone.** OPEN / BUSY / GAP are words as well as colours, and
  the day bar is `aria-hidden` with every segment it draws also written out beneath it — a bar
  cannot be read aloud. (1.4.1)
- **Keyboard first.** A skip link, a visible focus ring on everything, landmarks, and a heading
  per room so a screen reader can jump between rooms instead of arrowing through hundreds of rows.
  (2.4.1, 2.4.7)
- **Every control has a real label**, checked in the DOM rather than trusted. (1.3.1, 4.1.2)
- **Announcements are restrained.** The result count is announced on a debounce, so typing in a
  filter does not narrate a count on every keystroke. (4.1.3)
- **Reflows at 320px** with no horizontal scrolling, on both pages. (1.4.10)
- Honours `prefers-reduced-motion`, `prefers-contrast` and forced-colours mode.

```bash
node scripts/check-contrast.mjs
```

Two conventions worth knowing before editing the CSS. `--line` (decorative card edges) and
`--line-strong` (anything that identifies a control) are deliberately separate, because only the
latter owes 3:1 under WCAG 1.4.11. And form labels are explicit `for`/`id` pairs — a `<label>`
wrapping a `<select>` pulls the option text into the accessible name, which had "Block" being
announced as "Block All A B C D".

## Where the data comes from

SIM's scheduling page is a front end over its own API:

```
GET https://scheduling.sim.edu.sg/rad/rest/campus?id=SIM
    → buildings[] → rooms[] → activities[]
```

Reading that directly beats scraping the rendered table on every axis — one request instead of
fifty-odd paginated pages, exact timestamps instead of parsed strings, room capacities, and the
full room inventory rather than only the rooms that happen to be busy.

No login is involved; the schedule is public. Two quirks shape everything else:

- **The site's WAF answers `464` to non-browser clients.** `curl` is refused even for the HTML
  page, with or without browser-like headers — it fingerprints the client. So every read runs
  through a real Chromium engine.
- **The API sends no CORS header**, so it is same-origin only. The viewer can't call it directly;
  that is why the data arrives as a published file, and why the bookmarklet runs *on* the
  scheduling page.

### Daily refresh

[`.github/workflows/daily-schedule.yml`](.github/workflows/daily-schedule.yml) runs at 00:05 SGT
(`5 16 * * *` UTC), reads the API in headless Chrome, and commits `data/latest.json`. The viewer
fetches that from `raw.githubusercontent.com` on load and uses it when it is fresher than what
you already have.

GitHub's cron is best-effort, so treat 00:05 as "shortly after midnight". Run it by hand any time
from the repo's Actions tab, or:

```bash
gh workflow run daily-schedule.yml
```

A failed run never publishes: the fetch refuses a payload with zero rooms or zero bookings and
exits non-zero, leaving the previous day's file in place. The viewer always shows the data's age,
so staleness is visible rather than silent.

### JSON shape

```json
{
  "version": 2,
  "source": "https://scheduling.sim.edu.sg/rad/rest/campus?id=SIM",
  "campus": "SIM Campus",
  "scraped_at": "2026-08-24T00:05:00.000Z",
  "schedule_dates": ["2026-08-24"],
  "auto": true,
  "rooms": [
    { "room": "TR.3", "description": "Tutor Room 3", "building": "SIM Campus Block A",
      "block": "A", "floor": null, "activities": 0 }
  ],
  "rows": [
    { "start": "8:30 AM", "end": "11:30 AM", "start_min": 510, "end_min": 690,
      "block": "A", "floor": 1, "room": "LT.A.1.08",
      "event": "COMM3001 - LF01 : Digi Audiences and Analytics - RMIT",
      "status": "UPCOMING", "description": "…", "room_description": "A.1.08 (112pax)" }
  ]
}
```

`activities: 0` marks a room with nothing booked — which is *not* the same as open; see Views
above. Rooms open to students are identified by rows whose `event` matches `Free Access`. The
viewer also accepts a bare array of rows, or older payloads without `rooms`.

## Layout

```
index.html                  landing page — the bookmarklet, and what this is
viewer.html                 loads the feed, imports, persists, exports
room.html                   /room  — one classroom, or a searchable index
class.html                  /class — one class, or a searchable index
assets/timetable.js         parsing + rendering, shared by the viewer and the export
assets/detail.js            renders both detail pages; one implementation, two modes
assets/feed.js              the feed URL and loader, shared by every page
assets/styles.css           shared styles (light + dark, and the contrast tokens)
assets/toast.js             the progress/status toasts
scraper/scrape.js           the ONLY read-and-transform: bookmarklet and CI both run this
scripts/fetch-schedule.mjs  evaluates scrape.js headless; writes data/latest.json
scripts/lib/cdp.mjs         dependency-free Chrome DevTools Protocol client
scripts/serve.mjs           local static server mirroring vercel.json's clean URLs
scripts/check-contrast.mjs  asserts the palette still clears WCAG AA
scripts/test-handoff.mjs    end-to-end test of the bookmarklet handoff
sample/                     sample data, so the site demos without a live fetch
data/latest.json            published daily; read by the viewer
.github/workflows/          the daily job
ARCHITECTURE.md             diagram, components, the constraints that shape it
docs/PRD.md                 problem, scope, user stories
docs/TECHNICAL-DESIGN.md    contracts, algorithms, failure modes
docs/HANDOVER.md            how to pick this up cold in a new session
```

## Developing

No dependencies and no build step.

```bash
node scripts/serve.mjs
```

Then open http://localhost:4173 — the server mirrors Vercel's clean-URL resolution, so `/viewer`
behaves as it does in production.

Fetch the schedule locally (needs Chrome or Edge; override with `BROWSER_PATH`):

```bash
node scripts/fetch-schedule.mjs
```

Two checks are worth running before you push.

```bash
node scripts/check-contrast.mjs    # every colour pair, both themes
node scripts/test-handoff.mjs      # the cross-tab bookmarklet handoff
```

The handoff is the one path that genuinely needs an automated test, because it needs a real popup
and a real user gesture. It drives headless Edge over CDP and checks both that the viewer accepts
a payload from the tab that opened it, and that it ignores one from anything else.

> Verifying UI changes on Windows: the in-editor browser preview returns blank screenshots while
> its pane is hidden, and reports `innerWidth: 0`, which quietly breaks any layout or `matchMedia`
> assertion made through it. Drive `scripts/lib/cdp.mjs` directly instead — it gives you real
> viewport emulation, `prefers-color-scheme` overrides and `Page.captureScreenshot`.

## Deploying

Static — no build step.

```bash
vercel deploy --prod --yes
```

> The Vercel project is **not** connected to GitHub, so `git push` does not deploy the site.
> Data is separate: the daily job publishes `data/latest.json` to the repo, and the viewer reads
> it from there, so a schedule refresh needs no deploy at all.
