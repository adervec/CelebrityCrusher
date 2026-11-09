#!/usr/bin/env python3
"""
garmin-sync.py - pull your recent Garmin Connect activities and write a small JSON that
Celebrity Crusher imports. Same shape of solution as GymTracker315's biometrics sync.

WHY A SCRIPT?  A browser app cannot read Garmin directly: there is no public per-user read
API, Garmin's internal Connect endpoints are not CORS-enabled and sit behind an SSO login,
and the page has no access to the phone's health store. So the data has to arrive as a
file. This script logs in locally with YOUR credentials (nothing leaves your machine
except the call to Garmin) and writes JSON in the exact shape the app imports.

NOTE (unofficial - read before using): Garmin provides no public per-user read API, so this
relies on the community `garminconnect` library, which talks to Garmin Connect's private,
undocumented endpoints using your login. That may conflict with Garmin's Terms of Service,
and the endpoints can change or be blocked at any time. Use it for your OWN personal data
only, at your own risk, and check Garmin's current terms. The Strava path in this app, by
contrast, uses the official API with your own keys.

----------------------------------------------------------------------------------------
SETUP (once):
    py -m pip install garminconnect          (Windows)   or   pip3 install garminconnect

RUN:
    set GARMIN_EMAIL=you@example.com          (Windows cmd; or use PowerShell $env:)
    set GARMIN_PASSWORD=yourpassword
    py garmin-sync.py [days] [outfile.json]

    - days    : how many days back to pull (default 120)
    - outfile : where to write (default crusher-garmin-activities.json here)

If you omit the env vars it will prompt. If your account uses MFA, enter the code when
asked. Then load it in the app one of two ways:
    - One-off:    Connect tab -> File import -> pick the JSON.
    - Hands-off:  Connect tab -> "Garmin - watched folder" -> Pick folder, pointed at the
                  folder this script writes to. The app remembers it and re-imports the
                  newest matching file on every load. Keep "garmin", "crusher" or
                  "activit" in the filename so the watcher recognises it. Re-run this on a
                  schedule (Task Scheduler / cron) and the app stays current by itself.

OUTPUT SHAPE (also accepted hand-made or from any source):
    {
      "version": 1,
      "activities": [
        {"id": 1234567, "type": "running", "start": "2026-04-01 08:00:00",
         "distance_m": 12500, "moving_s": 3600, "elapsed_s": 3700,
         "elev_m": 120, "avg_hr": 148, "max_hr": 171, "name": "Morning Run"}
      ],
      "bests": [ {"activity_id": 1234567, "distance_m": 5000, "seconds": 1180, "date": "2026-04-01"} ]
    }
`type` is Garmin's own typeKey - the app maps it to run/ride/swim/walk/ski/row. Missing
fields are fine. Activities are deduped by sport + 10-minute bucket + distance, so
re-running this, or also syncing Garmin into Strava, never doubles anything up.

`bests` are Garmin's personal records. They matter more than they look: a MEASURED race
effort anchors the whole prediction curve, where an average pace over a long run does not.
"""
import os
import sys
import json
import datetime

# Garmin's PR "typeId" values for running distances, and what they actually mean.
# Only the ones with an unambiguous distance are worth importing.
PR_DISTANCES = {1: 1609.34, 2: 5000.0, 3: 10000.0, 7: 21097.5, 8: 42195.0}


def _g(d, *keys):
    """First non-None value among keys from dict d."""
    for k in keys:
        if isinstance(d, dict) and d.get(k) is not None:
            return d.get(k)
    return None


def main():
    days = int(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1].isdigit() else 120
    out = sys.argv[2] if len(sys.argv) > 2 else "crusher-garmin-activities.json"

    try:
        from garminconnect import Garmin
    except ImportError:
        print("Missing dependency. Install it with:  py -m pip install garminconnect")
        sys.exit(1)

    email = os.environ.get("GARMIN_EMAIL") or input("Garmin email: ").strip()
    password = os.environ.get("GARMIN_PASSWORD")
    if not password:
        import getpass
        password = getpass.getpass("Garmin password: ")

    print("Logging in to Garmin Connect ...")
    api = Garmin(email, password)
    try:
        api.login()
    except Exception as e:
        # Newer garminconnect versions may need an MFA code or a token store.
        print("Login failed: %s" % e)
        print("If your account uses MFA, run garminconnect's token setup once, or see")
        print("https://github.com/cyberjunky/python-garminconnect for the MFA flow.")
        sys.exit(1)

    today = datetime.date.today()
    start = today - datetime.timedelta(days=days - 1)

    # --- Activities: one range call ------------------------------------------------
    activities = []
    try:
        rows = api.get_activities_by_date(start.isoformat(), today.isoformat())
    except Exception as e:
        print("Could not read activities: %s" % e)
        rows = []
    for a in rows or []:
        # print(a)  # <- uncomment to inspect raw keys if a field comes back empty
        start_s = _g(a, "startTimeLocal", "startTimeGMT")
        if not start_s:
            continue
        atype = (_g(a, "activityType") or {})
        activities.append({
            "id": _g(a, "activityId"),
            "type": atype.get("typeKey") if isinstance(atype, dict) else atype,
            "start": start_s,
            "distance_m": _g(a, "distance") or 0,
            "moving_s": _g(a, "movingDuration", "duration") or 0,
            "elapsed_s": _g(a, "elapsedDuration", "duration") or 0,
            "elev_m": _g(a, "elevationGain") or 0,
            "avg_hr": _g(a, "averageHR"),
            "max_hr": _g(a, "maxHR"),
            "name": _g(a, "activityName") or "",
        })

    # --- Personal records: the measured efforts the prediction curve is built on ----
    bests = []
    try:
        for pr in api.get_personal_record() or []:
            dist = PR_DISTANCES.get(_g(pr, "typeId"))
            secs = _g(pr, "value")
            if not dist or not isinstance(secs, (int, float)) or secs <= 0:
                continue
            day = _g(pr, "prStartTimeGMTFormatted", "prStartTimeGMT")
            bests.append({
                "activity_id": _g(pr, "activityId"),
                "distance_m": dist,
                "seconds": round(secs),
                "date": str(day)[:10] if day else None,
            })
    except Exception as e:
        print("Could not read personal records (continuing without them): %s" % e)

    data = {
        "version": 1,
        "generated_at": datetime.datetime.now().isoformat(timespec="seconds"),
        "activities": activities,
        "bests": bests,
    }
    with open(out, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=1)
    print("Wrote %d activit%s + %d personal record(s) -> %s"
          % (len(activities), "y" if len(activities) == 1 else "ies", len(bests), os.path.abspath(out)))
    print("Now in Celebrity Crusher: Connect tab -> File import (or point the watched folder here).")


if __name__ == "__main__":
    main()
