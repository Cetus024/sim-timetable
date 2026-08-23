# SIM Campus Timetable

Scrape the SIM campus scheduling page into JSON, then browse it as a real timetable —
filter by block / floor / room, or flip to **availability** mode to find rooms that are
actually free between bookings.

Two pieces:

| Piece | Where it runs | Why |
| --- | --- | --- |
| `scraper/scrape.js` | your browser, on the scheduling page | the schedule is behind your login, so a server can't fetch it |
| the static site (`index.html`, `viewer.html`) | Vercel | just serves the scraper and renders the JSON locally |

Nothing is uploaded. The site is static; the viewer parses your JSON in the browser and
keeps it in `localStorage` only.

## Using it

1. Open the SIM scheduling page and log in.
2. Get the scraper from the site's home page — **Copy scraper to clipboard**, or drag the
   bookmarklet to your bookmarks bar.
3. On the scheduling page, paste it into the DevTools console (`F12`) and press Enter, or
   click the bookmarklet.
4. It pages through the whole table and gives you `sim-timetable.json` (downloaded, and
   copied to your clipboard).
5. Open `/viewer`, drop the JSON in.

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
index.html            landing page — get the scraper (copy / download / bookmarklet)
viewer.html           import JSON, render the timetable, export standalone HTML
assets/timetable.js   parsing + rendering, shared by the viewer and the export
assets/styles.css     shared styles (light + dark)
scraper/scrape.js     the console script, served as text so the page can copy it
vercel.json           static hosting config (clean URLs)
```

## Deploying

Static — no build step.

```bash
vercel --prod
```
