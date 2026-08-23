# SIM Campus Timetable

The SIM campus schedule, made useful — filter by block, floor and room, or flip to
**availability** mode to see each room as a busy/free timeline and find somewhere to sit.

| | |
| --- | --- |
| **Live site** | https://sim-timetable.vercel.app |
| **Viewer** | https://sim-timetable.vercel.app/viewer |
| **Repo** | https://github.com/Cetus024/sim-timetable |
| **Vercel project** | https://vercel.com/cetus024s-projects/sim-timetable |

**Docs:** [PRD](docs/PRD.md) (problem, scope, user stories) ·
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

- **Table** — every booking, sorted by end time, with block/floor/room broken out. Status is
  computed from your clock, so it says what is busy *now*.
- **Availability** — each room as an alternating BUSY / FREE timeline. Gaps between bookings are
  FREE; anything after the last booking is FREE and open-ended, since the schedule only covers
  the day. "Free after" / "Free before" narrow to rooms with a free slot starting in that window.
- **Free all day** — the rooms with nothing booked in them at all, in one compact card grouped by
  block. Typically over half the campus, and something the official page cannot show you.

## Where the data comes from

SIM's scheduling page is a front end over its own API:

```
GET https://scheduling.sim.edu.sg/rad/rest/campus?id=SIM
    → buildings[] → rooms[] → activities[]
```

Reading that directly beats scraping the rendered table on every axis — one request instead of
54 pages, exact timestamps instead of parsed strings, room capacities, and crucially the rooms
with **no** bookings, which the table never lists.

No login is involved; the schedule is public. Two quirks shape everything else:

- **The site's WAF answers `464` to non-browser clients.** `curl` is refused even for the HTML
  page, with or without browser-like headers — it fingerprints the client. So every read runs
  through a real Chromium engine.
- **The API sends no CORS header**, so it is same-origin only. The viewer can't call it directly;
  that is why the data arrives as a published file, and why the bookmarklet runs *on* the
  scheduling page.

### Daily refresh

[`.github/workflows/daily-schedule.yml`](.github/workflows/daily-schedule.yml) runs at 00:05 SGT
(`05 16 * * *` UTC), reads the API in headless Chrome, and commits `data/latest.json`. The viewer
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

`activities: 0` in `rooms` is what marks a room free all day. The viewer also accepts a bare
array of rows, or older payloads without `rooms`.

## Layout

```
index.html                  landing page — the bookmarklet, and what this is
viewer.html                 loads the feed, imports, persists, exports
assets/timetable.js         parsing + rendering, shared by the viewer and the export
assets/styles.css           shared styles (light + dark)
scraper/scrape.js           the ONLY read-and-transform: bookmarklet and CI both run this
scripts/fetch-schedule.mjs  evaluates scrape.js headless; writes data/latest.json
scripts/lib/cdp.mjs         dependency-free Chrome DevTools Protocol client
scripts/serve.mjs           local static server mirroring vercel.json's clean URLs
scripts/test-handoff.mjs    end-to-end test of the bookmarklet handoff
sample/                     sample data, so the site demos without a live fetch
data/latest.json            published daily; read by the viewer
.github/workflows/          the daily job
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

The one path worth an automated test is the cross-tab handoff, since it needs a real popup and a
real user gesture:

```bash
node scripts/test-handoff.mjs
```

It drives headless Edge over CDP and checks both that the viewer accepts a payload from the tab
that opened it, and that it ignores one from anything else.

## Deploying

Static — no build step.

```bash
vercel deploy --prod --yes
```

> The Vercel project is **not** connected to GitHub, so `git push` does not deploy the site.
> Data is separate: the daily job publishes `data/latest.json` to the repo, and the viewer reads
> it from there, so a schedule refresh needs no deploy at all.
