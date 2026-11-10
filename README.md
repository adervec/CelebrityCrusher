# Celebrity Crusher

The Celebrity Endurance Ledger, made operational. 389 celebrity fitness feats with
machine-comparable targets, judged against your own Strava and Garmin data: which ones
you have already beaten, which ones your current fitness would clear today, and which
ones are a training plan rather than a fantasy.

The original artifact (`celebrity-marathon-ledger.html`) is still here and unchanged —
it is the source the dataset was generated from.

It runs two ways from the same source tree:

```bash
node server.mjs          # http://localhost:8787 — SQLite, live Strava/Garmin OAuth
node test.mjs            # 52 checks, no framework
```

...or as an installable offline PWA on GitHub Pages, with no server at all. See
**Deploying to GitHub Pages** below.

Node 22.5+ (uses `node:sqlite`). **Zero dependencies** — no `npm install`, no lockfile,
no build step. `package.json` exists only to declare `"type": "module"`.

First run has no data. Either connect Strava, import a Garmin file, or hit **Seed demo
data** on the Connect tab for 18 months of a plausible 3:2x marathon build.

## The six views

| View | What it does |
|---|---|
| **Dashboard** | Verdict counts, fitness/fatigue, estimated VO₂max, acute:chronic load ratio, marathon projection with a confidence band and a second opinion, where you sit between two names on the table, and a pinned rival to chase. Two lists: in range but unclaimed, and nearest misses. **Share card** saves the headline numbers as a PNG. |
| **The Ledger** | All 389 feats, filterable by category, discipline, verdict and difficulty; exportable as CSV. Expand a row for the gap, the head-to-head, the plan and the paperwork. |
| **Queue** | Ordered attempt list with status, target dates, reorder, and suggestions. |
| **Goals** | Feat + date → required pace, peak weekly volume, weeks needed vs weeks remaining, margin, and a full week-by-week build with 3:1 loading and a taper, exportable to your calendar as `.ics`. |
| **Analytics** | Pace curve versus every timed feat, rolling-window capacity, verdict spread by category, PB table, a milestones timeline (the day each feat fell), your Eddington numbers, and a three-year crush forecast with projected dates. |
| **Connect** | Strava OAuth, Garmin OAuth, file import or a watched folder, cloud sync, sync log, athlete settings, reading font, JSON backup and restore, and **Erase everything**. |

## Deploying to GitHub Pages

Push the repo, then **Settings → Pages → Source: Deploy from a branch →
`main` / `/ (root)`**. That is the whole deployment: no build, no Actions workflow, no
`docs/` folder. Every path in the app is relative, so it works under
`username.github.io/CelebrityCrusher/` as happily as at a domain root.

Open it and Chrome or Edge offers **Install** in the header (Safari: Share → Add to Home
Screen). Installed, it launches standalone, works on a plane, and keeps its data in the
browser.

**What changes without a server.** `public/local.js` answers the same routes in the tab:
same engine, same 389 feats, same verdicts, with one localStorage blob instead of SQLite.
Everything works except live OAuth sync — both Strava and Garmin token exchanges need a
client secret, which no static page can hold. Bring history in as a file instead:

- **Strava** → Settings → My Account → *Download or Delete Your Account* → Request
  Archive, then import the `activities.csv`.
- **Garmin** → Activities → Export CSV, or any single `.gpx`.

Run `node server.mjs` locally whenever you want one-click Strava sync; the SQLite copy and
the browser copy both read and write the same backup JSON, so moving between them is an
export and an import.

Storage lives in that browser profile only. Clearing site data wipes it — take a backup
from the Connect tab. The service worker is cache-first against a versioned cache: bump
`VERSION` in `sw.js` when you ship a change, or clients keep the copy they have.

## Connecting data

**Strava** — create an app at <https://www.strava.com/settings/api> with callback domain
`localhost`, put the id and secret in `.env`, restart, click Authorise. Sync pulls
activities plus Strava's measured best efforts for runs (capped at 15 detail calls per
sync to stay inside the 100-per-15-minutes rate limit).

**Garmin** has three doors:

1. **File import** (works today, nothing to register): Garmin Connect → Activities →
   Export CSV, or any `.gpx` from *Export Your Data*. Drop it on the Connect tab.
