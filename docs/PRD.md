# PRD — SIM Campus Timetable

**Status:** shipped (v1) · **Last updated:** 2026-08-23
**Live:** https://sim-timetable.vercel.app · **Repo:** https://github.com/Cetus024/sim-timetable

---

## 1. Problem

The SIM campus scheduling page answers the question *"what is booked in this room?"* — but the
question students actually have is the inverse: **"where can I sit for the next two hours?"**

Getting from one to the other on the official page is tedious:

- Bookings are spread over ~15 pages of a paginated table, seven rows at a time.
- The page **auto-advances its own pagination on a timer**, so you lose your place while reading.
- Block and floor are buried inside room codes (`TR.B.5.14`) and a separate building column;
  there is no way to filter by them.
- Free time is never shown. It only exists implicitly, as the *gaps between* bookings — which
  means holding a dozen rows in your head and doing the subtraction yourself.

So finding an empty room before a 4pm class means scrolling, squinting, and mental arithmetic,
repeated every time.

## 2. Who it's for

**Primary:** a SIM student with a gap between classes who needs somewhere to work — and who
already has a login to the scheduling page. Comfortable enough to paste a line into a browser,
or click a bookmarklet.

**Secondary:** the same student's friends, who want the *result* rather than the tool — hence the
standalone HTML export, which is a single file that can be sent to someone who will never run
the scraper.

**Explicitly not for:** the general public, or anyone without SIM credentials. There is no
account system and no shared server-side data, by design (§5).

## 3. Goals

| # | Goal | How it's met |
| --- | --- | --- |
| G1 | Turn "what's booked" into "what's free" | Availability view — each room as a BUSY/FREE timeline |
| G2 | Make block / floor / room filterable | Parsed out of room codes at scrape time into real fields |
| G3 | Survive the page's auto-advancing pagination | Reset-to-page-1, range checks, dedupe, coverage warning (§6.1) |
| G4 | Keep the whole thing trustworthy with credentials | Nothing leaves the browser; static host, no backend (§5) |
| G5 | Cost nothing to run and not rot | Zero dependencies, zero build step, static hosting |
| G6 | Outlive the site itself | Standalone HTML export works offline, forever |

## 4. Non-goals

- **Booking rooms.** Read-only. This never writes to any SIM system.
- **Accounts, sync, or sharing.** No server means no shared state. Sharing is a file you send.
- **Server-side scraping.** See §5 — a server has no SIM session, and giving it one would mean
  storing the user's credentials somewhere they cannot supervise. Still firmly out.
- **Live data.** Even with the nightly job (§4a) the JSON is a snapshot, not a live feed. The
  viewer states its age rather than pretending otherwise.
- **Mobile-first scraping.** DevTools is desktop; the *viewer* is responsive, the scraper is not.

## 4a. Automatic nightly refresh

Added after v1, once the manual flow was down to a single click and the remaining friction was
having to click at all.

**What it does.** A scheduled task on the user's own machine scrapes at 00:05 local time and
publishes `data/latest.json` to the public repo; the viewer reads that on load. Visiting the site
then shows last night's schedule with no interaction.

**Why it lives on the user's machine, not a server.** It needs an authenticated SIM session.
Running it locally means reusing a browser profile the user signed into once — no password is
stored anywhere, and §5 stays intact. The alternative, credentials in a server env var, is
rejected: it puts the user's login somewhere they cannot watch, and automating a logged-in session
from a server is a good way to breach an acceptable-use policy.

**What it accepts as the price:**

- the machine must be awake — mitigated by running at next logon if 00:05 was missed;
- the saved session expires eventually, and then the job fails until the user signs in again;
- the published data is world-readable, since the repo is public. That was an explicit choice:
  room bookings and course codes, not personal data.

**The rule it must never break:** a failed scrape must never replace good data with nothing. The
job distinguishes "the schedule is empty" from "I am looking at a login page", and on any doubt it
exits non-zero and leaves the previous file untouched.

## 5. The constraint that shapes everything

The scheduling page sits **behind the user's login**. A server has no session and cannot fetch it.

This is not an implementation detail — it dictates the whole architecture:

- The scraper **must** run in the user's own browser, as a console paste or bookmarklet.
- The hosted site can therefore only be a **static** delivery mechanism: it hands you the scraper,
  and renders JSON you bring back to it.
- Consequently there is no backend, no database, and no credential handling anywhere in this
  project — the data never crosses a trust boundary. That is a feature, and it should stay true.

A corollary worth stating: **anything that would require a server is out of scope by default.**
If a future feature seems to need one, re-read this section first.

## 6. User stories

> **US1** — As a student between classes, I want to see which rooms are free after 4pm, so I can
> pick one without reading the whole schedule.
> *Availability view + "Free after" filter.*

> **US2** — As a student, I want to exclude labs and the sports hall, because I can't just walk
> into those.
> *"Exclude contains" filter, comma-separated.*

> **US3** — As a student already near Block B, I want to only see Block B, floor 5.
> *Block and floor dropdowns, populated from the data.*

> **US4** — As someone who scraped once this morning, I want my data still there when I reopen
> the tab, so I don't re-scrape for no reason.
> *`localStorage` persistence, with the scrape timestamp shown so I can judge staleness.*

> **US5** — As someone whose scrape may have silently missed pages, I want to be told, rather
> than quietly trusting a timetable with holes in it.
> *Coverage check against the site's own row count → `incomplete: true` → warning in the viewer.*

> **US6** — As someone who wants to send this to a friend, I want one file that just works.
> *Export standalone HTML — CSS, renderer and data inlined, no network needed.*

> **US7** — As a cautious user, I want to be sure my schedule isn't being uploaded somewhere.
> *Static site, no backend, source is public and readable; stated plainly on the landing page.*

## 7. Functional requirements

### Scraper (`scraper/scrape.js`)

- **FR1** Runs from a DevTools console paste **or** a bookmarklet, with no install step.
- **FR2** Walks every page of the table from page 1 to the end, unattended.
- **FR3** Detects when the page's own timer advanced pagination underneath it (§6.1 / G3).
- **FR4** Parses `time`, `event`, `building`, `room`, `status` into start/end minutes, block, floor.
- **FR5** Deduplicates rows, and compares the unique count against the site's reported total.
- **FR6** Outputs `sim-timetable.json` **both** as a download and to the clipboard — clipboard
  writes can be blocked, so the download is the reliable path and the clipboard is convenience.
- **FR7** Sends no network requests of its own.

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
