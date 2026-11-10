// node test.mjs — the whole check. assert-based, no framework.
import assert from 'node:assert/strict';
import { FEATS, BY_ID, stats } from './lib/feats.js';
import { buildProfile, judge, planFor, riegel, fmtDur, projectDistanceTime, compare, ageFactor, ageAdjustTime, effortEquiv, STATUS, vdot, danielsTime, milestones, racesFrom, dayStart } from './lib/engine.js';
import { eraseLocalData, logActivity, OWN_KEYS } from './public/device.js';
import { execFileSync } from 'node:child_process';
import { demoActivities } from './lib/demo.js';
import { importCsv, importGpx, importJson, parseCsv } from './lib/garmin.js';
import { dedupeKey } from './lib/db.js';
import { backend, memStore } from './public/local.js';
import * as Sync from './public/sync.js';
import { readFileSync, existsSync } from 'node:fs';

const NOW = 1789000000;                       // fixed clock: the demo generator is seeded
let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok  ${name}`); };
const ta = async (name, fn) => { await fn(); n++; console.log(`  ok  ${name}`); };

console.log('feats');
t('dataset loads with unique ids and valid checks', () => {
  assert.ok(FEATS.length > 360, `only ${FEATS.length} feats`);
  assert.equal(new Set(FEATS.map(f => f.id)).size, FEATS.length);
  const kinds = new Set(FEATS.map(f => f.check.kind));
  for (const k of kinds) assert.ok(/^(run_time|ride_time|swim_time|row_time|vo2max|swim_distance|ride_distance|distance_window|elev_single|elev_window|streak|duration_single|triathlon|eddington|summit|breath_hold|reps|manual)$/.test(k), `bad kind ${k}`);
});
t('every feat has who/title/note and a sane tier', () => {
  for (const f of FEATS) {
    assert.ok(f.who && f.title && f.note, `incomplete: ${f.id}`);
    assert.ok(f.tier >= 1 && f.tier <= 5, `tier out of range: ${f.id}`);
  }
});
t('the ledger anchors survived the import', () => {
  assert.equal(BY_ID.get('oprah-winfrey-marathon-1994').check.seconds, 4 * 3600 + 29 * 60 + 20);
  assert.equal(BY_ID.get('gordon-ramsay-marathon-2004').check.seconds, 3 * 3600 + 30 * 60 + 37);
  assert.ok(FEATS.find(f => f.sacred).who.includes('Terry Fox'));
});
t('stats add up', () => {
  const s = stats();
  assert.equal(s.computable + s.logbook, s.total);
  assert.ok(s.celebrities > 250, `only ${s.celebrities} names`);
});

console.log('engine');
t('riegel scales the way the exponent says', () => {
  assert.ok(Math.abs(riegel(3600, 10000, 20000) - 3600 * Math.pow(2, 1.06)) < 1e-6);
  assert.ok(riegel(1200, 5000, 42195) > 1200 * 8);        // marathon is worse than 8× a 5k
});

const { activities, efforts } = demoActivities(NOW);
const P = buildProfile(activities, efforts.map(e => ({ ...e })), NOW);

t('demo profile is a plausible amateur', () => {
  assert.ok(P.counts.runs > 250, `runs: ${P.counts.runs}`);
  const marathon = P.predictRun(42195);
  assert.ok(marathon > 3 * 3600 && marathon < 4 * 3600, `marathon projection ${fmtDur(marathon)}`);
  assert.ok(P.fitness.ctl > 30 && P.fitness.ctl < 200, `ctl ${P.fitness.ctl}`);
  assert.ok(P.weekly.run > 40000, `weekly ${P.weekly.run}`);
  assert.ok(P.k > 1.0 && P.k < 1.25);
});

t('measured best efforts beat even-pace reads', () => {
  const half = P.pbs.find(p => p.distance_m === 21097.5);
  assert.ok(half.measured, 'half PB should come from a measured best effort');
  assert.equal(half.seconds, 5850);
});

t('verdicts: slower celebrity marathons are crushed, faster ones are not', () => {
  const oprah = judge(BY_ID.get('oprah-winfrey-marathon-1994'), P);
  const styles = judge(BY_ID.get('harry-styles-marathon-2025'), P);
  assert.equal(oprah.status, STATUS.IN_REACH, `oprah ${oprah.status}`);
  assert.ok([STATUS.TRAINABLE, STATUS.FAR, STATUS.CLOSE].includes(styles.status), `styles ${styles.status}`);
  assert.ok(styles.eta_weeks > 0);
});

t('an actual finish outranks the projection', () => {
  const acts = [...activities, { id: 'x', sport: 'run', start_ts: NOW - 86400, distance_m: 42195, moving_s: 3 * 3600 + 20 * 60, elev_m: 0 }];
  const p2 = buildProfile(acts, efforts, NOW);
  const v = judge(BY_ID.get('gordon-ramsay-marathon-2004'), p2);
  assert.equal(v.status, STATUS.CRUSHED, v.headline);
});

t('a verified logged attempt crushes anything, including logbook feats', () => {
  const v = judge(BY_ID.get('kate-winslet-static-breath-hold'), P, [{ verified: 1, date: '2026-01-02', notes: '7:30 in the pool' }]);
  assert.equal(v.status, STATUS.CRUSHED);
  assert.equal(judge(BY_ID.get('kate-winslet-static-breath-hold'), P).status, STATUS.LOGBOOK);
});

t('rolling-window feats compare against the best window, not the average', () => {
  const izzard = judge(FEATS.find(f => f.id.startsWith('eddie-izzard-43')), P);
  assert.ok([STATUS.FAR, STATUS.TRAINABLE].includes(izzard.status), izzard.status);
  assert.ok(izzard.gap < 0.5, `43 marathons in 51 days should be far off, gap ${izzard.gap}`);
  assert.ok(izzard.per_day > 30000);
});

t('a pool swimmer is not one extrapolation away from the Channel', () => {
  const v = judge(BY_ID.get('david-walliams-swam-the-english-channel'), P);
  assert.ok(['far', 'trainable'].includes(v.status), `channel came out ${v.status} — check the stretch penalty`);
  assert.ok(v.you > 15 * 3600, `projected ${fmtDur(v.you)} for 34 km on 2.7 km of pool sessions`);
  // and the penalty must actually scale with how far past your longest session you are
  const near = projectDistanceTime(3000, 1, 3000), far = projectDistanceTime(24000, 1, 3000);
  assert.ok(far / 24000 > near / 3000 * 1.3, 'stretch penalty is not biting');
});

t('a mountain ultra is mostly vertical, and the engine charges for it', () => {
  const v = judge(BY_ID.get('reference-barkley'), P);
  assert.ok(v.you > 60 * 3600, `Barkley projected at ${fmtDur(v.you)} — the climbing is not being charged`);
  assert.ok(/18,300 m of climbing/.test(v.headline), v.headline);
  assert.notEqual(v.status, STATUS.IN_REACH, 'nobody with a 32 km longest run is in reach of the Barkley');
  // the same distance without the mountain is a much easier proposition
  const flat = judge({ id: 'x', check: { kind: 'run_time', distance_m: 160934, seconds: 60 * 3600 }, tier: 5 }, P);
  assert.ok(flat.you < v.you * 0.6, 'flat 100 miles should be far cheaper than the Barkley');
});

t('cross-sport windows compare effort, not raw kilometres', () => {
  assert.equal(effortEquiv({ run_m: 1000 }), 1000);
  assert.equal(effortEquiv({ ride_m: 1000 }), 300);
  assert.equal(effortEquiv({ swim_m: 1000 }), 4000);
  // a big bike day must not "crush" a swimrun championship
  const v = judge(BY_ID.get('reference-otillo'), P);
  assert.notEqual(v.status, STATUS.CRUSHED, v.headline);
  assert.ok(v.target > 100000, `ÖTILLÖ target should be ~105 km run-equivalent, got ${v.target}`);
});

t('open water costs more than the same distance in a pool', () => {
  const byron = judge(BY_ID.get('lord-byron-swam-the-hellespont'), P);
  assert.ok(byron.target > 5000 * 1.3, `open-water margin missing: target ${byron.target}`);
});

t('age grading flips the ones it should', () => {
  assert.equal(ageFactor(30), 1);
  assert.ok(ageFactor(44) < ageFactor(35) && ageFactor(70) < ageFactor(44));
  // USATF MLDR 2025 tables: marathon factor 1.0000 at 29, 0.9455 at 44
  assert.equal(fmtDur(ageAdjustTime(12045, 29, 44)), '3:32:19');
  assert.ok(ageFactor(60, 5000, 'F') !== ageFactor(60, 5000, 'M'), 'tables are per sex');
  const at50 = compare(BY_ID.get('bryan-cranston-marathon-1985'), P, 50);
  assert.equal(at50.beats_raw, false, 'raw: Cranston 3:20:45 is still faster');
  assert.equal(at50.beats_age_adjusted, true, 'his 29-year-old run is worth less at 50');
  const whitlock = compare(BY_ID.get('ed-whitlock-toronto-2003'), P, 44);
  assert.equal(whitlock.beats_age_adjusted, false, '2:54:48 at 72 survives any adjustment');
  assert.equal(compare(BY_ID.get('bryan-cranston-marathon-1985'), P, null).their_seconds_at_your_age, null);
});

t('streaks count consecutive days, not volume', () => {
  const daily = [];
  for (let i = 0; i < 40; i++) daily.push({ id: 's' + i, sport: 'run', start_ts: NOW - (40 - i) * 86400, distance_m: 3000, moving_s: 900, elev_m: 0 });
  const p2 = buildProfile(daily, [], NOW);
  assert.equal(p2.longestStreak('run', 1609), 40);
  assert.equal(p2.currentStreak('run', 1609), 40);
  assert.equal(judge(BY_ID.get('reference-run-streak-100'), p2).status, STATUS.TRAINABLE);
  assert.equal(judge({ id: 'z', check: { kind: 'streak', sport: 'run', min_m: 1609, days: 30 }, tier: 2 }, p2).status, STATUS.CRUSHED);
});

t('capacity does not equal having gone and done it', () => {
  // 96 km in 8 days is inside the demo athlete's training, but Kokoda is in Papua New Guinea
  const v = judge(BY_ID.get('reference-kokoda-track'), P);
  assert.equal(v.status, STATUS.IN_REACH);
  assert.equal(v.gated_from_crushed, true);
  assert.ok(/gone and done/.test(v.headline), v.headline);
  // a logged attempt still crushes it
  const logged = judge(BY_ID.get('reference-kokoda-track'), P, [{ verified: 1, date: '2026-05-01' }]);
  assert.equal(logged.status, STATUS.CRUSHED);
  // and an ungated capacity benchmark is crushed on data alone
  assert.equal(judge(BY_ID.get('reference-elev-8848-month'), P).status, STATUS.CRUSHED);
});

t('VO₂max is estimated from race pace, and grades against itself', () => {
  assert.ok(P.vo2max > 40 && P.vo2max < 60, `vo2max ${P.vo2max}`);
  assert.equal(judge(BY_ID.get('reference-vo2max-70'), P).status, STATUS.FAR);
  assert.equal(judge(BY_ID.get('reference-vo2max-50'), P).status, STATUS.CLOSE);
  assert.equal(judge(BY_ID.get('reference-vo2max-50'), buildProfile([], [], NOW)).status, STATUS.LOGBOOK);
});

t('predictions carry a confidence band that widens with worse evidence', () => {
  const near = P.predictBand(21097.5), far = P.predictBand(160934);
  assert.ok(far.pct > near.pct, 'extrapolating further should widen the band');
  assert.ok(near.low < near.mid && near.mid < near.high);
  const noRaces = buildProfile(activities, [], NOW);          // same runs, no measured efforts
  assert.ok(noRaces.predictBand(42195).pct > P.predictBand(42195).pct);
});

t('the week-by-week build ramps up, dips and tapers', () => {
  const plan = planFor(BY_ID.get('harry-styles-marathon-2025'), P, '2027-03-01', NOW);
  const w = plan.weeks;
  assert.ok(w.length > 20, `only ${w.length} weeks`);
  assert.ok(w.at(-1).phase === 'race week' && w.at(-1).km < w[0].km, 'should taper');
  const peak = Math.max(...w.map(x => x.km));
  assert.ok(peak >= w[0].km, 'volume must build, not shrink');
  assert.ok(peak <= plan.targets.peak_weekly_km + 0.01, 'never exceed the peak target');
  for (let i = 1; i < w.length; i++)
    if (w[i].phase !== 'recovery' && w[i - 1].phase !== 'recovery' && i < w.length - 3)
      assert.ok(w[i].km <= w[i - 1].km * 1.081, `week ${i + 1} ramps too hard`);
  assert.ok(w.some(x => x.phase === 'recovery'), 'no down weeks in the plan');
});

t('Terry Fox is never a target', () => {
  const v = judge(FEATS.find(f => f.sacred), P, [{ verified: 1, date: '2026-01-01' }]);
  assert.equal(v.status, STATUS.SACRED);
});

t('triathlon projection sums three sports plus transitions', () => {
  const v = judge(BY_ID.get('gordon-ramsay-ironman-world-championship'), P);
  assert.ok(v.splits, 'expected splits');
  assert.ok(v.you > v.splits.swim + v.splits.bike, 'total should exceed swim+bike');
  assert.ok(v.you > 8 * 3600 && v.you < 24 * 3600, `implausible ironman projection ${fmtDur(v.you)}`);
});

t('plans quantify what the target actually demands', () => {
  const plan = planFor(BY_ID.get('harry-styles-marathon-2025'), P, '2027-09-13', NOW);
  assert.ok(plan.weeks_remaining > 0);
  assert.ok(plan.targets.peak_weekly_km >= 60 && plan.targets.peak_weekly_km <= 120);
  assert.equal(plan.targets.race_pace_str, '4:15/km');
  assert.ok(plan.steps.length >= 4);
  const window = planFor(FEATS.find(f => f.id.startsWith('eddie-izzard-43')), P, '2028-01-01', NOW);
  assert.ok(window.targets.per_day_km > 30);
  assert.ok(window.weeks_needed > 0);
});

t('no data means no false confidence', () => {
  const empty = buildProfile([], [], NOW);
  const v = judge(BY_ID.get('oprah-winfrey-marathon-1994'), empty);
  assert.equal(v.status, STATUS.LOGBOOK);
  assert.equal(empty.fitness.ctl, 0);
});

t('Daniels gives a second opinion and disagreement widens the band', () => {
  assert.ok(Math.abs(danielsTime(vdot(1200, 5000), 5000) - 1200) < 0.01, 'inverse round-trips');
  const b = P.predictBand(42195);
  assert.ok(b.alt > 2 * 3600 && b.alt < 5 * 3600, `daniels marathon ${b.alt}`);
  assert.equal(P.predictBand(160934).alt, null, 'no Daniels past the range it was fitted on');
});

t('Eddington number counts days, in either unit', () => {
  const day = i => NOW - i * 86400;
  const rides = Array.from({ length: 30 }, (_, i) => ({ sport: 'ride', start_ts: day(i), distance_m: (i < 10 ? 50 : 5) * 1000, moving_s: 3600 }));
  const p = buildProfile(rides, [], NOW);
  assert.equal(p.eddingtons.ride_km, 10);         // ten days of 50 km; the 5 km days cannot lift it
  assert.equal(p.eddingtons.ride_mi, 10);         // 50 km is 31 miles
  const edd = BY_ID.get('arthur-eddington-number-84');
  const v = judge(edd, p);
  assert.equal(v.you, 10);
  assert.notEqual(v.status, STATUS.CRUSHED);
  const big = buildProfile(Array.from({ length: 84 }, (_, i) => ({ sport: 'ride', start_ts: day(i), distance_m: 136000, moving_s: 20000 })), [], NOW);
  assert.equal(judge(edd, big).status, STATUS.CRUSHED);
});

t('a logged race time calibrates the model, shrunk toward no change', () => {
  const base = P.predictRun(42195);
  const attempts = [{ feat_id: 'gordon-ramsay-marathon-2004', date: new Date(NOW * 1000).toISOString().slice(0, 10), value: base * 1.1, unit: 's' }];
  const races = racesFrom(attempts, BY_ID);
  assert.equal(races.length, 1);
  const cal = buildProfile(activities, efforts.map(e => ({ ...e })), NOW, {}, races);
  assert.ok(cal.calibration.bias > 1.02 && cal.calibration.bias < 1.08, `bias ${cal.calibration.bias}`);   // half of a 10% miss
  assert.ok(cal.predictRun(42195) > base);
  assert.equal(racesFrom([{ feat_id: 'gordon-ramsay-marathon-2004', date: '2026-01-01' }], BY_ID).length, 0, 'no time, no race');
});

t('milestones date each crushed feat to the day it fell', () => {
  const ms = milestones(FEATS, activities, efforts.map(e => ({ ...e })), {}, NOW);
  const crushedNow = FEATS.filter(f => judge(f, P).status === STATUS.CRUSHED).length;
  assert.equal(ms.length, crushedNow);
  assert.ok(ms.length >= 2);
  const first = Math.min(...activities.map(a => a.start_ts)) - 86400;
  for (const m of ms) {
    const ts = dayStart(m.date);
    assert.ok(ts >= first && ts <= NOW + 86400, `date out of range: ${m.date}`);
    // crushed on its date, not the day before
    const upTo = end => buildProfile(activities.filter(a => a.start_ts <= end), efforts.filter(e => e.start_ts <= end), end);
    assert.equal(judge(BY_ID.get(m.feat_id), upTo(ts + 86399)).status, STATUS.CRUSHED);
    assert.notEqual(judge(BY_ID.get(m.feat_id), upTo(ts - 1)).status, STATUS.CRUSHED);
  }
  const logged = milestones(FEATS, [], [], { 'gordon-ramsay-marathon-2004': [{ verified: 1, date: '2025-04-27' }] }, NOW);
  assert.deepEqual(logged.map(m => [m.feat_id, m.date]), [['gordon-ramsay-marathon-2004', '2025-04-27']]);
});

console.log('providers');
t('garmin CSV parses quoted fields, hh:mm:ss and thousands separators', () => {
  const csv = `Activity Type,Date,Favorite,Title,Distance,Calories,Time,Avg HR,Max HR,Total Ascent,Moving Time