2. **Watched folder** — the hands-off one, the same shape of answer GymTracker315 uses for
   biometrics. A browser cannot read Garmin Connect directly: no public per-user read API,
   the internal endpoints are not CORS-enabled and sit behind SSO. So the data arrives as a
   file, and the app watches the folder it arrives in:

   ```bash
   py -m pip install garminconnect
   set GARMIN_EMAIL=you@example.com
   set GARMIN_PASSWORD=...
   py tools/garmin-sync.py 120 C:/GarminSync/crusher-garmin-activities.json
   ```

   Then Connect tab → **Garmin — watched folder** → *Pick folder*. The app remembers it
   (the directory handle lives in IndexedDB) and re-imports the newest matching file on
   every load, always merging. Put that script on a schedule and the ledger keeps itself
   current. The JSON carries activities plus your Garmin personal records, which land as
   *measured* best efforts — worth more to the projection than any average pace.

   That script uses the community `garminconnect` library against Garmin's private
   endpoints with your own login. It may conflict with Garmin's terms, and the endpoints
   move. Your data, your machine, your risk.
3. **Partner API** (`GARMIN_CLIENT_ID`/`SECRET`): the Garmin Connect Developer Program
   Activity API over OAuth2 PKCE. Requires an approved partner account. Endpoints are
   env-overridable because they live behind the partner portal and move.

If your watch already syncs Garmin → Strava, one connection covers both: the same
session arriving twice is collapsed by `sport + 10-minute bucket + distance`.

`.fit` files are not parsed. CSV and GPX cover the export paths that matter; add FIT if
you actually need per-second streams.

## Cloud sync

Connect tab → **Cloud sync**. Two targets, same interface, ported from Tachyread:

- **Local folder** — a File System Access directory handle. Point it at your Google Drive,
  Dropbox or OneDrive *desktop sync folder* and you have cloud sync with no accounts and no
  API keys.
- **Google Drive** — straight into the private `appDataFolder` over Google Identity
  Services. Zero setup on `adervec.github.io`, which is registered against the built-in
  OAuth client ID (an identifier, not a secret — and the app refuses it on any other
  origin). A fork supplies its own client ID in the same card.

What travels is the backup payload: queue, goals, logged attempts, imported activities, and
your athlete row. Not tokens, not Strava or demo activities — those re-sync from the
provider. The bytes go from your browser to your storage; no server of ours sees them.

Sync is read-merge-write, so two devices converge instead of the last one winning, and
restoring the same file twice is a no-op. Tick **keep synced automatically** and it pulls
once on load and pushes a few seconds after each change.

## On this device

Every app on `adervec.github.io` shares one browser origin, so this one keeps to its own
keys (`crusher.v1`, `crusher.sync`, and the `crusher-fs` IndexedDB for remembered
folders). **Erase everything** on the Connect tab asks first, then removes those, disconnects
cloud sync and drops this app's rows from the portal's shared lists — other apps keep
theirs, and the copy in your Drive or sync folder is not touched. Under `node server.mjs`
the same button empties the SQLite file.

Real activity — an imported session from the last four weeks, or a logged attempt — is
appended to the maker portal's shared `portal-activity` list as
`[unixSeconds, "CelebrityCrusher", "cardio", minutes ÷ 10]`. The demo athlete reports nothing.

No third-party requests: the fonts (Atkinson Hyperlegible, Fraunces, Newsreader, JetBrains
Mono) are self-hosted on `adervec.github.io`. The only other hosts are the ones you connect:
Google for Drive sync, Strava from the local server.

A calendar day is your local day. Activities, plans, milestones and date fields all bucket
by the local date the session started, so a 21:30 run belongs to that evening.

## How a verdict is decided

| Verdict | Meaning |
|---|---|
| **Crushed** | Your own recorded data already clears it, or you logged a verified attempt. |
| **In reach** | Current fitness projects past it. It is now a logistics problem. |
| **Close** | Within 10%. |
| **Trainable** | Reachable inside three years at *your measured* rate of improvement. |
| **Far** | Beyond that. |
| **Logbook** | No wearable proves it (BJJ gold, the Boat Race, a breath-hold). Log it with evidence. |
| **Apart** | Terry Fox. Not a target, and the engine refuses to treat it as one. |

The performance model, in order of how much it matters:

- **Riegel extrapolation** `t₂ = t₁(d₂/d₁)^k` off your best efforts, with **k fitted to
  your own curve** from two well-separated efforts (clamped 1.01–1.25) instead of the
  textbook 1.06.
- **Extrapolation penalty**: 3% per doubling beyond the reference distance, plus 2% for
  references that were training rather than racing. Without it a hard 12 km tempo
  masquerades as marathon fitness.
- **Ultra exponent**: past 42.195 km the exponent rises toward 1.18. Your 10k shape says
  nothing useful about hour eleven.
- **Stretch penalty** for swim and bike, where there are no measured race distances:
  10% per doubling beyond your longest actual session, ×1.15 for open water. This is why
  a 2 km pool swimmer is not "one good day" from the Channel.
