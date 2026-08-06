# AD 76 — Live Ward Results Map

Ward-level choropleth map and results table for the **Wisconsin Assembly District 76
Democratic primary**, Dane County, **August 11, 2026**.

Results come from the Dane County Clerk's JSON API, each reporting unit is matched to a
ward boundary from Dane County GIS, and a buildless light-theme frontend (modelled on
FiveThirtyEight) renders the map, legend, summary bar, alder-district scoreboard and
results table.

It ships as **two deployments from one codebase** — a static GitHub Pages build and a
Node server. All the parsing, ward matching, grouping, colour and margin logic lives in
`shared/` and runs identically in both. See [Two deployments](#two-deployments).

---

## Findings you should read before election night

Four things were checked against live sources during the build. Three of them differ
from the assumptions in the original brief, and two change how you should operate the
site on the night.

### 1. A Dane County "precinct" is **not** always one ward

The county publishes results per *precinct*. Verified against the 2024 Partisan
Primary AD76 race (election `168`, race `0031`), which reported **28 precincts
covering 30 wards**:

| County precinct label      | Wards it covers             |
| -------------------------- | --------------------------- |
| `C Madison Wd 016`         | City of Madison ward 16     |
| `T Blooming Grove Wds 1-2` | Town of Blooming Grove 1, 2 |
| `V Maple Bluff Wds 1-2`    | Village of Maple Bluff 1, 2 |

26 of the 28 are 1:1 with a ward; two combine a pair of wards. So "precinct" and
"ward" are **not** interchangeable here, and the code never treats them as such:
every reporting unit resolves to a *set* of wards.

Consequences, all handled explicitly:

- On the map, the two wards inside a combined unit are painted identically, because
  the county publishes one number for them jointly. The detail panel names both wards
  and says "one reporting unit covering 2 wards", so the shared value is visible
  rather than implied.
- In the table, a combined unit is one row labelled `Town of Blooming Grove Wards 1–2`.
- The UI says "ward" throughout, as asked. Where a row is really two wards, it says so.

### 2. AD76 is entirely within Dane County, but **not** entirely within Madison

Checked two ways:

- Dane County GIS `Ward Boundaries` (`AsmDistrict='76'`) returns 31 polygon features →
  **30 distinct wards**.
- The statewide LTSB `WI Assembly Districts (2024)` layer's AD76 extent matches the
  bounding box of those Dane wards to within ~100 m on one edge and <10 m on the
  others. **AD76 does not cross a county line**, so scoping the map to Dane County
  wards truncates nothing.

Municipal makeup — **the district is not Madison-only**:

| Municipality           | Wards | Alder districts        |
| ---------------------- | ----- | ---------------------- |
| City of Madison        | 26    | 2, 4, 6, 12, 15, 18    |
| Town of Blooming Grove | 2     | none — outside Madison |
| Village of Maple Bluff | 2     | none — outside Madison |

Alder districts only exist inside Madison. The table therefore groups Madison wards by
alder district and the other four wards by **municipality**, each with its own subtotal
row. Nothing is forced into an alder district and nothing is dropped.

### 3. `elections.danecounty.gov` blocks datacenter IPs — this affects deployment

The HTML results site sits behind Cloudflare and returns **HTTP 403** to cloud/datacenter
egress IPs. Verified: `elections.danecounty.gov` 403s on every path, while
`www.danecounty.gov` and `api.danecounty.gov` return 200 from the same host.

This matters because a deployed backend *is* a datacenter IP. It is the main reason the
JSON API, not the scraper, is the election-night default — see finding 4.

### 4. The `api.danecounty.gov` deprecation notice is on the **Press** API, not Elections

The brief said this API is deprecated per its own help page. Reading
`https://api.danecounty.gov/Help`, the line *"This is depracated and should no longer
be used. No releases were added here after xx/xx/2019"* sits under the **Press** API
heading. The **Election** API section carries no deprecation notice, and its endpoints
are live and current — `/elections/list` returns elections through the April 2026
Spring Election.

**The JSON API is the election-night default** (`SOURCE_MODE=api`). It is the same
backing data as the HTML pages, it returns structured JSON instead of markup that can
be restyled between elections, and — decisively — it is reachable from the datacenter
IPs where the backend actually runs, while the HTML host is not. The HTML scraper is
fully implemented and kept as a selectable source.

| `SOURCE_MODE`   | Behaviour                                                       |
| --------------- | --------------------------------------------------------------- |
| `api` (default) | JSON API only. What runs on election night.                      |
| `html`          | Scrape `elections.danecounty.gov` only. Fails loudly if blocked. |
| `auto`          | HTML first; on failure log the reason and fall back to the API.  |

The active source is shown in the page footer and at `/api/health`, so you always know
which one produced the numbers on screen.

The API path is verified end to end against real county data (see below). The HTML
parser is not: the build environment is itself a datacenter IP and hits the same
Cloudflare 403, so it could not be exercised against live markup. It is written
defensively (columns located by header text, not by index; race located by heading
match, not nth-child) and is covered by fixture tests for the zero- and
partial-reporting states. If you ever need to switch to it, run
`npm run verify:source` from a normal network first to confirm it against the real
pages and save fixtures.

---

## Verified against real data

```
$ npm run verify:match
Using reference election 168 — 2024 Partisan Primary (2024-08-13)
  race 0031: DEM Representative to the Assembly District 76

  reportingUnits               28
  matchedUnits                 28
  unmatchedUnits                0
  partialUnits                  0
  wardsInLayer                 30
  wardsCovered                 30
  wardsWithoutReportingUnit     0

RESULT: every reporting unit matched, and every AD76 ward is covered.
```

Unmatched detection was confirmed by pointing the pipeline at the 2025 Madison Alder
District 12 primary, which includes `C Madison Wd 026` — a ward outside AD76. It is
reported, not silently dropped:

```
WARN match.no_ward_found {"precinctName":"C Madison Wd 026","reason":"no ward in this
  reporting unit exists in the AD76 GIS layer","parsedWards":[26],...}
```

---

## Two views: ward and alder district

The race is a state assembly primary, but the useful political unit on the night is often
the **alder district** — "are we winning District 12". Both levels are first-class:

- **Ward view** (default) — every ward coloured by its own leader; the table lists wards
  grouped under their alder district with subtotals.
- **Alder district view** — wards are coloured by their *district's* leader and ward
  borders are painted in the fill colour, so each district reads as one shape. The table
  collapses to one row per district.

Above the map, an always-visible **scoreboard** shows who leads each alder district, with
the leader's share and margin, plus a running tally ("Leading in 7 of 8 districts —
Martinez-Rutherford 3 · Castañeda 1 · …"). Clicking a card selects that district on the
map and in the table.

Wards outside Madison have no alder district, so Town of Blooming Grove and Village of
Maple Bluff appear as their own cards and rows — see finding 2.

## What the force refresh button does

Results refresh on a schedule: every **60 seconds** while no ward has reported, dropping
to every **15 seconds** as soon as any ward reports. Both intervals and the switch-over
threshold are config values.

Force refresh skips the wait — it fetches from the county immediately and restarts the
countdown. What it affects depends on the deployment:

| | Static (GitHub Pages) | Server (`npm start`) |
| --- | --- | --- |
| Who gets fresh data | only the browser that clicked | every viewer |
| Countdown reset | only that browser | everyone's, from a shared timestamp |
| Repeat clicks | ignored for 12s per browser | ignored for 12s **globally**, so a crowd clicking at once produces one request to the county |

The button label says which one is in effect ("refreshes this browser" vs "refreshes for
everyone"). On the static build it is a convenience — the timer already does the work.

---

## Two deployments

`shared/` holds every piece of logic that decides what a number means: the precinct-label
grammar, ward matching, grouping, totals, candidate colours and the margin scale. Both
deployments import those same modules, so they cannot disagree about results.

What differs is where the county fetch happens and whether shared state exists.

| | **Static — GitHub Pages** | **Server — `npm start`** |
| --- | --- | --- |
| Hosting | GitHub Pages, free, no infra | any container/VM host |
| County fetch | each browser calls the JSON API directly | backend fetches once per interval |
| Load on the county | one request **per viewer** per interval | **one request total** per interval |
| Map, table, scoreboard, grouping, colours, margins | identical | identical |
| Never-fabricate / not-reporting states | identical | identical |
| Same countdown for every visitor | ✅ derived from the wall clock | ✅ real shared server state |
| Force refresh resets everyone's countdown | ❌ refreshes only the clicking browser | ✅ |
| Debounce protecting the county from a click burst | ❌ per-browser only | ✅ cross-visitor |
| `/api/health`, `/api/logs` | ❌ replaced by inline diagnostics in the footer | ✅ |
| HTML scraper fallback | ❌ (no CORS, and 403 to datacenter IPs) | ✅ via `SOURCE_MODE` |

### How the countdown stays shared without a server

The static build does not start a timer when the page loads. It anchors refreshes to
absolute UTC boundaries of the current interval:

```js
nextRefresh = Math.floor(now / intervalMs) * intervalMs + intervalMs
```

Two browsers opened forty seconds apart therefore compute the *same* next-refresh
instant, which reproduces the "everyone sees the same countdown" property without shared
state. Verified in a browser: two tabs opened seconds apart showed the same countdown.

What genuinely cannot be reproduced is a force refresh that resets *other people's*
countdowns, and a debounce that protects the county across visitors — both require shared
state by definition. The static build does not pretend otherwise: the button reads
"refreshes this browser", and the footer says each visitor reads the county directly.

**If cross-visitor force refresh or single-upstream-request behaviour matters to you, run
the Node server** (`fly.toml` and `render.yaml` are included). Nothing needs rewriting —
it is the same repo.

### Why the browser can call the county at all

`api.danecounty.gov` responds with `Access-Control-Allow-Origin: *` (verified), so browser
JS may call it cross-origin. This is worth stating precisely, because it is *not* true of
the HTML results site, which sends no CORS headers **and** 403s datacenter IPs. The
scraper is therefore server-only, and the static build is API-only.

---

## Stack, and why

| Layer    | Choice | Reason |
| -------- | ------ | ------ |
| Backend  | **Node 20+ / Express**, one long-running process | The brief requires a countdown and a force-refresh debounce that are *shared across all viewers*. That is shared mutable state. A stateless serverless function would need an external KV/Redis just to hold `nextScheduledFetchAt` and the cooldown. One small always-on process holds the poll loop, the cache, the countdown and the debounce natively. |
| Scraping | **cheerio** | Server-side HTML parsing without a browser. The county site needs no JS to render its tables. |
| Map      | **Leaflet, no basemap tiles** | The district is 30 ward polygons; a tile basemap would add a third-party runtime dependency and visual noise for no gain. Ward outlines trace the lakeshore, which is what makes the isthmus recognisable. Leaflet handles touch, pinch-zoom and tap properly. |
| Frontend | **Plain ES modules, no build step** | Nothing here needs a framework or a bundler. `npm start` serves it. Leaflet is served from `node_modules`, so there is no CDN dependency and no external request at runtime. |
| Hosting  | **Any container/VM host** (Fly.io, Render, Railway, a VPS) | Follows from the long-running-process requirement. A Dockerfile is included. |

---

## Running locally

```bash
npm install
npm run fetch:wards      # pulls AD76 ward boundaries into data/ad76-wards.geojson

npm start                # server deployment  -> http://localhost:8080
# or
npm run build:static     # static deployment  -> dist/
npx http-server dist -p 4000
```

`npm run fetch:wards` only needs re-running if ward boundaries change.

Before the county publishes the race, the site runs in its **pre-election state**: real
ward geometry, real candidate names, every ward shaded neutral grey and labelled
"Not yet reporting", and every vote figure `—`. No placeholder numbers exist anywhere
in the payload.

To see it with real results, point it at a past election:

```bash
ELECTION_ID=168 SOURCE_MODE=api npm start
```

---

## Configuration

Everything tunable lives in [`config/default.json`](config/default.json). Create
`config/local.json` to override without touching the default, or use env vars, which
win over both. Nothing below requires a code change.

### Election

| Key | Env | Default | Notes |
| --- | --- | --- | --- |
| `election.electionId` | `ELECTION_ID` | `"194"` | Dane County's **2026 Partisan Primary** (ElectionDate 2026-08-11). Verified live: the AD76 DEM race resolves to race `0065`, 28 reporting units covering all 30 AD76 wards. Set to `null` to force the pre-election state. |
| `election.raceNamePattern` | `RACE_NAME_PATTERN` | `DEM\s+Representative to the Assembly District\s+76\b` | The race is found by matching this against the county's race list, so the race number does not need to be known ahead of time. |
| `election.raceNumber` | `RACE_NUMBER` | `null` | Optional override if pattern matching fails. For election 194 the value would be `0065`. |
| `election.expectedCandidates` | — | 5 names | Used **only** before the county publishes the race, so the legend and table show real structure. Replaced entirely by the county's list on the first successful scrape. Never used as vote data. The county spells the third name `Tony Castaneda`, without the tilde. |
| `source.countyTimeZone` | `COUNTY_TIME_ZONE` | `America/Chicago` | Zone the county's unmarked "last updated" timestamps are published in. Both source paths convert with this, so the reading does not depend on the server's `TZ`. |

### Polling and refresh

| Key | Env | Default | Notes |
| --- | --- | --- | --- |
| `polling.idleIntervalMs` | `IDLE_INTERVAL_MS` | `60000` | Cadence while fewer than `reportingThreshold` wards have reported. |
| `polling.activeIntervalMs` | `ACTIVE_INTERVAL_MS` | `15000` | Cadence once the threshold is crossed. |
| `polling.reportingThreshold` | `REPORTING_THRESHOLD` | `1` | Wards reporting that flips idle → active. |
| `polling.forceRefreshCooldownMs` | `FORCE_REFRESH_COOLDOWN_MS` | `12000` | Server-side debounce on `/api/refresh`. |
| `polling.staleAfterMs` | `STALE_AFTER_MS` | `180000` | Age at which the UI shows the stale-data warning. |
| `polling.retry.*` | — | 4 attempts, 2 s → 20 s | Exponential backoff within a single scheduled attempt. |

All of these can be changed on the night by restarting with a different env var.

### Candidate colours

One place: `config.candidates` in [`config/default.json`](config/default.json), consumed by
[`src/colors.js`](src/colors.js). The map fills, the legend, the table header chips and the
summary bar all read the same assignment.

- **Dina Nina Martinez-Rutherford is locked to Sky Blue `#56B4E9`** by name match, so
  she keeps it regardless of ballot or scrape order, and never consumes a palette slot
  from anyone else.
- Remaining candidates take, in scrape order: Orange `#E69F00`, Bluish Green `#009E73`,
  Reddish Purple `#CC79A7`, Vermillion `#D55E00`.
- Palette is Okabe-Ito derived: safe under deuteranopia, protanopia and tritanopia. No
  yellow (too low-contrast against a white page); no red/green pair carries meaning.
- Write-in lines count toward totals but take a neutral grey, not a hue.
- Wards with no reported data are `#D6D6D6`, distinct from the white page background so
  ward boundaries stay visible.
- The theme is light throughout (no dark mode), styled after FiveThirtyEight: white page,
  hairline grey rules instead of boxes, small uppercase letterspaced mono labels, heavy
  tight-tracked headline sans, and tabular figures so updating numbers never jitter.

If the candidate field changes, edit the config list — that is the whole change.

### Margin encoding

Margin of victory is encoded within the leader's own hue by blending toward the page
background — one shared scale function, `marginStrength()`, used for every candidate:

- margin ≤ `margin.lightestMargin` (10 pts) → lightest tint (`minOpacity` 0.18)
- margin ≥ `margin.fullStrengthMargin` (50 pts) → full strength
- linear in between

The tint blends toward `margin.blendTarget` (white, matching the page), so a narrow win is
a pale wash of the winner's colour and a landslide is the colour at full strength.

---

## API

| Endpoint | Method | Purpose |
| -------- | ------ | ------- |
| `/api/wards.geojson` | GET | Ward geometry. Served independently of results so the map draws immediately and stays drawn if the scrape is failing. |
| `/api/results` | GET | Cached parsed results + shared `schedule` block + colour config. |
| `/api/refresh` | POST | Immediate out-of-schedule scrape. Debounced server-side; returns `429` with `retryAfterMs` when debounced. Resets the shared countdown for **all** viewers. |
| `/api/health` | GET | Last fetch time, success/failure counters, matched vs unmatched ward counts, the full unmatched list. `200` healthy / `503` degraded. |
| `/api/logs` | GET | Recent log tail (`?limit=`, `?level=warn`). Scrape failures and ward-match failures both land here. |

### Checking the pipeline mid-election-night

```bash
curl -s https://your-host/api/health | jq '{status, reporting, unmatched: .matching.unmatched, counters}'
curl -s 'https://your-host/api/logs?level=warn&limit=20' | jq '.entries[]'
```

---

## How the shared schedule works

The backend, not the browser, owns the refresh clock.

- The scheduler keeps `lastSuccessAt` and `nextScheduledFetchAt` as process state and
  ships them with every `/api/results` response, so **every visitor sees the same
  countdown** regardless of when they loaded the page. The client corrects for
  browser/server clock skew using the `serverTime` field.
- The frontend's countdown counts toward the server's timestamp; it does not free-run.
- Clients schedule their next poll just *after* the server's next scheduled fetch, so
  they follow the backend's cadence instead of running an independent timer.
- `/api/refresh` moves `nextScheduledFetchAt` for everyone, not just the caller.
- Repeat force-refresh calls inside `forceRefreshCooldownMs` are rejected with `429`
  and a `retryAfterMs`, so a burst of clicks produces **one** request to the county.
  The clicking tab is told someone else just refreshed, rather than being silently ignored.

Verified with concurrent clients:

```
before force   tab A next=13:35:47.286Z    tab B next=13:35:47.286Z
click 1 -> 200  accepted=True   debounced=False
click 2 -> 429  accepted=False  debounced=True  retryAfterMs=11871
click 3 -> 429  accepted=False  debounced=True  retryAfterMs=11844
click 4 -> 429  accepted=False  debounced=True  retryAfterMs=11817
after  force   tab A next=13:35:48.349Z    tab B next=13:35:48.349Z
```

A failed scrape retries with backoff, then schedules the next cycle normally. It never
throws out of the loop and never blocks the following attempt. If the very first fetch
fails, the site still renders real structure with a visible failure badge rather than a
blank page.

---

## Never-fabricate rules

These are enforced in code and pinned by tests:

- A ward that has not reported has `votes: null`, `reported: false`, no percentage and
  no colour. It is never a row of zeroes.
- Blank and dash cells parse to `null`, never `0`. `parseVotes('0') === 0` and
  `parseVotes('') === null` are different things.
- Percentages are computed only from numbers the county actually published.
- "0 of 28 wards reporting" is a valid, fully-rendered state, not an error.
- Every AD76 ward always appears in the table, even when no reporting unit covers it —
  as an explicit "Not yet reporting" row.
- A ward that fails to match the GIS layer is logged and surfaced at `/api/health`,
  never dropped.

---

## Tests and verification tools

```bash
npm test                 # parser, null-vs-zero, colour assignment, margin scale
npm run verify:match     # ward matching against real county data; lists every gap
npm run verify:source    # fetch live HTML, save fixtures, print what the parser found
```

`verify:source` requires a non-datacenter IP (see finding 3). It exits `2` with an
explanation if Cloudflare blocks it.

---

## Deployment

### GitHub Pages (static)

`.github/workflows/pages.yml` builds `dist/` and deploys on every push to `main`.

**One-time manual step:** at **Settings → Pages**, set **Source** to **“GitHub Actions”**.

> ⚠️ Do **not** pick “Deploy from a branch → main”. That publishes the *repository* through
> Jekyll, and since there is no `index.html` at the repo root (the app lives in `public/`
> and is built into `dist/`, which is not committed), Jekyll renders `README.md` as the
> site. The symptom is a page titled “AD 76 — Live Ward Results Map | Ad76” with
> `<meta name="generator" content="Jekyll">`, and `app.js` / `styles.css` /
> `runtime-config.json` all returning 404. Branch mode also spawns a competing
> “pages build and deployment” run that overrides this workflow's deployment.
> “GitHub Actions” is the only correct source; there is no branch or folder to choose
> after selecting it.
>
> After selecting it, GitHub offers two starter-workflow cards — **“GitHub Pages Jekyll”**
> and **“Static HTML”** — each with a *Configure* button. **Ignore both.** They add a new
> workflow file that would compete with `.github/workflows/pages.yml`, which already
> builds and deploys this site. Nothing else needs configuring: the next push to `main`
> deploys.

Enabling Pages cannot be automated from the workflow — a workflow's default
`GITHUB_TOKEN` is not allowed to create a Pages site (`configure-pages` fails with
"Resource not accessible by integration"), and doing it via the API needs a PAT with
`repo` scope. Once the source is set, every push to `main` deploys with no further
intervention.

To point it at the real primary, either set `election.electionId` in
`config/default.json` and push, or add an `ELECTION_ID` repository variable
(**Settings → Secrets and variables → Actions → Variables**) and re-run the workflow —
no code change needed. The workflow also accepts an election id via
**Actions → Deploy to GitHub Pages → Run workflow**.

Read [Two deployments](#two-deployments) first: the static build cannot do a
cross-visitor force refresh, and every viewer polls the county directly.

### Server (full fidelity)

Any host that runs a container or a long-lived Node process.

```bash
docker build -t ad76 .
docker run -p 8080:8080 -e ELECTION_ID=<id> ad76
```

Ready-made configs are included for the two most common one-command hosts:

```bash
# Fly.io
fly launch --no-deploy --copy-config    # uses fly.toml
fly secrets set ELECTION_ID=<id>
fly deploy

# Render — push the repo, then New > Blueprint (uses render.yaml),
# and set ELECTION_ID in the dashboard.
```

Set at minimum:

```
ELECTION_ID=<the August 11 2026 primary id>
PORT=8080
```

`SOURCE_MODE` already defaults to `api`. `data/ad76-wards.geojson` is committed, so the
image needs no GIS access at runtime.

> **Run exactly one instance.** The refresh countdown and the force-refresh cooldown are
> shared state held in process memory — that is what makes every visitor see the same
> timer and a click burst produce one upstream request. Two instances means two
> countdowns and two cooldowns. Both included configs pin the instance count to 1. If
> you ever need to scale out, move `nextScheduledFetchAt` and `lastForceRefreshAt` in
> `src/scheduler.js` into Redis first.

### Pre-flight checklist

Do these **before** election night, not during it:

1. **Find the election id.** Check `https://elections.danecounty.gov/election-dates`
   for the August 11 2026 primary, or
   `curl -s https://api.danecounty.gov/api/v1/elections/list | jq 'sort_by(.ElectionDate) | .[-3:]'`.
   As of this build the newest published election is `190` (April 7 2026); ids advance
   by roughly 2–5 per election, so expect something in the low 190s. **Do not guess** —
   the app renders its pre-election state safely until you set a real one.
2. **Run `npm run verify:match -- <electionId>`** once the race is posted, and confirm
   zero unmatched units. This exercises the live API path end to end.
3. **Confirm the candidate list** matches `config.election.expectedCandidates`, and that
   Martinez-Rutherford resolves to `#56B4E9` in the legend.
4. **Check `/api/health` returns `status: "ok"`** from the deployed host, with
   `source.activeMode: "api"` and `matching.unmatched: []`.
5. **Optional** — if you want the HTML scraper as a live fallback, run
   `npm run verify:source -- <electionId>` from a non-datacenter network to confirm the
   parser against real markup, then set `SOURCE_MODE=auto`.

---

## Project layout

```
config/default.json       all tunable values, documented inline
src/config.js             config load + env overrides
src/logger.js             logging with an in-memory tail for /api/logs
src/match.js              Node wrapper binding shared/match.js to the logger
src/colors.js             Node wrapper binding shared/colors.js to config
src/normalize.js          Node wrapper binding shared/normalize.js to config + wards
src/scheduler.js          shared countdown, backoff, force-refresh debounce
src/server.js             Express routes
src/sources/html.js       elections.danecounty.gov scraper (selectable)
src/sources/api.js        api.danecounty.gov JSON (election-night default)
src/geo/wards.js          ward GeoJSON loading and indexing
scripts/fetch-wards.mjs   pull ward boundaries from Dane County GIS
scripts/verify-match.mjs  ward-matching verification
scripts/verify-source.mjs live HTML fetch + parse report
scripts/build-static.mjs  builds dist/ for GitHub Pages
shared/                   logic used by BOTH deployments (pure ESM, no Node built-ins)
  precinctName.js           county precinct label -> municipality + ward numbers
  wardIndex.js              ward GeoJSON -> indexed wards
  match.js                  explicit ward matching; reports every gap
  colors.js                 candidate colours + shared margin scale
  normalize.js              raw fetch -> frontend payload; never-fabricate rules
  countyApi.js              Dane County JSON client (runs in Node and the browser)
  schedule.js               cadence + wall-clock countdown for the static build
public/                   frontend (no build step)
  pipeline.js               picks server-backed or browser-direct data path
data/ad76-wards.geojson   committed ward boundaries
.github/workflows/pages.yml  builds and deploys the static site
```

## Data sources

- **Results** — Dane County Clerk. `https://api.danecounty.gov/api/v1/elections`
  (election-night default); `https://elections.danecounty.gov` scraper available via
  `SOURCE_MODE=html` or `auto`.
- **Ward boundaries** — Dane County GIS, `DaneCountyBase/MapServer/18` "Ward Boundaries",
  filtered `AsmDistrict='76'`. Carries `AldDistrict`, so alder-district grouping comes
  from the county's own attribute rather than a hand-maintained lookup.
- **District boundary check** — LTSB `WI Assembly Districts (2024)`, used to confirm
  AD76 does not cross county lines.
