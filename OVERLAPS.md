# Overlaps (house standard 27)

Where Celebrity Crusher and another app, or the hub, hold the same data, do the same job, or could
feed each other. A register for the maker to choose from: an entry is not permission to build
anything. Format and states as in `../CoworkSyncHub/OVERLAPS.md`.

Reviewed: 2026-11-20

- [idea] CelebrityCrusher + Run315 + GymTracker + BlackMirrorBikeRide: each takes in the same Garmin and Strava activities its own way (here: Strava OAuth under `node server.mjs`, CSV/GPX import, and its own `tools/garmin-sync.py` watched folder; Run315 has `garmin-export.py` / `garmin_fetch.py`) -> read Run315's `shared-activities.json` from the shared Drive folder once it exists, and retire `tools/garmin-sync.py` (same entry as the hub register)
- [idea] CelebrityCrusher + Run315: the same running engine written twice — race prediction (Riegel with a fitted exponent, Daniels VDOT, VO₂max), Banister fitness/fatigue (CTL/ATL/TSB), age grading and the Eddington number (Run315: `js/derive.js`, `js/lib/banister.js`, `js/ingest.js`, `js/pages/records.js`; here: `lib/engine.js`) -> one engine as a shared module, or Run315 publishes its numbers in a `shared-fitness.json` (predictions with bands, CTL, VO₂max, PBs) that Celebrity Crusher reads to judge feats
- [idea] CelebrityCrusher + Run315: a goal here (feat + date) builds a week-by-week plan with a calendar export; Run315 has its own plans and adherence (`js/lib/plan.js`, `js/lib/adherence.js`) -> "train for this feat" hands the goal to Run315 as a plan target instead of a second planner
- [idea] CelebrityCrusher + GymTracker: strength feats (reps, bodyweight-relative loads) are logbook-only here because no watch proves a barbell; GymTracker records the lifts -> read GymTracker's best lifts (a shared file it owns) to judge those feats
- [idea] CelebrityCrusher + GymTracker + BodybuildingProgressCoach + MacroTrackro: this app asks for weight, birth year and sex (strength targets, age grading) that the body apps already keep -> read `shared-body.json` once it exists instead of asking again
- [idea] CelebrityCrusher + hub: feats crushed, and the dated milestones timeline, are achievements -> the hub's character sheet or daily brief reads them from this app's Cowork brief (`BRIEF.md` / `brief.json`, already written)