- **Beyond your longest run**: 8% per doubling past the furthest you have actually run.
  A 32 km longest run does not make you a 161 km runner with a rounding error.
- **Vertical is time**: mountain feats carry their published ascent, charged at about
  5 seconds per metre climbed (Naismith's rule, runner's edition). The Barkley is 18,300 m
  of climbing — around 25 hours of vertical before a step of flat running.
- **Course factor** for what a clock cannot see: ×1.5 for navigating the Barkley by map
  and compass, ×1.25 for a Death Valley road surface in July, ×1.1 for two nights out at
  altitude. Editorial, documented in the data, and better than pretending they are tracks.
- **Effort-equivalent kilometres** for cross-sport windows: a cycled kilometre counts 0.3,
  a swum one counts 4. Otherwise a 125 km bike day "beats" a 75 km swimrun championship.
- **Open-water tax** of 1.35× on unsanctioned swim distances, because a pool is not a
  tidal bay at 13°C.
- **Rolling windows** for multi-day feats: best actual N-day block, and a projection from
  current weekly volume discounted for durability (0.85 at a week, 0.70 at a month, 0.5
  beyond four). Streak feats count consecutive days and refuse to extrapolate at all —
  a streak is a habit problem, not a fitness one.
- **VO₂max**, estimated from your own race pace via the Daniels & Gilbert VDOT equations,
  taking the best of 5 km, 10 km and half marathon. No mask, no lab, no treadmill test.
- **Confidence bands**: every prediction carries a range that widens when the evidence is
  thin — no measured race efforts, nothing recent, or a distance far past anything you
  have run. A tight ±4% means the data earned it.
- **A second opinion**: between 1500 m and 50 km, the Daniels VDOT of your single best
  effort is inverted for the target distance, with none of the penalties above. It is shown
  next to the projection, and half the disagreement (up to 3 points) is added to the band —
  two models that differ are uncertainty, not a tie to be broken.
- **Calibration against your own races**: log an attempt on a flat timed run with a finish
  time and the model compares it with what it would have predicted from the evidence before
  that date. The median miss, shrunk toward zero by n/(n+1) and clamped to −8%/+12%, scales
  every later projection. One bad day moves it half as far as it wants to.
- **Acute:chronic workload ratio** (7-day load against the 28-day average), the closest
  thing to an injury early-warning that activity data supports. Above 1.5 is where people
  get hurt; below 0.8 is detraining.
- **Capacity is not attendance**: if a feat needs a permit, an entry, a pilot boat or a
  flight to Papua New Guinea, training data can prove you are ready but never that you
  went. Those stay *in reach* with the paperwork named, until you log an attempt.
- **Age grading** (USATF Masters LDR 2025 road tables, single-year factors per sex and
  distance, CC0): every timed feat with a known age gets a head-to-head that pulls both
  performances to the same age. Bryan Cranston's 3:20:45 at 29 is worth 3:32:19 at 44;
  Ed Whitlock's 2:54:48 at 72 survives any adjustment you throw at it. Pick the men's or
  women's table on the Connect tab.
- **Eddington number**: the largest E with E days of at least E km (or miles), counted per
  sport. Like a streak it is counted, never projected — the gap is a number of days.
- **Milestones** are replayed, not stored: the profile is rebuilt as of earlier dates and
  bisected for the first day each crushed feat reads crushed.
- **Banister CTL/ATL/TSB** from a TSS-shaped load (hours × 100 × intensity², HR-based
  when heart rate exists, pace-based when it does not).
- **ETA** compounds your measured improvement rate — predicted marathon now versus six
  months ago — capped at ten years, at which point "far" says it better.

A verified logged attempt always outranks the model.

## The dataset

`data/feats-ledger.json` (83 entries, generated from the original artifact — prose intact),
plus `feats-extra.json` (92), `feats-extra2.json` (95) and `feats-extra3.json` (118).
All plain JSON; edit them and restart.

```jsonc
{
  "id": "gordon-ramsay-marathon-2004",
  "who": "Gordon Ramsay", "title": "Marathon", "event": "London 2004",
  "year": 2004, "age": 37, "discipline": "run", "category": "Marathon",
  "note": "Holding three Michelin stars at Royal Hospital Road…",
  "confidence": "verified",          // verified | reported | self-reported | legend
  "check": { "kind": "run_time", "distance_m": 42195, "seconds": 12637 },
  "tier": 4, "display": "3:30:37"
}
```

Check kinds the engine judges automatically: `run_time`, `swim_time`, `ride_time`,
`row_time`, `swim_distance`, `ride_distance`, `distance_window`, `elev_single`,
`elev_window`, `duration_single`, `streak`, `eddington`, `triathlon`, `vo2max`. Everything else
(`summit`, `breath_hold`, `reps`, `manual`) is a logbook feat.

