// The crushing engine: turn a pile of activities into a fitness profile, then
// judge every feat against it. Pure functions, no I/O, so test.mjs can hammer it.

import { AGE_GRADE } from './agegrade.js';

export const DAY = 86400;

// A calendar day is the user's LOCAL day: a 21:30 run in São Paulo belongs to that evening,
// not to tomorrow in UTC. Day numbers below count local dates (the local Y-M-D as if it were
// UTC midnight), so day arithmetic stays integer and a day number formats back to the same date.
const pad2 = n => String(n).padStart(2, '0');
/** Local 'YYYY-MM-DD' of a Date (default: now). */
export const localYmd = (d = new Date()) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
/** Local day number of a unix-seconds instant. */
export const localDay = ts => { const d = new Date(ts * 1000); return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000); };
/** 'YYYY-MM-DD' of a local day number. */
export const dayStr = n => { const d = new Date(n * 86400000); return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`; };
/** Unix seconds of the local midnight that opens a stored 'YYYY-MM-DD'. */
export const dayStart = s => new Date(s + 'T00:00:00').getTime() / 1000;
export const RIEGEL_K = 1.06;               // Riegel's endurance exponent
export const PB_DISTANCES = [400, 800, 1000, 1609, 3000, 5000, 10000, 15000, 16093, 21097.5, 30000, 42195, 50000, 100000, 160934];

export const riegel = (t1, d1, d2, k = RIEGEL_K) => t1 * Math.pow(d2 / d1, k);
export const fmtDur = s => {
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
};
export const fmtPace = (secPerKm) => `${Math.floor(secPerKm / 60)}:${String(Math.round(secPerKm % 60)).padStart(2, '0')}/km`;
export const fmtKm = m => m >= 1000 ? `${(m / 1000).toFixed(m < 100000 ? 1 : 0)} km` : `${Math.round(m)} m`;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

const ENDURANCE_SPORTS = ['run', 'ride', 'swim', 'walk', 'ski', 'row', 'other'];
/** Run-equivalent value of a kilometre in each sport. A 125 km ride is not a 125 km run,
 *  and a kilometre of swimming is worth about four. Rough, but far less wrong than 1:1. */
/** Same sport, same 10-minute start bucket, same distance to ~1% = same session.
 *  Lives here, not in db.js, because the browser backend needs it too. */
export const dedupeKey = a => `${a.sport}:${Math.round(a.start_ts / 600)}:${Math.round((a.distance_m || 0) / 100)}`;

export const EFFORT = { run: 1, walk: 0.75, swim: 4, ride: 0.3, ski: 0.8, row: 1.5, other: 0.5 };
export const effortEquiv = legs => Object.entries(legs || {})
  .reduce((t, [k, v]) => t + v * (EFFORT[k.replace(/_m$/, '')] ?? 0.5), 0);
/** Open water is not a pool: cold, chop, no walls, no black line. */
export const OPEN_WATER_TAX = 1.35;
/** Rolling-window volume decays: nobody holds their best week's daily average for a month. */
const durability = days => days <= 1 ? 1 : days <= 7 ? 0.85 : days <= 31 ? 0.70 : days <= 120 ? 0.58 : 0.5;

/**
 * Build the athlete profile from normalised activities.
 * @param {object[]} activities {sport, start_ts, distance_m, moving_s, elev_m, avg_hr}
 * @param {object[]} bestEfforts {distance_m, seconds, start_ts} — measured segments (Strava)
 * @param {object[]} races {distance_m, seconds, ts} — logged race results, used to calibrate the model
 */
export function buildProfile(activities, bestEfforts = [], now = Date.now() / 1000, athlete = {}, races = []) {
  const acts = [...activities].sort((a, b) => a.start_ts - b.start_ts);
  const runs = acts.filter(a => a.sport === 'run' && a.distance_m > 800 && a.moving_s > 120);

  // --- reference performances: measured best efforts first, then even-pace reads of whole activities
  const refs = [];
  for (const b of bestEfforts) if (b.distance_m >= 1000 && b.seconds > 0) refs.push({ d: b.distance_m, t: b.seconds, measured: true, ts: b.start_ts });
  for (const a of runs) if (a.distance_m >= 3000) refs.push({ d: a.distance_m, t: a.moving_s, measured: false, ts: a.start_ts });

  // Riegel exponent fitted from the athlete's own two strongest, well-separated efforts.
  // ponytail: two-point fit, not least squares. Upgrade if the curve ever looks wrong.
  let k = RIEGEL_K;
  if (refs.length >= 2) {
    const scored = refs.map(r => ({ ...r, v: riegel(r.t, r.d, 10000) })).sort((a, b) => a.v - b.v);
    const short = scored.find(r => r.d <= 8000), long = scored.find(r => r.d >= 15000);
    if (short && long && long.d / short.d > 1.8) k = clamp(Math.log(long.t / short.t) / Math.log(long.d / short.d), 1.01, 1.25);
  }

  // Three corrections on top of raw Riegel, all of which stop a hard tempo run from
  // masquerading as a marathon: 3% per doubling of extrapolation (the wall is real and
  // Riegel does not know about it), 2% for references that were training rather than
  // racing, and 8% per doubling past the longest run you have actually completed.
  const longestRun = runs.reduce((m, a) => Math.max(m, a.distance_m), 0);
  const stretchRun = d => 1 + 0.08 * Math.max(0, Math.log2(d / Math.max(longestRun, 5000)));
  // Past the marathon the curve steepens — fuelling, night, terrain and the fact that
  // nobody's 10k shape says anything useful about hour eleven.
  const kFor = d => d <= 42195 ? k : k + Math.min(0.12, 0.06 * Math.log2(d / 42195));
  const predictWith = (list, d) => list.length ? Math.min(...list.map(r =>
    riegel(r.t, r.d, d, kFor(d)) * (1 + 0.03 * Math.max(0, Math.log2(d / r.d))) * (r.measured ? 1 : 1.02))) * stretchRun(d) : null;
  // Calibration: where you logged a real race time, compare it with what the model would
  // have said from the evidence before it, and carry the median miss forward.
  // ponytail: one scalar, shrunk toward 1 by n/(n+1) and clamped. Per-distance bias if it ever matters.
  const misses = races.map(r => { const p0 = predictWith(refs.filter(x => (x.ts || 0) < r.ts), r.distance_m); return p0 ? r.seconds / p0 : null; })
    .filter(Boolean).sort((a, b) => a - b);
  const bias = misses.length ? clamp(1 + (misses[misses.length >> 1] - 1) * misses.length / (misses.length + 1), 0.92, 1.12) : 1;
  const predictRun = d => { const p0 = predictWith(refs, d); return p0 && p0 * bias; };

  // Second opinion: Daniels VDOT from your single best effort, inverted for the target
  // distance. Only inside the range the equations were fitted on.
  const bestVdot = Math.max(0, ...refs.filter(r => r.d >= 1500 && r.d <= 42195 && r.t >= 210).map(r => vdot(r.t * (r.measured ? 1 : 1.02), r.d)));
  const danielsRun = d => bestVdot && d >= 1500 && d <= 50000 ? danielsTime(bestVdot, d) : null;

  // --- measured PB curve (only distances actually covered)
  const pbs = PB_DISTANCES.map(d => {
    const exact = bestEfforts.filter(b => Math.abs(b.distance_m - d) / d < 0.01).sort((a, b) => a.seconds - b.seconds)[0];
    // Even-pace read of a whole activity, but only from activities of comparable length:
    // a 30 km run says nothing useful about your 400 m.
    const covered = runs.filter(a => a.distance_m >= d * 0.995 && a.distance_m <= d * 3)
      .map(a => ({ seconds: a.moving_s * (d / a.distance_m), ts: a.start_ts, measured: false }))
      .sort((a, b) => a.seconds - b.seconds)[0];
    const best = exact ? { seconds: exact.seconds, ts: exact.start_ts, measured: true }
      : covered ? { ...covered } : null;
    return { distance_m: d, ...(best || {}), predicted: predictRun(d) };
  });

  // --- daily buckets for volume, load and rolling windows
  const day0 = localDay(acts.length ? Math.min(acts[0].start_ts, now) : now);
  const dayN = localDay(now);
  const nDays = Math.max(1, dayN - day0 + 1);
  const blank = () => new Float64Array(nDays);
  const dist = Object.fromEntries(ENDURANCE_SPORTS.map(s => [s, blank()]));
  const distAll = blank(), distEquiv = blank(), load = blank(), elev = blank(), secs = blank();

  const vThreshold = thresholdSpeeds(acts, predictRun, k);
  const maxHR = athlete.max_hr || Math.max(0, ...acts.map(a => a.max_hr || 0)) || null;
  for (const a of acts) {
    const i = clamp(localDay(a.start_ts) - day0, 0, nDays - 1);
    const sport = ENDURANCE_SPORTS.includes(a.sport) ? a.sport : 'other';
    dist[sport][i] += a.distance_m || 0;
    distAll[i] += a.distance_m || 0;
    distEquiv[i] += (a.distance_m || 0) * (EFFORT[sport] ?? 0.5);
    elev[i] += a.elev_m || 0;
    secs[i] += a.moving_s || 0;
    load[i] += activityLoad(a, vThreshold, maxHR);
  }

  // --- Banister-style fitness/fatigue
  const ewma = (arr, tau) => { const out = new Float64Array(arr.length); let v = 0; const f = Math.exp(-1 / tau); for (let i = 0; i < arr.length; i++) { v = v * f + arr[i] * (1 - f); out[i] = v; } return out; };
  const ctlSeries = ewma(load, 42), atlSeries = ewma(load, 7);
  const ctl = ctlSeries[nDays - 1] || 0, atl = atlSeries[nDays - 1] || 0;

  const windowSum = (arr, days) => {
    let best = 0, sum = 0;
    for (let i = 0; i < arr.length; i++) { sum += arr[i]; if (i >= days) sum -= arr[i - days]; if (sum > best) best = sum; }
    return best;
  };
  // 'multi' windows are measured in run-equivalent kilometres, not raw ones
  const bestWindow = (sport, days) => windowSum(sport === 'multi' ? distEquiv : (dist[sport] || blank()), Math.max(1, Math.round(days)));
  const bestElevWindow = days => windowSum(elev, Math.max(1, Math.round(days)));
  /** Longest run of consecutive days with at least `minM` of that sport. */
  const longestStreak = (sport, minM = 1) => {
    const arr = sport === 'multi' ? distAll : (dist[sport] || blank());
    let best = 0, run = 0;
    for (let i = 0; i < arr.length; i++) { run = arr[i] >= minM ? run + 1 : 0; if (run > best) best = run; }
    return best;
  };
  const currentStreak = (sport, minM = 1) => {
    const arr = sport === 'multi' ? distAll : (dist[sport] || blank());
    let i = arr.length - 1;
    if (arr[i] < minM) i--;             // today is not over yet — a live streak is not broken until midnight
    let run = 0;
    for (; i >= 0 && arr[i] >= minM; i--) run++;
    return run;
  };

  /** Largest E such that you covered at least E units on E different days. */
  const eddington = (sport, unitM = 1000) => {
    const days = Array.from(dist[sport] || []).map(m => m / unitM).sort((a, b) => b - a);
    let e = 0;
    while (e < days.length && days[e] >= e + 1) e++;
    return e;
  };
  const daysOver = (sport, m) => (dist[sport] || []).reduce((n, v) => n + (v >= m ? 1 : 0), 0);

  const recentWeekly = sport => {
    const arr = sport === 'multi' ? distEquiv : (dist[sport] || blank());
    const from = Math.max(0, nDays - 28);
    let s = 0; for (let i = from; i < nDays; i++) s += arr[i];
    return s / Math.max(1, (nDays - from) / 7);
  };

  // --- improvement trend: predicted marathon time now vs. a year of history
  const marathonNow = predictRun(42195);
  const older = refs.filter(r => r.ts && r.ts < now - 180 * DAY);
  const marathonThen = predictWith(older, 42195) && predictWith(older, 42195) * bias;   // same penalties both sides, or the trend is fiction
  let improveRate = 0.03;                                  // default 3%/yr for a training adult
  if (marathonNow && marathonThen) {
    const yrs = clamp((now - Math.max(...older.map(r => r.ts))) / (365 * DAY), 0.5, 3);
    improveRate = clamp((marathonThen - marathonNow) / marathonThen / yrs, -0.02, 0.15);
  }
  if (ctl < 20) improveRate = Math.max(improveRate, 0.05);  // low base = more room

  const maxOf = (f, filter = () => true) => acts.filter(filter).reduce((m, a) => Math.max(m, f(a) || 0), 0);

  // How much to trust a prediction: measured efforts, recent efforts and a distance you
  // have actually covered all narrow the band. Everything else widens it.
  const measuredRefs = refs.filter(r => r.measured);
  const newestRef = refs.length ? Math.max(...refs.map(r => r.ts || 0)) : 0;
  const longestRunDist = runs.reduce((m, a) => Math.max(m, a.distance_m), 0);
  const bandFor = d => {
    let pct = 0.04;
    if (!measuredRefs.length) pct += 0.03;                          // no race, no chip time
    if (!newestRef || now - newestRef > 90 * DAY) pct += 0.03;      // stale evidence
    if (d > longestRunDist * 1.5) pct += 0.04;                      // beyond anything you have done
    if (refs.length < 5) pct += 0.02;
    const p0 = predictRun(d), alt = danielsRun(d);
    if (p0 && alt) pct += Math.min(0.03, Math.abs(alt / p0 - 1) / 2);   // two models disagreeing is uncertainty too
    return Math.min(0.18, pct);
  };
  const predictBand = d => {
    const p0 = predictRun(d);
    if (!p0) return null;
    const b = bandFor(d);
    return { mid: p0, low: p0 * (1 - b), high: p0 * (1 + b), pct: b, alt: danielsRun(d) };
  };

  // VO2max from the best of three distances (Daniels)
  const vo2 = [5000, 10000, 21097.5].map(d => { const t = predictRun(d); return t ? vdot(t, d) : 0; });
  const vo2max = Math.max(0, ...vo2) || null;

  // Acute:chronic workload — the closest thing to an injury early-warning we can compute
  const sumLast = n => { let t = 0; for (let i = Math.max(0, nDays - n); i < nDays; i++) t += load[i]; return t; };
  const acute = sumLast(7), chronic = sumLast(28) / 4;
  const acwr = chronic > 5 ? acute / chronic : null;

  return {
    generated_at: now, day0, nDays, k, improveRate,
    counts: { activities: acts.length, runs: runs.length, days: nDays },
    fitness: { ctl, atl, tsb: ctl - atl, ramp: ctl - (ctlSeries[Math.max(0, nDays - 29)] || 0), acwr, acute, chronic },
    vo2max, predictBand, bandFor,
    predictRun, k_used: k,
    pbs,
    weekly: { run: recentWeekly('run'), ride: recentWeekly('ride'), swim: recentWeekly('swim'), all: recentWeekly('multi') },
    bestWindow, bestElevWindow, longestStreak, currentStreak, eddington, daysOver,
    eddingtons: { run_km: eddington('run'), ride_km: eddington('ride'), ride_mi: eddington('ride', 1609.344) },
    calibration: { races: misses.length, bias },
    maxes: {
      run_distance: maxOf(a => a.distance_m, a => a.sport === 'run'),
      ride_distance: maxOf(a => a.distance_m, a => a.sport === 'ride'),
      swim_distance: maxOf(a => a.distance_m, a => a.sport === 'swim'),
      row_distance: maxOf(a => a.distance_m, a => a.sport === 'row'),
      ski_distance: maxOf(a => a.distance_m, a => a.sport === 'ski'),
      elev_single: maxOf(a => a.elev_m),
      duration: maxOf(a => a.moving_s),
      duration_by_sport: Object.fromEntries(ENDURANCE_SPORTS.map(sp => [sp, maxOf(a => a.moving_s, a => a.sport === sp)])),
      elev_day: Math.max(0, ...elev),
    },
    series: { day0, distAll: Array.from(distAll), load: Array.from(load), ctl: Array.from(ctlSeries), atl: Array.from(atlSeries), elev: Array.from(elev), byDaySport: Object.fromEntries(Object.entries(dist).map(([s, v]) => [s, Array.from(v)])) },
    thresholds: vThreshold,
    athlete,
  };
}

/** Threshold speed per sport, used to scale training load. */
function thresholdSpeeds(acts, predictRun, k) {
  const out = {};
  const hourRun = predictRun(10000);
  if (hourRun) {
    // distance the athlete could hold for an hour, back out of the 10k prediction
    out.run = 10000 * Math.pow(3600 / hourRun, 1 / k) / 3600;
  }
  for (const sport of ['ride', 'swim', 'row', 'ski', 'walk']) {
    // ponytail: no power meter, no FTP — top-decile average speed stands in for threshold.
    const sp = acts.filter(a => a.sport === sport && a.moving_s > 900 && a.distance_m > 0)
      .map(a => a.distance_m / a.moving_s).sort((a, b) => b - a);
    if (sp.length) out[sport] = sp[Math.floor(sp.length * 0.1)] * 0.93;
  }
  return out;
}

/**
 * Time to cover `d` in a sport where we have a speed but no result at that distance.
 * Threshold speed, a pacing drop that grows with duration, and 10% per doubling beyond
 * the longest session you have actually done — a 2 km pool swimmer is not 34 km from
 * the Channel, they are much further than the arithmetic suggests.
 */
export function projectDistanceTime(d, speed, longest = 0, { open = false } = {}) {
  if (!speed) return null;
  const raw = d / speed;
  const pacing = raw > 3600 ? 1.15 : raw > 1800 ? 1.07 : 1.02;
  const stretch = 1 + 0.10 * Math.max(0, Math.log2(d / Math.max(longest, 1)));
  return raw * pacing * stretch * (open ? 1.15 : 1);      // open water: cold, chop, no walls
}

/** TSS-shaped load: hours × 100 × intensity². HR when we have it, pace when we don't. */
export function activityLoad(a, vT, maxHR) {
  const hours = (a.moving_s || 0) / 3600;
  if (!hours) return 0;
  let intensity = 0.7;
  if (a.avg_hr && maxHR) intensity = clamp(((a.avg_hr - 55) / (maxHR - 55)) / 0.9, 0.4, 1.2);
  else if (vT[a.sport] && a.distance_m) intensity = clamp((a.distance_m / a.moving_s) / vT[a.sport], 0.4, 1.15);
  return hours * 100 * intensity * intensity;
}

/**
 * Daniels & Gilbert VDOT: estimated VO2max from a race performance. Takes the best of
 * several distances, because one bad day at 5 km should not define your physiology.
 */
export function vdot(seconds, meters) {
  const t = seconds / 60, v = meters / t;
  const pctMax = 0.8 + 0.1894393 * Math.exp(-0.012778 * t) + 0.2989558 * Math.exp(-0.1932605 * t);
  const vo2 = -4.60 + 0.182258 * v + 0.000104 * v * v;
  return vo2 / pctMax;
}

/** Invert VDOT: the time at `meters` that scores the same VO2max. vdot() falls as time rises, so bisect. */
export function danielsTime(v, meters) {
  let lo = meters / 10, hi = meters;                 // 10 m/s to 1 m/s
  for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (vdot(mid, meters) > v) lo = mid; else hi = mid; }
  return hi;
}

// ---------------------------------------------------------------- age grading

const AG_DISTANCES = Object.keys(AGE_GRADE.M).map(Number);
/**
 * Age-grading factor from the USATF MLDR 2025 road tables: the fraction of open-class
 * performance expected at this age, for the tabled distance nearest (in log space) to `d`.
 * Ages clamp to the table's 5–99.
 */
export function ageFactor(age, d = 42195, sex = 'M') {
  if (!age) return 1;
  const near = AG_DISTANCES.reduce((b, x) => Math.abs(Math.log(x / d)) < Math.abs(Math.log(b / d)) ? x : b);
  return (AGE_GRADE[sex] || AGE_GRADE.M)[near][clamp(Math.round(age), 5, 99) - 5];
}

/** Convert a time set at `fromAge` into its equivalent at `toAge`. */
export const ageAdjustTime = (seconds, fromAge, toAge, d = 42195, sex = 'M') =>
  !fromAge || !toAge ? seconds : seconds * ageFactor(fromAge, d, sex) / ageFactor(toAge, d, sex);

/**
 * Head-to-head: their mark, your mark, and the same comparison once both are pulled
 * to the same age. The ledger's whole point is that Bryan Cranston ran 3:20 at 29 and
 * Al Roker ran 7:09 at 56, and those are not the same achievement.
 */
export function compare(feat, p, yourAge = null) {
  const c = feat.check || {};
  if (c.kind !== 'run_time' || !feat.age) return null;
  const d = c.distance_m;
  const yours = p.pbs.find(x => Math.abs(x.distance_m - d) / d < 0.02)?.seconds || p.predictRun(d);
  if (!yours) return null;
  // ponytail: one curve (your sex, default M) ages both runners; the ledger does not record theirs.
  const adjusted = yourAge ? ageAdjustTime(c.seconds, feat.age, yourAge, d, p.athlete?.sex === 'F' ? 'F' : 'M') : null;
  return {
    distance_m: d,
    their_seconds: c.seconds, their_age: feat.age,
    your_seconds: yours, your_age: yourAge,
    their_seconds_at_your_age: adjusted,
    beats_raw: yours <= c.seconds,
    beats_age_adjusted: adjusted ? yours <= adjusted : null,
    note: !yourAge ? 'Set your birth year to age-adjust this.'
      : adjusted > c.seconds
        ? `They were ${feat.age}; at ${yourAge} the same performance is worth ${fmtDur(adjusted)}.`
        : `They were ${feat.age} and you are ${yourAge}: the age adjustment goes against you, to ${fmtDur(adjusted)}.`,
  };
}

// ---------------------------------------------------------------- verdicts

export const STATUS = {
  CRUSHED: 'crushed', IN_REACH: 'in_reach', CLOSE: 'close', TRAINABLE: 'trainable',
  FAR: 'far', LOGBOOK: 'logbook', SACRED: 'sacred',
};

const weeksToGain = (ratio, ratePerYear) => {
  if (ratio <= 1) return 0;
  const r = Math.max(0.005, ratePerYear);
  return Math.min(520, Math.ceil(Math.log(ratio) / Math.log(1 + r) * 52));   // past a decade, "far" says it better
};

/**
 * Judge one feat. Returns status, the numbers behind it, and human-readable requirement.
 * @param feat  entry from the feats dataset
 * @param p     profile from buildProfile
 * @param attempts logged attempts for this feat (verified ones count as proof)
 */
export function judge(feat, p, attempts = []) {
  return gate(judgeRaw(feat, p, attempts), feat);
}

function judgeRaw(feat, p, attempts = []) {
  const c = feat.check || { kind: 'manual' };
  const proof = attempts.find(a => a.verified);
  const base = { feat_id: feat.id, kind: c.kind, gated: !!feat.logistics, evidence: proof ? 'logged' : null };

  if (feat.sacred) return { ...base, status: STATUS.SACRED, headline: 'Not a target. Not ever.', gap: null };
  if (proof) return { ...base, status: STATUS.CRUSHED, headline: `Logged ${proof.date}${proof.notes ? ' — ' + proof.notes : ''}`, gap: 1 };

  const eta = ratio => weeksToGain(ratio, p.improveRate);
  const settle = (ratio, you, target, unit, headline, extra = {}) => {
    // ratio > 1 means you are already past it
    let status;
    if (ratio >= 1) status = STATUS.IN_REACH;
    else if (ratio >= 0.9) status = STATUS.CLOSE;
    else status = eta(1 / ratio) <= 156 ? STATUS.TRAINABLE : STATUS.FAR;
    return { ...base, status, gap: ratio, you, target, unit, headline, eta_weeks: ratio >= 1 ? 0 : eta(1 / ratio), ...extra };
  };

  switch (c.kind) {
    case 'vo2max': {
      const have = p.vo2max;
      if (!have) return { ...base, status: STATUS.LOGBOOK, headline: 'No running data — VO₂max is estimated from your race performances.' };
      const target = c.value;
      if (have >= target) return { ...base, status: STATUS.CRUSHED, gap: have / target, you: have, target, unit: 'ml/kg/min',
        headline: `Estimated VO₂max ${have.toFixed(1)} from your own performances — past ${target}.`, evidence: 'implied' };
      return settle(have / target, have, target, 'ml/kg/min',
        `Estimated VO₂max ${have.toFixed(1)} against ${target}. Estimated from race pace via Daniels, not measured with a mask.`);
    }
    case 'run_time': case 'swim_time': case 'ride_time': case 'row_time': {
      const sport = c.kind.split('_')[0];
      const d = c.distance_m ?? c.meters;
      if (sport === 'run') {
        const done = p.pbs.find(x => Math.abs(x.distance_m - d) / d < 0.02);
        if (done?.seconds && done.seconds <= c.seconds)
          return { ...base, status: STATUS.CRUSHED, gap: c.seconds / done.seconds, you: done.seconds, target: c.seconds, unit: 's',
            headline: `You have run ${fmtDur(done.seconds)} for ${fmtKm(d)} — ${fmtDur(c.seconds - done.seconds)} inside it.`, evidence: done.measured ? 'measured' : 'implied' };
        const flat = p.predictRun(d);
        if (!flat) return { ...base, status: STATUS.LOGBOOK, headline: 'No running data yet — connect a provider or log an attempt.' };
        // Naismith, runner's edition: about 5 seconds per metre of ascent on top of flat pace.
        const climbCost = (c.climb_m || 0) * 5;
        // Course factor for conditions the clock cannot see: heat, navigation, altitude, night.
        const pred = (flat + climbCost) * (c.factor || 1);
        const band = p.predictBand ? p.predictBand(d) : null;
        return settle(c.seconds / pred, pred, c.seconds, 's',
          climbCost
            ? `${fmtKm(d)} with ${c.climb_m.toLocaleString()} m of climbing: ${fmtDur(flat)} flat plus ${fmtDur(climbCost)} vertical${c.factor ? `, ×${c.factor} for ${c.factor_why}` : ''} = ${fmtDur(pred)}, against a ${fmtDur(c.seconds)} limit.`
            : `Need ${fmtPace(c.seconds / (d / 1000))} for ${fmtKm(d)}; you project ${fmtDur(pred)} (${fmtPace(pred / (d / 1000))}).`,
          { requires_pace: c.seconds / (d / 1000), climb_cost_s: climbCost || undefined,
            band: band && { low: band.low + climbCost, high: band.high + climbCost, pct: band.pct, alt: climbCost || c.factor ? null : band.alt } });
      }
      // swim/ride/row: threshold speed, penalised for everything beyond your longest session
      const have = p.maxes[`${sport}_distance`];
      const pred = projectDistanceTime(d, p.thresholds[sport], have, { open: c.water === 'open' });
      if (!pred) return { ...base, status: STATUS.LOGBOOK, headline: `No ${sport} data — log an attempt or connect a device.` };
      const covered = have >= d * 0.98;
      return settle(c.seconds / pred, pred, c.seconds, 's',
        `Need ${fmtDur(c.seconds)} for ${fmtKm(d)}; your ${sport} projects ${fmtDur(pred)}${covered ? '' : ` (longest ${sport} so far ${fmtKm(have)}, which is most of the gap)`}.`);
    }
    case 'ride_distance': case 'swim_distance': {
      const sport = c.kind.split('_')[0];
      const have = p.maxes[`${sport}_distance`];
      const open = c.water === 'open';
      const target = open ? c.meters * OPEN_WATER_TAX : c.meters;   // cold, chop, current, no walls
      if (have >= target) return { ...base, status: STATUS.CRUSHED, gap: have / target, you: have, target, unit: 'm',
        headline: `Longest ${sport}: ${fmtKm(have)} — past ${fmtKm(c.meters)}${open ? ' plus the open-water margin' : ''}.`, evidence: 'measured' };
      const projected = have * 1.35 + (p.weekly[sport] || 0) * 0.25;      // stretch beyond your longest, plus weekly base
      return settle(projected / target, projected, target, 'm',
        open ? `Longest swim is ${fmtKm(have)}; ${fmtKm(c.meters)} of open water asks for roughly ${fmtKm(target)} of pool fitness — about ${(target / Math.max(have, 1)).toFixed(1)}× your best.`
             : `Longest ${sport} is ${fmtKm(have)}; ${fmtKm(c.meters)} needs about ${(target / Math.max(have, 1)).toFixed(1)}× that.`);
    }
    case 'distance_window': {
      const days = c.days, sport = c.sport === 'walk' ? 'run' : c.sport;
      // multi-discipline targets are compared in run-equivalent km; legs when we know them,
      // otherwise the raw distance is treated as run-equivalent
      const target = sport === 'multi' && c.legs ? effortEquiv(c.legs) * (c.repeats || 1) : c.meters;
      const equivNote = sport === 'multi' ? ' (run-equivalent km: a bike kilometre counts 0.3, a swum one counts 4)' : '';
      const have = p.bestWindow(sport, days);
      if (have >= target) return { ...base, status: STATUS.CRUSHED, gap: have / target, you: have, target, unit: 'm',
        headline: `Best ${days}-day block: ${fmtKm(have)} — past ${fmtKm(target)}${equivNote}.`, evidence: 'measured' };
      const weekly = p.weekly[sport === 'multi' ? 'all' : sport] || 0;
      const projected = weekly / 7 * days * durability(days);
      const perDay = target / days;
      return settle(projected / target, projected, target, 'm',
        `${fmtKm(target)} in ${days} days is ${fmtKm(perDay)}/day${equivNote}. Best block so far ${fmtKm(have)}; current volume sustains about ${fmtKm(projected)}.`,
        { per_day: perDay, volume_needed_weekly: perDay * 7 / durability(days) });
    }
    case 'elev_window': {
      const have = p.bestElevWindow(c.days), target = c.meters;
      if (have >= target) return { ...base, status: STATUS.CRUSHED, gap: have / target, you: have, target, unit: 'm',
        headline: `Best ${c.days}-day climbing block: ${Math.round(have).toLocaleString()} m.`, evidence: 'measured' };
      const perDay = target / c.days;
      const recent = p.series.elev.slice(-28).reduce((a, b) => a + b, 0) / 28;
      const projected = Math.max(have * 1.25, recent * c.days * durability(c.days));
      return settle(projected / target, projected, target, 'm',
        `${target.toLocaleString()} m in ${c.days} days is ${Math.round(perDay).toLocaleString()} m/day; your best block is ${Math.round(have).toLocaleString()} m.`,
        { per_day: perDay });
    }
    case 'streak': {
      const have = p.longestStreak(c.sport, c.min_m || 1), current = p.currentStreak(c.sport, c.min_m || 1);
      const target = c.days;
      if (have >= target) return { ...base, status: STATUS.CRUSHED, gap: have / target, you: have, target, unit: 'days',
        headline: `Longest streak: ${have} days.`, evidence: 'measured' };
      // streaks are a habit problem, not a fitness one: no extrapolation, just days needed
      const ratio = have / target;
      return { ...base, status: ratio >= 0.9 ? STATUS.CLOSE : ratio > 0 ? STATUS.TRAINABLE : STATUS.TRAINABLE,
        gap: ratio, you: have, target, unit: 'days', eta_weeks: Math.ceil((target - current) / 7),
        headline: `${target} consecutive days of at least ${fmtKm(c.min_m || 1)}. Longest so far ${have}; currently on ${current}.`,
        current_streak: current };
    }
    case 'eddington': {
      const unitM = c.unit === 'mi' ? 1609.344 : 1000, target = c.value;
      const have = p.eddington(c.sport, unitM);
      if (have >= target) return { ...base, status: STATUS.CRUSHED, gap: have / target, you: have, target, unit: 'E',
        headline: `Eddington number ${have} (${c.unit || 'km'}) — past ${target}.`, evidence: 'measured' };
      // Like a streak, this is counted not projected: it needs that many more qualifying days.
      // ponytail: ETA assumes one qualifying day a week.
      const need = target - p.daysOver(c.sport, target * unitM), weeks = need, ratio = have / target;
      return { ...base, status: ratio >= 0.9 ? STATUS.CLOSE : weeks <= 156 ? STATUS.TRAINABLE : STATUS.FAR,
        gap: ratio, you: have, target, unit: 'E', eta_weeks: weeks,
        headline: `Needs ${target} days of at least ${target} ${c.unit || 'km'}. Your number is ${have}; ${need} more qualifying days to go.` };
    }
    case 'elev_single': {
      const have = p.maxes.elev_single, target = c.meters;
      if (have >= target) return { ...base, status: STATUS.CRUSHED, gap: have / target, you: have, target, unit: 'm',
        headline: `Biggest single-activity climb: ${Math.round(have)} m.`, evidence: 'measured' };
      const projected = Math.max(have * 1.6, p.maxes.elev_day * 1.4);
      return settle(projected / target, projected, target, 'm',
        `Target ${target.toLocaleString()} m in one go; your biggest is ${Math.round(have).toLocaleString()} m.`);
    }
    case 'duration_single': {
      const sport = c.sport && c.sport !== 'other' ? c.sport : null;
      const have = sport ? (p.maxes.duration_by_sport?.[sport] ?? 0) : p.maxes.duration;
      const target = c.seconds, what = sport ? `${sport} session` : 'session';
      if (have >= target) return { ...base, status: STATUS.CRUSHED, gap: have / target, you: have, target, unit: 's',
        headline: `Longest ${what}: ${fmtDur(have)}.`, evidence: 'measured' };
      return settle((have * 1.4) / target, have * 1.4, target, 's',
        `Needs ${fmtDur(target)} continuous; longest ${what} so far ${fmtDur(have)}.`);
    }
    case 'triathlon': {
      const { swim_m, bike_m, run_m } = c.legs;
      const runT = p.predictRun(run_m);
      const swimSpeed = p.thresholds.swim, bikeSpeed = p.thresholds.ride;
      if (!runT || !swimSpeed || !bikeSpeed) {
        const missing = [!runT && 'run', !swimSpeed && 'swim', !bikeSpeed && 'ride'].filter(Boolean).join(' + ');
        return { ...base, status: STATUS.LOGBOOK, headline: `Needs ${missing} data before this can be projected.` };
      }
      const swimT = projectDistanceTime(swim_m, swimSpeed, p.maxes.swim_distance, { open: true });
      const bikeT = projectDistanceTime(bike_m, bikeSpeed * 0.88, p.maxes.ride_distance), t3 = 720;
      const climbT = (c.climb_m || 0) * 5;        // same vertical cost as the run branch
      const pred = swimT + bikeT + runT * 1.18 + t3 + climbT;   // the marathon off the bike is not a marathon
      return settle(c.seconds / pred, pred, c.seconds, 's',
        `Projected ${fmtDur(pred)} (swim ${fmtDur(swimT)} · bike ${fmtDur(bikeT)} · run ${fmtDur(runT * 1.18)} · T ${fmtDur(t3)}${climbT ? ` · climbing ${fmtDur(climbT)}` : ''}) against ${fmtDur(c.seconds)}.`,
        { splits: { swim: swimT, bike: bikeT, run: runT * 1.18, transition: t3 } });
    }
    case 'reps': {
      const kg = p.athlete?.weight_kg;
      const load = c.load_kg ?? (c.load_ratio && kg ? Math.round(c.load_ratio * kg) : null);
      const what = [c.name, c.count ? `${c.count} reps` : null, load ? `${load} kg` : null, c.seconds ? `under ${fmtDur(c.seconds)}` : null].filter(Boolean).join(' · ');
      return { ...base, status: STATUS.LOGBOOK, target: load,
        headline: `Logbook feat — ${what}${c.load_ratio && !kg ? ' (set your weight on the Connect tab to see the number)' : ''}. No watch proves a barbell.` };
    }
    case 'summit': case 'breath_hold': case 'manual': default:
      return { ...base, status: STATUS.LOGBOOK, headline: feat.logistics
        ? `Logbook feat — ${feat.logistics}.`
        : 'Logbook feat: no wearable proves this one. Log an attempt with evidence.' };
  }
}

/**
 * Capacity is not the same as having been there. If a feat needs a permit, an entry, a
 * pilot boat or a plane ticket, training data can prove you are ready — it cannot prove
 * you went. Those stay "in reach" until an attempt is logged.
 */
function gate(v, feat) {
  if (v.status !== STATUS.CRUSHED || v.evidence === 'logged' || !feat.logistics) return v;
  return { ...v, status: STATUS.IN_REACH, gated_from_crushed: true,
    headline: `${v.headline} Your body is ready; the feat still has to be gone and done — ${feat.logistics}.` };
}

/** Everything at once, sorted so the closest unbeaten feats come first. */
export function judgeAll(feats, profile, attemptsByFeat = {}) {
  return feats.map(f => ({ feat: f, verdict: judge(f, profile, attemptsByFeat[f.id] || []) }));
}

/**
 * Week-by-week build: a 3:1 loading pattern from where you are now to the peak the goal
 * needs, then a taper. Volume is capped at 8%/week growth because that is the rule most
 * often broken by people who then get injured.
 */
export function buildWeeks(currentKm, peakKm, longRunKm, weeks, paces = {}, startTs = Date.now() / 1000) {
  if (!weeks || weeks < 2) return [];
  const taper = weeks >= 12 ? 3 : weeks >= 6 ? 2 : 1;
  const build = weeks - taper;
  const out = [];
  // `base` is the trend line; a recovery week dips below it without dragging it down.
  let base = Math.max(currentKm, 10), km = base;
  for (let i = 0; i < weeks; i++) {
    const recovery = i < build && i % 4 === 3;
    const toGo = Math.max(1, build - i);
    if (i < build) {
      const need = Math.max(1, peakKm / Math.max(base, 1));
      const step = Math.min(1.08, Math.pow(need, 1 / toGo));     // never ramp above 8%/week
      base = Math.min(peakKm, base * step);
      km = recovery ? base * 0.72 : base;
    } else {
      km = base * (weeks - i === 1 ? 0.45 : weeks - i === 2 ? 0.6 : 0.75);   // step down off the peak
    }
    const long = Math.min(longRunKm, Math.max(8, km * (i < build ? 0.33 : 0.22)));   // a down week is down everywhere
    const phase = i >= build ? (weeks - i === 1 ? 'race week' : 'taper')
      : recovery ? 'recovery' : i < build * 0.4 ? 'base' : i < build * 0.8 ? 'build' : 'peak';
    out.push({
      week: i + 1, phase,
      km: +km.toFixed(1), long_km: +long.toFixed(1),
      start: dayStr(localDay(startTs) + i * 7),
      sessions: sessionsFor(phase, km, long, paces),
    });
  }
  return out;
}

function sessionsFor(phase, km, long, p) {
  const easy = p.easy || '', race = p.race || '', thr = p.threshold || '';
  const easyKm = Math.max(5, Math.round((km - long) / 3));
  if (phase === 'race week') return [`Two easy runs of ${Math.round(easyKm * 0.6)} km${easy ? ' at ' + easy : ''}`, `20 minutes shakeout with 4 × 1 min at ${race || 'race pace'}`, 'Race'];
  if (phase === 'taper') return [`${Math.round(km)} km total, intensity kept, volume cut`, `1 × ${Math.round(long)} km long run`, `1 × 20 min at ${thr || 'threshold'}`];
  if (phase === 'recovery') return [`${Math.round(km)} km, all easy${easy ? ' at ' + easy : ''}`, 'No quality sessions this week', 'Sleep is the session'];
  const quality = phase === 'base' ? `1 × 6 × 3 min at ${thr || 'threshold'}`
    : phase === 'build' ? `1 × 5 km at ${thr || 'threshold'} + 1 × 8 km at ${race || 'race pace'}`
    : `1 × 2 × 6 km at ${race || 'race pace'} + 1 × 20 min at ${thr || 'threshold'}`;
  return [`${Math.round(long)} km long run${phase === 'peak' && race ? `, last 8 km at ${race}` : ''}`, quality, `${3} × ${easyKm} km easy${easy ? ' at ' + easy : ''}`];
}

/** Training plan for a goal: what the target actually demands, week by week. */
export function planFor(feat, profile, targetDate, now = Date.now() / 1000) {
  const weeks = targetDate ? Math.max(0, Math.round((dayStart(targetDate) - now) / (7 * DAY))) : null;
  const v = judge(feat, profile);
  const c = feat.check || {};
  const plan = { weeks_remaining: weeks, verdict: v, steps: [] };

  // Already inside your range? Then this is a logistics problem, not a training one.
  if ([STATUS.IN_REACH, STATUS.CRUSHED].includes(v.status)) {
    const pace = c.kind === 'run_time' ? c.seconds / (c.distance_m / 1000) : null;
    plan.weeks_needed = 0;
    plan.feasible = true;
    plan.targets = pace ? { race_pace_str: fmtPace(pace), target_str: fmtDur(c.seconds), projected_now_str: fmtDur(v.you || 0), current_weekly_km: +(profile.weekly.run / 1000).toFixed(1) } : null;
    plan.steps = [
      v.status === STATUS.CRUSHED ? 'Done. Keep the evidence link on the attempt so it stays crushed.'
        : `Your current numbers already clear this: ${v.headline}`,
      feat.logistics ? `The remaining obstacle is paperwork: ${feat.logistics}` : 'Find the event and enter it — the entry is the only thing standing between projection and result.',
      pace ? `On the day, hold ${fmtPace(pace)} from the gun; the projection assumes even pacing and nothing banked early.` : 'Rehearse the exact conditions once before the attempt.',
      'Log it here afterwards with a link. A verified attempt outranks the model.',
    ];
    return plan;
  }

  if (c.kind === 'run_time') {
    const d = c.distance_m, pace = c.seconds / (d / 1000);
    const pred = profile.predictRun(d);
    const km = d / 1000;
    // Peak weekly volume heuristic: long-standing rule of thumb is ~3-4× race distance for a marathon.
    const peakWeekly = Math.round(clamp(km * (km >= 40 ? 1.9 : km >= 20 ? 3.2 : 5), 25, 160));
    const nowWeekly = profile.weekly.run / 1000;
    plan.targets = {
      race_pace: pace, race_pace_str: fmtPace(pace),
      threshold_pace_str: fmtPace(pace * 0.93), easy_pace_str: fmtPace(pace * 1.22),
      peak_weekly_km: peakWeekly, current_weekly_km: +nowWeekly.toFixed(1),
      long_run_km: Math.round(clamp(km * 0.8, 10, 35)),
      projected_now: pred, projected_now_str: pred ? fmtDur(pred) : '—', target_str: fmtDur(c.seconds),
    };
    plan.weeks = buildWeeks(nowWeekly, peakWeekly, clamp(km * 0.8, 10, 35), weeks, {
      easy: fmtPace(pace * 1.22), race: fmtPace(pace), threshold: fmtPace(pace * 0.93),
    }, now);
    plan.steps = [
      `Hold ${fmtPace(pace * 1.22)} easy for 80% of weekly volume.`,
      `Build to ${peakWeekly} km/week from ${nowWeekly.toFixed(0)} km — cap the ramp at 10%/week.`,
      `Weekly long run to ${Math.round(clamp(km * 0.8, 10, 35))} km, one session at ${fmtPace(pace * 0.93)}.`,
      `Two race-pace blocks per week at ${fmtPace(pace)}; taper the last 2-3 weeks.`,
    ];
    if (weeks != null) {
      const need = pred ? pred / c.seconds : null;
      plan.feasible = need == null ? null : need <= 1 || weeks >= weeksToGain(need, profile.improveRate);
      plan.weeks_needed = need && need > 1 ? weeksToGain(need, profile.improveRate) : 0;
    }
  } else if (c.kind === 'distance_window') {
    const perDay = c.meters / c.days / 1000;
    const needWeekly = perDay * 7 / durability(c.days);
    plan.targets = { per_day_km: +perDay.toFixed(1), weekly_km_needed: +needWeekly.toFixed(1), current_weekly_km: +(profile.weekly[c.sport === 'multi' ? 'all' : c.sport] / 1000 || 0).toFixed(1) };
    plan.weeks = buildWeeks(plan.targets.current_weekly_km, needWeekly, perDay * 1.2, weeks, {}, now);
    plan.steps = [
      `Average ${perDay.toFixed(1)} km/day for ${c.days} days — that is the whole feat.`,
      `Base needed first: about ${needWeekly.toFixed(0)} km/week sustained for 8 weeks before the attempt.`,
      `Rehearse two consecutive days at target distance before committing.`,
      `Back-to-back days are the failure mode, not the single day. Train the recovery, not the peak.`,
    ];
    const ratio = plan.targets.current_weekly_km ? needWeekly / plan.targets.current_weekly_km : Infinity;
    plan.weeks_needed = ratio <= 1 ? 0 : Math.ceil(Math.log(ratio) / Math.log(1.08));   // 8%/week volume ramp
    plan.feasible = weeks == null ? null : weeks >= plan.weeks_needed;
  } else if (c.kind === 'triathlon') {
    plan.steps = [
      'Three sports, three weekly minimums: 2 swims, 3 rides, 3 runs.',
      'One long ride and one long run per week; brick the run onto the bike fortnightly.',
      'Practise the swim in open water and in the wetsuit you will race in.',
      feat.logistics || 'Enter the race first — the entry is the commitment device.',
    ];
    plan.targets = v.splits || null;
    plan.weeks_needed = v.eta_weeks ?? null;
    plan.feasible = weeks == null ? null : (v.eta_weeks ?? 0) <= weeks;
  } else {
    plan.steps = [
      feat.logistics ? `Logistics first: ${feat.logistics}` : 'No device proves this one — plan the evidence as carefully as the training.',
      'Find the sanctioning body or event and its entry requirements.',
      'Log the attempt here with a link when it happens.',
    ];
    plan.weeks_needed = null;
    plan.feasible = null;
  }
  return plan;
}

/** Logged finish times on flat, timed run feats — the labelled races the model calibrates against. */
export function racesFrom(attempts, byId) {
  return attempts.map(a => {
    const c = byId.get(a.feat_id)?.check;
    return c?.kind === 'run_time' && !c.climb_m && !c.factor && a.unit === 's' && a.value > 0
      ? { distance_m: c.distance_m, seconds: a.value, ts: dayStart(a.date) } : null;
  }).filter(Boolean);
}

/**
 * When each crushed feat fell. Nothing stores verdict history, so replay it: rebuild the
 * profile as of earlier dates and bisect for the first day each feat reads crushed.
 * ponytail: assumes crushed stays crushed (PBs and maxima only grow). A refit of k can
 * break that for a model-implied verdict; the date is then a day or two generous.
 */
export function milestones(feats, activities, bestEfforts, attemptsByFeat = {}, now = Date.now() / 1000, athlete = {}) {
  const out = [], open = [];
  const today = judgeAll(feats, buildProfile(activities, bestEfforts, now, athlete), attemptsByFeat);
  const headline = new Map(today.map(x => [x.feat.id, x.verdict.headline]));
  for (const { feat, verdict } of today) {
    if (verdict.status !== STATUS.CRUSHED) continue;
    const proof = (attemptsByFeat[feat.id] || []).find(a => a.verified);
    if (proof) out.push({ feat_id: feat.id, date: proof.date, headline: verdict.headline, logged: true });
    else open.push(feat);
  }
  const first = activities.reduce((m, a) => Math.min(m, a.start_ts), now);
  const crushedAt = (day, list) => {
    const ts = dayStart(dayStr(day + 1)) - 1;           // last second of that local day
    const p = buildProfile(activities.filter(a => a.start_ts <= ts), bestEfforts.filter(b => b.start_ts <= ts), ts, athlete);
    return list.filter(f => judge(f, p).status === STATUS.CRUSHED);
  };
  const solve = (lo, hi, list) => {            // invariant: not crushed at lo, crushed at hi
    if (!list.length) return;
    if (hi - lo <= 1) { for (const f of list) out.push({ feat_id: f.id, date: dayStr(hi), headline: headline.get(f.id) }); return; }
    const mid = (lo + hi) >> 1, done = new Set(crushedAt(mid, list));
    solve(lo, mid, list.filter(f => done.has(f)));
    solve(mid, hi, list.filter(f => !done.has(f)));
  };
  solve(localDay(first) - 1, localDay(now), open);
  return out.sort((a, b) => b.date.localeCompare(a.date));
}
