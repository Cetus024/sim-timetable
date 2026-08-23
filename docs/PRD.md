# PRD — SIM Campus Timetable

**Status:** shipped (v1) · **Last updated:** 2026-08-23
**Live:** https://sim-timetable.vercel.app · **Repo:** https://github.com/Cetus024/sim-timetable

---

## 1. Problem

The SIM campus scheduling page answers the question *"what is booked in this room?"* — but the
question students actually have is the inverse: **"where can I sit for the next two hours?"**

Getting from one to the other on the official page is tedious:

- Bookings are spread over 54 pages of a paginated table, seven rows at a time.
- The page **auto-advances its own pagination on a timer**, so you lose your place while reading.
- Only *busy* rooms appear at all. A room with nothing booked in it is simply absent, so the
  page cannot answer "what is free today?" even in principle.
- Block and floor are buried inside room codes (`TR.B.5.14`) and a separate building column;
  there is no way to filter by them.
- Free time is never shown. It only exists implicitly, as the *gaps between* bookings — which
  means holding a dozen rows in your head and doing the subtraction yourself.

So finding an empty room before a 4pm class means scrolling, squinting, and mental arithmetic,
repeated every time.

## 2. Who it's for

**Primary:** a SIM student with a gap between classes who needs somewhere to work. They open a
URL; nothing else is required of them.

**Secondary:** the same student's friends, who want the *result* rather than the tool — hence the
standalone HTML export, which is a single file that can be sent to someone who will never run
the scraper.

There is no account system and no login — the underlying schedule is public — so there is
nothing to sign up for and nothing personal involved.

## 3. Goals

| # | Goal | How it's met |
| --- | --- | --- |
| G1 | Turn "what's booked" into "what's free" | Availability view — each room as a BUSY/FREE timeline |
| G2 | Make block / floor / room filterable | Parsed out of room codes at scrape time into real fields |
| G3 | Complete coverage, including rooms with nothing booked | Read the campus API rather than the paginated table |
| G4 | Require nothing of the reader | Daily CI refresh; the site is already current when opened |
| G5 | Cost nothing to run and not rot | Zero dependencies, zero build step, static hosting |
| G6 | Outlive the site itself | Standalone HTML export works offline, forever |

## 4. Non-goals

- **Booking rooms.** Read-only. This never writes to any SIM system.
- **Accounts, sync, or sharing.** No server means no shared state. Sharing is a file you send.
- **Credentialed access of any kind.** Nothing here logs in, stores a password, or touches a
  personal timetable. It reads only what SIM publishes openly.
- **Live data.** Even with the nightly job (§4a) the JSON is a snapshot, not a live feed. The
  viewer states its age rather than pretending otherwise.
- **Mobile-first scraping.** DevTools is desktop; the *viewer* is responsive, the scraper is not.

## 4a. Automatic daily refresh

**What it does.** A GitHub Actions cron reads the campus API at 00:05 SGT and commits
`data/latest.json` to this repo. The viewer fetches that on load, so opening the site shows
today's schedule with no interaction at all.

**Where it runs, and why that changed.** Originally this was a scheduled task on the author's own
machine, because the schedule was assumed to sit behind a SIM login. It does not — the scheduling
site is public. That discovery removed the constraint, so the job moved to CI, and the laptop is
no longer involved. The local task has been unregistered and its scripts deleted.

**What it still costs:**

- GitHub's scheduled runs are best-effort and can be delayed under load, so 00:05 means "shortly
  after midnight", not exactly 00:05;
- the published data is world-readable, since the repo is public. Explicitly chosen: it is room
  bookings and course codes, which SIM already publishes without a login;
- a failed run must never replace good data with nothing. The job refuses to write a payload with
  zero rooms or zero bookings, and a non-zero exit leaves the previous file in place.

## 5. The constraint that shapes everything

**The API only answers browsers.** `scheduling.sim.edu.sg` sits behind a WAF that returns **464**
to plain HTTP clients. `curl` is refused even for the HTML page, with or without a browser
User-Agent, Accept header or Referer — so it is fingerprinting the client, not checking headers.

Every read therefore runs through a real Chromium engine, in CI or locally. This is the single
reason the project launches a browser to perform what is otherwise one HTTP GET.

A second, softer constraint follows from the same server: the API sends no
`Access-Control-Allow-Origin`, so it is same-origin only. The viewer cannot call it from
`sim-timetable.vercel.app`. That is why the data arrives as a published file, and why the
bookmarklet has to run *on* the scheduling page.

> **Superseded:** earlier versions of this document said the schedule sat behind the user's login
> and that a server "cannot reach the page at all". That was wrong — no login is required. The
> browser-side scraper, the credential concerns and the laptop-scheduled job all existed to solve
> a problem that turned out not to exist.

## 6. User stories

> **US1** — As a student between classes, I want to see which rooms are free after 4pm, so I can
> pick one without reading the whole schedule.
> *Availability view + "Free after" filter.*

> **US2** — As a student, I want to exclude labs and the sports hall, because I can't just walk
> into those.
> *"Exclude contains" filter, comma-separated.*

> **US3** — As a student already near Block B, I want to only see Block B, floor 5.
> *Block and floor dropdowns, populated from the data.*

> **US4** — As someone opening the site cold, I want today's schedule already there.
> *Daily CI refresh published to the repo; the viewer loads it automatically, and `localStorage`
> keeps it between visits.*