Running,2026-03-01 07:12:00,false,"Long, slow one",32.10,"2,410",3:01:44,142,168,412,3:00:12
Cycling,2026-03-02 09:00:00,false,Commute,18.4,520,0:42:10,128,155,88,0:41:30`;
  const rows = parseCsv(csv);
  assert.equal(rows.length, 3);
  const acts = importCsv(csv);
  assert.equal(acts.length, 2);
  assert.equal(acts[0].sport, 'run');
  assert.equal(Math.round(acts[0].distance_m), 32100);
  assert.equal(acts[0].moving_s, 3 * 3600 + 12);
  assert.equal(acts[0].elev_m, 412);
  assert.equal(acts[1].sport, 'ride');
});

t('imperial CSVs convert', () => {
  const csv = `Activity Type,Date,Distance,Time\nRunning,2026-03-01 07:00:00,10.00,1:20:00`;
  assert.equal(Math.round(importCsv(csv, 'imperial')[0].distance_m), 16093);
});

t('gpx import measures distance, gain and elapsed', () => {
  const pt = (lat, lon, ele, t) => `<trkpt lat="${lat}" lon="${lon}"><ele>${ele}</ele><time>${t}</time></trkpt>`;
  const gpx = `<gpx><trk><name>Test</name><type>running</type><trkseg>
    ${pt(43.0, -79.0, 100, '2026-04-01T08:00:00Z')}
    ${pt(43.01, -79.0, 120, '2026-04-01T08:06:00Z')}
    ${pt(43.02, -79.0, 110, '2026-04-01T08:12:00Z')}</trkseg></trk></gpx>`;
  const [a] = importGpx(gpx);
  assert.equal(a.sport, 'run');
  assert.ok(Math.abs(a.distance_m - 2224) < 30, `distance ${a.distance_m}`);   // 0.02° latitude ≈ 2.22 km
  assert.equal(a.elapsed_s, 720);
  assert.equal(Math.round(a.elev_m), 20);
});

t('dedupe collapses the same session arriving from two providers', () => {
  const s = { sport: 'run', start_ts: 1789000000, distance_m: 10000 };
  const g = { sport: 'run', start_ts: 1789000200, distance_m: 10040 };       // 3 min and 40 m apart
  assert.equal(dedupeKey(s), dedupeKey(g));
  assert.notEqual(dedupeKey(s), dedupeKey({ ...s, sport: 'ride' }));
});

// ---------------------------------------------------------------- static build
// The PWA answers the same routes in the browser. Same engine, same JSON, no server.
console.log('static build');

const fresh = () => backend({ FEATS, BY_ID, stats }, memStore());

await ta('the in-browser backend serves the same state payload', async () => {
  const api = fresh();
  const seeded = await api('/api/demo', 'POST', {});
  assert.ok(seeded.added > 200, `only ${seeded.added} demo activities`);
  const st = await api('/api/state');
  assert.equal(st.static, true);
  assert.equal(st.feat_stats.total, FEATS.length);
  assert.equal(Object.keys(st.verdicts).length, FEATS.length);
  assert.ok(st.profile.pbs.length && st.profile.fitness.ctl > 0);
  assert.ok(st.profile.eddingtons.run_km > 0 && st.profile.calibration.bias === 1);
  assert.ok((await api("/api/milestones")).length >= 2);
  assert.ok(Object.values(st.verdicts).some(v => v.status === STATUS.CRUSHED));
  assert.equal(st.providers.strava.connected, false);         // no OAuth without a server
  assert.equal(st.providers.garmin.import, true);
});

await ta('queue and goals round-trip through browser storage', async () => {
  const api = fresh();
  const a = FEATS[0].id, b = FEATS[1].id;
  await api('/api/queue', 'POST', { feat_id: a });
  let q = await api('/api/queue', 'POST', { feat_id: b });
  assert.deepEqual(q.map(x => x.feat_id), [a, b]);
  q = await api(`/api/queue/${q[1].id}`, 'PATCH', { move: 'up' });
  assert.deepEqual(q.map(x => x.feat_id), [b, a]);
  await api('/api/queue', 'POST', { feat_id: a });             // already queued, not a duplicate
  assert.equal((await api('/api/queue', 'POST', { feat_id: a })).length, 2);
  q = await api(`/api/queue/${q[0].id}`, 'DELETE');
  assert.deepEqual(q.map(x => x.feat_id), [a]);

  await api('/api/demo', 'POST', {});
  const marathon = FEATS.find(f => f.check.kind === 'run_time' && f.check.distance_m === 42195 && !f.reference);
  const [g] = await api('/api/goals', 'POST', { feat_id: marathon.id, target_date: '2027-05-01' });
  const plan = await api(`/api/goals/${g.id}/plan`, 'GET');
  assert.ok(plan.weeks.length > 4 && plan.steps.length, 'goal plan came back empty');
  assert.equal((await api(`/api/goals/${g.id}`, 'DELETE')).length, 0);
});

await ta('a logged attempt outranks the model in the browser too', async () => {
  const api = fresh();
  const manual = FEATS.find(f => f.check.kind === 'manual' && !f.sacred);
  assert.equal((await api('/api/state')).verdicts[manual.id].status, STATUS.LOGBOOK);
  await api('/api/attempts', 'POST', { feat_id: manual.id, date: '2026-04-01', verified: true, evidence: 'video' });
  assert.equal((await api('/api/state')).verdicts[manual.id].status, STATUS.CRUSHED);
  await assert.rejects(() => api('/api/attempts', 'POST', { feat_id: manual.id }), /date required/);
  await assert.rejects(() => api('/api/attempts', 'POST', { feat_id: 'no-such-feat', date: '2026-04-01' }), /unknown feat/);
});

await ta('backup from the browser restores into an empty one', async () => {
  const src = fresh();
  const feat = FEATS.find(f => f.check.kind === 'manual' && !f.sacred);
  await src('/api/athlete', 'POST', { name: 'Test Runner', birth_year: 1985 });
  await src('/api/queue', 'POST', { feat_id: feat.id });
  await src('/api/attempts', 'POST', { feat_id: feat.id, date: '2026-04-01', verified: true });
  const backup = await src('/api/backup', 'GET');

  const dst = fresh();
  assert.ok((await dst('/api/restore', 'POST', backup)).restored >= 2);
  const st = await dst('/api/state');
  assert.equal(st.athlete.name, 'Test Runner');
  assert.equal(st.athlete.age, new Date().getFullYear() - 1985);
  assert.equal(st.queue[0].feat_id, feat.id);
  assert.equal(st.verdicts[feat.id].status, STATUS.CRUSHED);
  await assert.rejects(() => dst('/api/restore', 'POST', { version: 9 }), /version/);
});

await ta('file import is the static Strava door, and importing twice adds nothing', async () => {
  const api = fresh();
  const csv = ['"Activity ID","Activity Date","Activity Name","Activity Type","Elapsed Time","Distance","Max Heart Rate"',
    '"1","Apr 1, 2026, 8:00:00 AM","Morning Run","Run","3600","12.5","171"',
    '"2","Apr 3, 2026, 6:30:00 AM","Lunch Ride","Ride","5400","48.2","166"'].join('\n');
  const first = await api('/api/import/garmin', 'POST', { format: 'csv', text: csv });
  assert.deepEqual([first.parsed, first.added], [2, 2]);
  const again = await api('/api/import/garmin', 'POST', { format: 'csv', text: csv });
  assert.equal(again.added, 0, 'the same export imported twice should add nothing');
  const st = await api('/api/state');
  assert.equal(st.activity_count, 2);
  const run = st.activities.find(a => a.sport === 'run');
  assert.equal(run.distance_m, 12500);
  assert.equal(run.elapsed_s, 3600);
  assert.equal(run.max_hr, 171);
  assert.ok(run.start_ts > 1770000000, `unparsed Strava date: ${run.start_ts}`);
});

await ta('live sync says what a static build cannot do', async () => {
  await assert.rejects(() => fresh()('/api/sync/strava', 'POST', {}), /needs the local server/);
});

t('the PWA ships every file it promises, all by relative path', () => {
  const read = f => readFileSync(new URL(f, import.meta.url), 'utf8');
  const manifest = JSON.parse(read('./manifest.webmanifest'));
  for (const size of ['192x192', '512x512'])
    assert.ok(manifest.icons.some(i => i.sizes === size && i.type === 'image/png'), `manifest has no ${size} png`);
  assert.ok(manifest.icons.some(i => i.purpose === 'maskable'), 'no maskable icon');
  assert.equal(manifest.display, 'standalone');

  const shell = read('./index.html'), sw = read('./sw.js');
  // house font: the shared module loads before the stylesheet, and body text follows the reader's choice
  assert.ok(shell.indexOf('<script src="https://adervec.github.io/font.js"></script>') > 0 && shell.indexOf('font.js') < shell.indexOf('style.css'));
  assert.match(read('./public/style.css'), /body\{[^}]*font-family:var\(--app-font,/);
  const files = [...manifest.icons.map(i => i.src),
    ...[...sw.matchAll(/'\.\/([^']*)'/g)].map(m => './' + m[1]),
    ...[...shell.matchAll(/(?:src|href)="(\.\/[^"]+)"/g)].map(m => m[1])];
  for (const f of new Set(files.filter(f => f !== './')))
    assert.ok(existsSync(new URL(f, import.meta.url)), `referenced but missing: ${f}`);

  // A root-absolute path breaks under github.io/<repo>/ — the whole reason for ./ everywhere.
  for (const [name, src] of [['index.html', shell], ['sw.js', sw], ['manifest', read('./manifest.webmanifest')]])
    assert.ok(!/(?:src|href|"start_url"|"scope")\s*[=:]\s*"\/(?!\/)/.test(src), `${name} has a root-absolute path`);
  assert.ok(sw.includes('./data/feats-ledger.json'), 'the ledger is not precached for offline use');
});

// ---------------------------------------------------------------- sync
// Garmin arrives as a file written by tools/garmin-sync.py; the cloud carries the backup
// payload to the next device. Both are tested without touching a network.
console.log('sync');

const GARMIN_JSON = JSON.stringify({
  version: 1,
  activities: [
    { id: 111, type: 'running', start: '2026-04-01 08:00:00', distance_m: 21097.5, moving_s: 5820, elapsed_s: 5900, elev_m: 140, avg_hr: 162, max_hr: 178, name: 'Half' },
    { id: 112, type: 'lap_swimming', start: '2026-04-02T06:30:00Z', distance_m: 2000, moving_s: 2400 },
    { id: 113, type: 'cycling', start: '2026-04-03 17:00:00', distance_m: 48200, moving_s: 5400, elev_m: 610 },
    { id: 114, type: 'running', start: 'not a date', distance_m: 5000, moving_s: 1200 },
  ],
  bests: [{ activity_id: 111, distance_m: 5000, seconds: 1180, date: '2026-03-01' }],
});

t('the garmin-sync.py JSON maps onto the app shape', () => {
  const { activities, bests } = importJson(GARMIN_JSON);
  assert.equal(activities.length, 3, 'the undated row should have been dropped');
  assert.deepEqual(activities.map(a => a.sport), ['run', 'swim', 'ride']);
  const [half] = activities;
  assert.equal(half.id, 'garmin:111');
  assert.equal(half.distance_m, 21097.5);
  assert.equal(half.elapsed_s, 5900);
  assert.equal(half.max_hr, 178);
  assert.equal(new Date(half.start_ts * 1000).getUTCFullYear(), 2026);
  assert.deepEqual(bests, [{ activity_id: 'garmin:111', distance_m: 5000, seconds: 1180, start_ts: Math.floor(Date.parse('2026-03-01') / 1000) }]);
  assert.throws(() => importJson('{"nope":1}'), /no activities array/);
});

await ta('a watched-folder import lands activities and the measured bests', async () => {
  const api = fresh();
  const r = await api('/api/import/garmin', 'POST', { format: 'json', text: GARMIN_JSON });
  assert.deepEqual([r.parsed, r.added, r.bests], [3, 3, 1]);
  assert.equal((await api('/api/import/garmin', 'POST', { format: 'json', text: GARMIN_JSON })).added, 0, 're-running the script must not double up');
  const st = await api('/api/state');
  assert.equal(st.activity_count, 3);
  // A measured 5k PR beats anything inferred from an average pace.
  const pb5k = st.profile.pbs.find(x => x.distance_m === 5000);
  assert.ok(pb5k?.measured, '5k PR did not arrive as a measured best effort');
  assert.equal(pb5k.seconds, 1180);
});

t('the folder watcher only claims files that look like ours', () => {
  for (const ok of ['crusher-garmin-activities.json', 'Activities.csv', 'garmin_2026.gpx', 'my-activities.JSON'])
    assert.ok(Sync.matchesGarminFile(ok), `should match: ${ok}`);
  for (const no of ['notes.txt', 'budget.json', 'photo.jpg', 'garmin.md'])
    assert.ok(!Sync.matchesGarminFile(no), `should not match: ${no}`);
});

// A provider is only upload/download/stat over a name, so a Map stands in for Drive.
const fakeCloud = () => {
  const files = new Map();
  return {
    files,
    id: 'fake', label: 'Fake cloud',
    supported: () => true, available: () => true,
    connect: async () => ({}), isConnected: async () => true, disconnect: async () => {},
    upload: async (_c, name, blob) => { files.set(name, { text: await blob.text(), at: Date.now() }); },
    download: async (_c, name) => (files.has(name) ? new Blob([files.get(name).text]) : null),
    stat: async (_c, name) => files.get(name)?.at ?? null,
  };
};
const apiFor = h => (path, opts) => h(path, opts?.method || (opts ? 'POST' : 'GET'), opts?.body || {});

await ta('sync carries your work to a second device and converges there', async () => {
  const cloud = fakeCloud();
  const phone = fresh(), laptop = fresh();
  const feat = FEATS.find(f => f.check.kind === 'manual' && !f.sacred);
  await phone('/api/athlete', 'POST', { name: 'Two Devices', birth_year: 1990 });
  await phone('/api/queue', 'POST', { feat_id: feat.id });
  await phone('/api/goals', 'POST', { feat_id: feat.id, target_date: '2027-06-01' });
  await phone('/api/attempts', 'POST', { feat_id: feat.id, date: '2026-05-05', verified: true });

  const up = await Sync.syncNow(cloud, {}, apiFor(phone));
  assert.ok(up.bytes > 0 && cloud.files.has(Sync.BACKUP_FILE_NAME), 'nothing reached the cloud');

  await Sync.syncNow(cloud, {}, apiFor(laptop));
  const st = await laptop('/api/state');
  assert.equal(st.athlete.name, 'Two Devices');
  assert.equal(st.queue.length, 1);
  assert.equal(st.goals.length, 1);
  assert.equal(st.verdicts[feat.id].status, STATUS.CRUSHED, 'the logged attempt did not travel');

  // The auto-sync timer fires repeatedly; a second pass must change nothing.
  await Sync.syncNow(cloud, {}, apiFor(laptop));
  await Sync.syncNow(cloud, {}, apiFor(laptop));
  const again = await laptop('/api/state');
  assert.deepEqual([again.queue.length, again.goals.length, again.attempts.length], [1, 1, 1], 'syncing twice duplicated rows');

  // And a change made on the laptop comes back to the phone.
  await laptop('/api/goals', 'POST', { feat_id: feat.id, target_date: '2028-01-01' });
  await Sync.syncNow(cloud, {}, apiFor(laptop));
  await Sync.syncNow(cloud, {}, apiFor(phone));
  assert.equal((await phone('/api/state')).goals.length, 2);
});

await ta('an empty cloud is not an error, it is just the first sync', async () => {
  const r = await Sync.restoreFrom(fakeCloud(), {}, apiFor(fresh()));
  assert.equal(r.empty, true);
  assert.equal(r.restored, 0);
});

t('the Google profile picture is drawn beside the account name, https only', () => {
  assert.equal(Sync.avatarUrl({ picture: 'https://lh3.googleusercontent.com/a/x=s96-c' }), 'https://lh3.googleusercontent.com/a/x=s96-c');
  for (const bad of [null, {}, { picture: '' }, { picture: 'javascript:alert(1)' }, { picture: 'http://x/y.png' }]) assert.equal(Sync.avatarUrl(bad), '');
  assert.equal(Sync.googleDriveProvider.accountPicture(), '', 'nothing when signed out');
  const app = readFileSync('./public/app.js', 'utf8');
  assert.ok(app.includes('accountPicture') && app.includes("referrerPolicy: 'no-referrer'"));
});

t('Drive is gated to the origins its client id is registered for', () => {
  assert.ok(Sync.BUILTIN_DRIVE_CLIENT_ID.endsWith('.apps.googleusercontent.com'));
  assert.equal(Sync.driveClientId({ driveClientId: ' mine-123 ' }), 'mine-123');   // a fork's own id wins
  assert.equal(Sync.driveClientId({}), '');                                        // no `location` in node
  assert.equal(Sync.googleDriveProvider.available({}).ok, false);
  assert.equal(Sync.googleDriveProvider.available({ driveClientId: 'x' }), true);
});

console.log('house standards');

/** A Storage stand-in that fails the test if anyone wipes the shared origin. */
const fakeStorage = init => {
  const m = new Map(Object.entries(init));
  return { getItem: k => m.has(k) ? m.get(k) : null, setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k),
    clear: () => { throw new Error('localStorage.clear() wipes every app on the origin'); }, m };
};

t('no third-party requests: fonts are self-hosted on adervec.github.io', () => {
  const shell = readFileSync('./index.html', 'utf8');
  assert.ok(!/fonts\.googleapis|fonts\.gstatic|preconnect/.test(shell), 'Google Fonts still referenced');
  for (const f of ['fraunces', 'newsreader', 'jetbrains-mono'])
    assert.ok(shell.includes(`<link rel="stylesheet" href="https://adervec.github.io/fonts/${f}.css">`), `${f} not self-hosted`);
  const hosts = [...shell.matchAll(/(?:src|href)="(https?:\/\/[^/"]+)/g)].map(x => x[1]);
  assert.deepEqual([...new Set(hosts)], ['https://adervec.github.io'], `external hosts: ${hosts}`);
});

await ta('erase removes this app\'s data on this device and nothing else', async () => {
  const st = fakeStorage({
    'crusher.v1': '{}', 'crusher.sync': '{}', 'maker-font': 'mono', 'gymtracker.v3': '{"x":1}',
    'portal-activity': JSON.stringify([[1, 'GymTracker315', 'lift', 3], [2, 'CelebrityCrusher', 'cardio', 4]]),
    'portal-installed': JSON.stringify({ CelebrityCrusher: 1, Tachyread: 2 }),
  });
  eraseLocalData(st);
  for (const k of OWN_KEYS) assert.equal(st.getItem(k), null, `${k} survived`);
  assert.equal(st.getItem('maker-font'), 'mono');
  assert.equal(st.getItem('gymtracker.v3'), '{"x":1}');
  assert.deepEqual(JSON.parse(st.getItem('portal-activity')), [[1, 'GymTracker315', 'lift', 3]]);
  assert.deepEqual(JSON.parse(st.getItem('portal-installed')), { Tachyread: 2 });
  // the store itself, through the same route the button calls
  const api = fresh();
  await api('/api/demo', 'POST', {});
  await api('/api/queue', 'POST', { feat_id: 'gordon-ramsay-marathon-2004' });
  assert.deepEqual(await api('/api/erase', 'POST', {}), { erased: true });
  const after = await api('/api/state');
  assert.equal(after.activity_count, 0);
  assert.equal(after.queue.length, 0);
  // the button confirms first, disconnects sync, and says the cloud copy is untouched
  const app = readFileSync('./public/app.js', 'utf8'), at = app.indexOf("case 'erase-all'");
  const body = app.slice(at, app.indexOf('break; }', at));
  assert.ok(body.indexOf('window.confirm') >= 0 && body.indexOf('window.confirm') < body.indexOf("api('/api/erase'"), 'confirm comes first');
  assert.ok(body.includes('disconnect') && body.includes('eraseHandles') && /Drive[^']*not touched/.test(body));
  assert.ok(!/localStorage\.clear\(\)/.test(app.replace(/\/\/.*$/gm, '')));
});

await ta('real activity is reported to the maker portal; demo data is not', async () => {
  const st = fakeStorage({ 'portal-activity': JSON.stringify([[1, 'Tachyread', 'read', 2]]) });
  logActivity(st, [[1000, 3000], [2000, 30]]);
  assert.deepEqual(JSON.parse(st.getItem('portal-activity')).slice(1), [[1000, 'CelebrityCrusher', 'cardio', 5], [2000, 'CelebrityCrusher', 'cardio', 1]]);
  const seen = [];
  const api = backend({ FEATS, BY_ID, stats }, memStore(), rows => seen.push(...rows));
  await api('/api/demo', 'POST', {});
  assert.equal(seen.length, 0, 'the demo athlete is synthetic');
  const ts = Math.floor(Date.now() / 1000) - 3600, old = ts - 400 * 86400;
  const r = await api('/api/import/garmin', 'POST', { format: 'json', text: JSON.stringify({ activities: [
    { id: 7, type: 'running', start: new Date(ts * 1000).toISOString(), distance_m: 10000, moving_s: 3000 },
    { id: 8, type: 'running', start: new Date(old * 1000).toISOString(), distance_m: 10000, moving_s: 3000 },
  ] }) });
  assert.equal(r.added, 2);
  assert.deepEqual(seen, [[ts, 3000]], 'recent sessions only, so an archive cannot flood the shared list');
  await api('/api/attempts', 'POST', { feat_id: 'gordon-ramsay-marathon-2004', date: '2025-04-27', value: 12600, unit: 's', verified: 1 });
  assert.deepEqual(seen[1], [dayStart('2025-04-27') + 12 * 3600, 12600]);
});

t('the repo carries the MIT licence', () => {
  assert.ok(/^MIT License/.test(readFileSync('./LICENSE', 'utf8')));
});

t('a calendar day is the local day (TZ=America/Sao_Paulo)', () => {
  // 22:30 local on 10 March is 01:30 UTC on the 11th. Every day the app shows must be the 10th.
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', `
    import { buildProfile, buildWeeks, milestones, localYmd, localDay, dayStr, dayStart } from './lib/engine.js';
    const ts = new Date('2026-03-10T22:30:00').getTime() / 1000;
    const act = { id: 'a', sport: 'run', start_ts: ts, distance_m: 12000, moving_s: 3600 };
    const p = buildProfile([act], [], ts + 600);
    const feat = { id: 'f', check: { kind: 'distance_window', sport: 'run', days: 1, meters: 10000 } };
    console.log(JSON.stringify({
      utc: new Date(ts * 1000).toISOString().slice(0, 10), local: localYmd(new Date(ts * 1000)),
      bucket: dayStr(p.series.day0), ran: p.series.byDaySport.run.at(-1),
      milestone: milestones([feat], [act], [], {}, ts + 600)[0]?.date,
      week1: buildWeeks(20, 30, 15, 4, {}, ts)[0].start,
      midnight: dayStart('2026-03-10') === new Date(2026, 2, 10).getTime() / 1000,
    }));`], { env: { ...process.env, TZ: 'America/Sao_Paulo' }, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(out), {
    utc: '2026-03-11', local: '2026-03-10', bucket: '2026-03-10', ran: 12000,
    milestone: '2026-03-10', week1: '2026-03-10', midnight: true,
  });
  // and the UI never takes a day from UTC
  for (const f of ['./public/app.js', './lib/engine.js', './public/local.js'])
    assert.ok(!/toISOString\(\)\.slice\(0, (10|7)\)/.test(readFileSync(f, 'utf8')), `${f} still takes a day from UTC`);
});

console.log(`\n${n} checks passed`);