`duration_single` is only used where a watch was plausibly running. A four-hour
Springsteen show and a Le Mans stint are logbook feats, because otherwise a long bike
ride "beats" them.

Check modifiers: `climb_m` (ascent, charged as time), `factor` + `factor_why` (course
difficulty), `legs` (per-sport composition for multi-discipline windows), `water: "open"`,
`repeats`, `load_ratio` (bodyweight-relative strength targets). Entry flags: `logistics`
(paperwork/cost gate), `reference` (a benchmark line, not a celebrity), `proAsterisk`,
`approx`, `disputed`, `sacred`.

Coverage: 232 machine-checkable, 157 logbook, 272 distinct names, 84 reference lines,
22 categories — from Pheidippides to Russ Cook, by way of Benjamin Franklin's 1726 Thames
swim, Roger Bannister's lunch-hour mile, Junko Tabei, Annie Londonderry circling the globe
on a bicycle she could barely ride, Fauja Singh's marathon at 100, Alexei Leonov bleeding
off his own oxygen to fit back through an airlock, and a violinist who skied for Thailand
at the Olympics.

Reference lines now cover the benchmark shelf as well as the celebrities: UTMB, Western
States, Badwater, Barkley, Spartathlon, Comrades, Marathon des Sables, the Bob Graham and
Ramsay Rounds, Paris–Brest–Paris, RAAM, Tour Divide, Transcontinental, Oceans Seven,
Norseman, HYROX, the 2k erg, VO₂max tiers, Everesting and the run streaks.

## API

Every route below is served by `server.mjs` over HTTP, and by `public/local.js`
in-process when the app runs standalone. Same paths, same payloads, one client. Cloud sync
rides on two of them — `GET /api/backup` up, `POST /api/restore` down — so it works
identically in both modes.

`GET /api/state` (feats, verdicts, head-to-heads, profile, bands) ·
`POST /api/sync/{strava,garmin}` · `POST /api/import/garmin`
`POST /api/demo` · `GET /api/milestones` · `GET /api/plan/:featId?date=` · `POST /api/athlete` (name, birth year,
weight, pinned rival) · `GET /api/backup` · `POST /api/restore`
`POST|PATCH|DELETE /api/queue[/:id]` · `POST|PATCH|DELETE /api/goals[/:id]` ·
`GET /api/goals/:id/plan` · `POST|DELETE /api/attempts[/:id]`

## Honest limitations

- Reported figures are exactly that. Anything not chip-timed is marked `reported`,
  `self-reported` or `legend` in the data and badged in the UI. Alanis Morissette sits in
  a contested drawer for the reason the original ledger gave.
- The Garmin partner API path is written to the documented OAuth2 PKCE flow but has not
  been exercised against a live approved account — the endpoints are env-overridable for
  exactly that reason. The file-import path is tested and works.
- Predicting a marathon from 5k data is a model, not a promise. It now knows how far you
  have actually run and how much a mountain costs, but it still knows nothing about your
  fuelling, the weather, or your stomach at hour nine.
- The course factors and effort-equivalence weights are defensible round numbers, not
  measurements. They live in the data and the engine constants; argue with them there.
- Age grading uses the real 2025 road tables, but one curve — yours — ages both runners,
  because the ledger does not record each celebrity's sex; the nearest tabled distance
  stands in for odd ones; and the tables are for road running, so nothing else is adjusted.
- Calibration is one number for every distance. A marathon that went badly makes your 5 km
  projection slightly slower too.
- Milestone dates assume a crushed feat stays crushed as history accumulates. That holds
  for anything measured; a verdict implied by the model can land a day or two early.
- VO₂max here is inferred from race pace, not measured. It tracks changes well and can be
  several points off in absolute terms.
- Exports (CSV, backup, `.ics`) are generated in the browser and handed to it as a
  download; where the file lands, and whether you are asked first, is a Chrome setting.
- Tokens are stored in plain SQLite. It is a single-user app on your own machine; do not
  expose the port.
- Sync merges add-only. A goal or attempt deleted on one device comes back from the other;
  delete it on both, or restore from a backup file. Tombstones would fix it and are not
  written.
- `tools/garmin-sync.py` talks to Garmin's private endpoints through the community
  `garminconnect` library, because no public per-user read API exists. Unofficial by
  definition, breakable at Garmin's discretion, and possibly against their terms. The
  Strava path uses the official API with your own keys.
- The static build has no tokens to store, because it cannot do OAuth at all. It also has
  no rate limits, no sync log worth reading, and one browser's worth of storage (~5 MB,
  which is thousands of activities). If you outgrow that, run the server.