> **US5** — As someone looking for a quiet room, I want to see the rooms with nothing booked at
> all, not just the gaps in busy ones.
> *The API's full room inventory; rooms with zero activities render as one compact "free all day"
> card — 170 of 326 on a typical day.*

> **US8** — As someone reading at 3pm, I want to know what is busy *now*, not what was upcoming
> when the data was fetched at midnight.
> *Status recomputed from the reader's clock at render time.*

> **US6** — As someone who wants to send this to a friend, I want one file that just works.
> *Export standalone HTML — CSS, renderer and data inlined, no network needed.*

> **US7** — As a cautious user, I want to be sure my schedule isn't being uploaded somewhere.
> *Static site, no backend, source is public and readable; stated plainly on the landing page.*

## 7. Functional requirements

### Reader (`scraper/scrape.js`)

- **FR1** Runs from a DevTools console paste **or** a bookmarklet, with no install step, and is
  also what the CI job evaluates — one implementation, never two.
- **FR2** Reads the campus API in a single request and transforms it locally.
- **FR3** Emits the full room inventory alongside the bookings, so rooms with nothing booked are
  represented rather than absent.
- **FR4** Derives block, floor and minutes-since-midnight; reports an unknown floor as unknown
  rather than guessing from trailing digits.
- **FR5** Refuses to produce a payload with zero rooms.
- **FR6** Hands the payload to the viewer by `postMessage`, falling back to a download plus
  clipboard copy if the viewer tab cannot be opened or never acknowledges.
- **FR7** Sends the data nowhere except the reader's own viewer tab.

### Viewer (`viewer.html`)

- **FR8** Imports JSON by file drop, file picker, clipboard read, or paste-into-textarea.
  Multiple routes because browsers block some of them depending on context.
- **FR9** Accepts the full `{version, rows, …}` envelope **or** a bare array of rows, and
  re-derives missing fields from raw scraped columns.
- **FR10** Rejects malformed input with a specific, readable message — never a blank screen.
- **FR11** Table view: every event, sorted by end time, with block/floor/room as columns.
- **FR12** Availability view: per room, an alternating BUSY/FREE timeline (algorithm in §6.2).
- **FR13** Filters: block, floor, room-contains, exclude-contains, ends-at, free-after, free-before.
  All filters compose, and all are live (no apply button).
- **FR14** Persists the loaded payload to `localStorage`; restores it on reload.
- **FR15** Surfaces `incomplete: true` and the scrape timestamp in the header.
- **FR16** Exports a self-contained HTML file carrying the current filter state and view mode.

### Site

- **FR17** Landing page offers the scraper three ways: copy to clipboard, download, bookmarklet.
- **FR18** The bookmarklet is built from the *same* source file the page displays — one source of
  truth, so the two can never drift.
- **FR19** Sample data loads without a scrape, so the site can be demonstrated or evaluated.

## 6.1 Coverage guarantee (elaborating G3/FR3)

The original failure mode was silent: the page's auto-advance would fire between the scraper's own
clicks, a page's worth of rows would never be read, and the output looked perfectly valid — just
short. A timetable with invisible holes is *worse* than no timetable, because it says "free" where
it means "unknown".

Requirement: the scraper must never claim coverage it cannot demonstrate. It must either (a) verify
its unique row count against the site's own `"8-14 of 112"` total, or (b) mark the payload
`incomplete` and have the viewer say so.

## 6.2 Free/busy semantics (elaborating FR12)

Given one room's bookings sorted by start time:

- A booking whose event is exactly `Free Access` is itself a **FREE** segment.
- Any **gap** between the end of one booking and the start of the next is **FREE**.
- Everything after the last booking is **FREE and open-ended** — rendered as
  *"→ end of visible schedule"*, never as a concrete end time, because the schedule only shows so
  far ahead and inventing an end time would be a lie.

"Free after X" matches rooms having a free segment that *starts* at or after X.

## 8. Success criteria

| Criterion | Target | Status |
| --- | --- | --- |
| Time to answer "where's free after 4pm?" | < 15s from opening the viewer | ✅ two filter fields |
| Scrape coverage | 100% of rows, or an explicit warning | ✅ verified against site total |
| Data leaving the browser | zero bytes | ✅ static host, no backend |
| Runtime dependencies | zero | ✅ no npm packages, no CDN |
| Build step | none | ✅ deploys as static files |
| Standalone export works offline | yes | ✅ verified in an isolated iframe |

## 9. Known limitations

- **Snapshot, not live.** Staleness is shown, not prevented. Re-scrape to refresh.
- **Selectors are coupled to the site's DOM.** A MUI markup change on SIM's side breaks the
  scraper. This is inherent to scraping; the mitigation is that the fix is one file.
- **Open-ended trailing free slots** may be optimistic — the room could be booked just past the
  visible horizon. The wording is deliberately hedged for this reason.
- **`localStorage` is per-browser.** No sync across devices; that would need a server (§5).
- **Filter state isn't persisted** across reloads — only the data is.

## 10. Possible future work

Ordered by value, and each checked against §5 (must not require a server):

1. **Now/next indicator** — highlight what's free *at this moment*, using the client clock.
2. **Shareable URL** — filter state (not data) in the hash, so a link opens a preset view.
3. **Diff two scrapes** — "what changed since this morning".
4. **Multi-day support** — currently the schedule is treated as a single day; `start_min` would
   need a date component. This is the largest real gap.
5. **Capacity / room-type metadata**, if the source page ever exposes it.
