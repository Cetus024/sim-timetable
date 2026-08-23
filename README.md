# SIM Campus Timetable

Scrape the SIM campus scheduling page into JSON, then browse it as a real timetable —
filter by block / floor / room, or flip to **availability** mode to find rooms that are
actually free between bookings.

| | |
| --- | --- |
| **Live site** | https://sim-timetable.vercel.app |
| **Viewer** | https://sim-timetable.vercel.app/viewer |
| **Repo** | https://github.com/Cetus024/sim-timetable |
| **Vercel project** | https://vercel.com/cetus024s-projects/sim-timetable |

**Docs:** [PRD](docs/PRD.md) (problem, scope, user stories) ·
[Architecture](ARCHITECTURE.md) (diagram, components, boundaries) ·
[Technical design](docs/TECHNICAL-DESIGN.md) (contracts, algorithms, failure modes)

Two pieces:

| Piece | Where it runs | Why |
| --- | --- | --- |
| `scraper/scrape.js` | your browser, on the scheduling page | the schedule is behind your login, so a server can't fetch it |
| the static site (`index.html`, `viewer.html`) | Vercel | just serves the scraper and renders the JSON locally |

Nothing is uploaded. The site is static; the viewer parses your JSON in the browser and
keeps it in `localStorage` only.

## Using it

1. Drag the bookmarklet from the [home page](https://sim-timetable.vercel.app) to your
   bookmarks bar. Once, ever.
2. Open the SIM scheduling page, log in, and click the bookmarklet.
3. It opens the viewer, pages through the whole table, and hands the data straight over
   by `postMessage`. No files, no pasting.

Prefer the console? Copy the script from the home page and paste it into DevTools (`F12`)
on the scheduling page instead — same result. If the viewer tab gets popup-blocked, the
scraper falls back to downloading `sim-timetable.json` for you to drop into `/viewer`.

Optionally hit **Export standalone HTML** in the viewer for a single self-contained file
that works offline with no dependency on this site.

## Views

- **Table** — every event, sorted by end time, with the block/floor/room parsed out.
- **Availability** — grouped per room as an alternating BUSY / FREE timeline. Gaps between
  bookings become FREE; anything after the last booking is FREE and open-ended (the schedule
  only shows so far ahead). "Free after" / "Free before" filter to rooms with a free slot
  starting in that window.

## Scraper notes

The scheduling page auto-advances its own pagination on a timer, which used to make a naive
scrape skip pages. The scraper defends against that:

- resets to page 1 before starting (in case the page already drifted);
- reads MUI's `"8-14 of 112"` label to learn the real total;
- after each of its own clicks, checks the visible range advanced by about one page — a
  bigger jump means the site's timer fired in between, and it flags the result;
- dedupes rows, and compares the unique count against the site's reported total.

If the run was suspect, the payload carries `"incomplete": true` and the viewer shows a
warning. Just re-run it.

### JSON shape

```json
{
  "version": 1,
  "source": "https://…",
  "scraped_at": "2026-08-23T10:00:00.000Z",
  "site_total": 112,
  "incomplete": false,
  "rows": [
    {
      "start": "9:00 AM", "end": "12:00 PM",
      "start_min": 540, "end_min": 720,
      "block": "B", "floor": 5, "room": "LT.B.5.01",
      "event": "Free Access", "status": "UPCOMING"
    }
  ]
}
```

The viewer also accepts a bare array of rows, and re-derives `block`/`floor`/times if a row
only has the raw scraped fields (`time`, `event`, `building`, `room`, `status`).

## Layout

```
index.html                  landing page — get the scraper (copy / download / bookmarklet)
viewer.html                 import JSON, render the timetable, export standalone HTML
assets/timetable.js         parsing + rendering, shared by the viewer and the export
assets/styles.css           shared styles (light + dark)
scraper/scrape.js           the console script, served as text so the page can copy it
sample/                     sample data, so the site demos without a real scrape
scripts/serve.mjs           local static server mirroring vercel.json's clean URLs
scripts/test-handoff.mjs    end-to-end test of the bookmarklet handoff (headless Edge)
vercel.json                 static hosting config (clean URLs)
ARCHITECTURE.md             system diagram, components, trust boundary
docs/PRD.md                 problem, goals, non-goals, user stories
docs/TECHNICAL-DESIGN.md    data contracts, algorithms, failure modes
```

## Developing

No dependencies and no build step. To run it locally:

```bash
node scripts/serve.mjs
```

Then open http://localhost:4173. The server mirrors Vercel's clean-URL resolution, so
`/viewer` behaves the same locally as in production.

The one path worth testing automatically is the cross-tab handoff, since it needs a real
popup and a real user gesture:

```bash
node scripts/test-handoff.mjs
```

It drives headless Edge over CDP and checks both that the viewer accepts a payload from the
tab that opened it, and that it ignores one from anything else.

## Deploying

Static — no build step.

```bash
vercel deploy --prod --yes
```

> The Vercel project is **not** connected to GitHub, so `git push` does not deploy.
> Pushing and deploying are separate steps; run the command above after pushing.
