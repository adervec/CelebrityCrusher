// The whole backend, in the browser. Same engine, same ledger, same JSON shapes as
// server.mjs — SQLite swapped for one localStorage blob, so the app works as an
// installed PWA off GitHub Pages with no server anywhere.
//
// What cannot follow it here: Strava and Garmin OAuth. Both exchanges need a client
// secret, which a static page cannot hold. File import covers both providers instead.
//
// ponytail: one JSON blob in localStorage (~5 MB). That is thousands of activities.
// Move to IndexedDB if someone imports a decade of riding and hits the quota.
import { assemble, FILES } from '../lib/feats-core.js';
import { buildProfile, judge, planFor, compare, dedupeKey, racesFrom, milestones } from '../lib/engine.js';
import { importCsv, importGpx, importJson } from '../lib/garmin.js';
import { demoActivities } from '../lib/demo.js';

const KEY = 'crusher.v1';
const now = () => Math.floor(Date.now() / 1000);
const blank = () => ({
  athlete: { id: 1, name: 'Athlete', sex: null, birth_year: null, weight_kg: null, settings: {} },
  activities: [], best_efforts: [], queue: [], goals: [], attempts: [], sync_log: [], seq: 0,
});

export const localStore = () => ({
  read() { try { return { ...blank(), ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { return blank(); } },
  write(db) {
    try { localStorage.setItem(KEY, JSON.stringify(db)); }
    catch { throw new Error('Browser storage is full — export a backup, then clear demo or imported data.'); }
  },
});

/** Memory-only store, for tests. */
export const memStore = (seed = blank()) => { let d = seed; return { read: () => d, write: v => { d = v; } }; };

const ACT_FIELDS = a => ({
  id: a.id, provider: a.provider, sport: a.sport, start_ts: a.start_ts,
  distance_m: a.distance_m || 0, moving_s: a.moving_s || 0, elapsed_s: a.elapsed_s || a.moving_s || 0,
  elev_m: a.elev_m || 0, avg_hr: a.avg_hr ?? null, max_hr: a.max_hr ?? null,
  name: a.name || '', dedupe_key: dedupeKey(a),
});

/** Mirrors DB.upsertActivities: same session twice (Garmin → Strava) lands once. */
function upsertActivities(db, acts) {
  const ids = new Set(db.activities.map(a => a.id));
  const keys = new Set(db.activities.map(a => a.dedupe_key));
  let added = 0;
  for (const a of acts) {
    const row = ACT_FIELDS(a);
    if (ids.has(row.id) || keys.has(row.dedupe_key)) continue;
    db.activities.push(row); ids.add(row.id); keys.add(row.dedupe_key); added++;
  }
  db.activities.sort((x, y) => x.start_ts - y.start_ts);
  return added;
}

function upsertBestEfforts(db, activityId, startTs, efforts) {
  for (const e of efforts) {
    const distance_m = Math.round(e.distance_m), seconds = Math.round(e.seconds);
    const i = db.best_efforts.findIndex(b => b.activity_id === activityId && b.distance_m === distance_m);
    const row = { activity_id: activityId, distance_m, seconds, start_ts: startTs };
    if (i >= 0) db.best_efforts[i] = row; else db.best_efforts.push(row);
  }
}

const logSync = (db, provider, added, message) =>
  db.sync_log.push({ id: ++db.seq, provider, started_ts: now(), finished_ts: now(), status: 'ok', added, message });

const byPosition = q => [...q].sort((a, b) => (a.position - b.position) || (a.id - b.id));
const byCreated = g => [...g].sort((a, b) => b.created_ts - a.created_ts);
const byDate = a => [...a].sort((x, y) => String(y.date).localeCompare(String(x.date)));

/**
 * @param {{FEATS:Array, BY_ID:Map, stats:Function}} ledger
 * @param {{read:Function, write:Function}} store
 * @returns {(path:string, method?:string, body?:object) => Promise<any>} same contract as fetch(/api/…).json()
 */
export function backend(ledger, store) {
  const { FEATS, BY_ID, stats } = ledger;
  const profile = db => buildProfile(db.activities, db.best_efforts, now(), db.athlete, racesFrom(db.attempts, BY_ID));

  function fullState(db) {
    const p = profile(db);
    const yourAge = db.athlete.birth_year ? new Date().getFullYear() - db.athlete.birth_year : null;
    const att = {};
    for (const a of byDate(db.attempts)) (att[a.feat_id] ||= []).push(a);
    const verdicts = {};
    for (const f of FEATS) {
      verdicts[f.id] = judge(f, p, att[f.id] || []);
      const h = compare(f, p, yourAge);
      if (h) verdicts[f.id].h2h = h;
    }
    return {
      generated_at: p.generated_at,
      static: true,
      athlete: { ...db.athlete, age: yourAge },
      feats: FEATS, feat_stats: stats(), verdicts,
      profile: {
        counts: p.counts, fitness: p.fitness, weekly: p.weekly, maxes: p.maxes, k: p.k, vo2max: p.vo2max,
        bands: [5000, 10000, 21097.5, 42195].map(d => ({ distance_m: d, ...(p.predictBand(d) || {}) })),
        improveRate: p.improveRate, thresholds: p.thresholds, eddingtons: p.eddingtons, calibration: p.calibration,
        pbs: p.pbs.map(x => ({ ...x, predicted: x.predicted ?? null })),
        windows: [1, 7, 14, 30, 51, 90, 143].map(d => ({ days: d, run: p.bestWindow('run', d), ride: p.bestWindow('ride', d), all: p.bestWindow('multi', d) })),
        series: p.series,
      },
      activities: db.activities.slice(-60).reverse(),
      activity_count: db.activities.length,
      queue: byPosition(db.queue), goals: byCreated(db.goals), attempts: byDate(db.attempts),
      sync_log: [...db.sync_log].sort((a, b) => b.id - a.id).slice(0, 12),
      connections: [],
      providers: {
        strava: { configured: false, connected: false, import: true },
        garmin: { configured: false, connected: false, import: true },
      },
    };
  }

  return async function handle(rawPath, method = 'GET', body = {}) {
    const url = new URL(rawPath, 'http://local');
    const path = url.pathname.replace(/^\/api/, '');
    const db = store.read();
    const save = () => store.write(db);
    const id = () => +path.split('/')[2];
    const feat = fid => { const f = BY_ID.get(fid); if (!f) throw new Error('unknown feat'); return f; };

    if (method === 'GET' && path === '/state') return fullState(db);

    if (method === 'GET' && path === '/milestones') {
      const att = {};
      for (const a of byDate(db.attempts)) (att[a.feat_id] ||= []).push(a);
      return milestones(FEATS, db.activities, db.best_efforts, att, now(), db.athlete);
    }

    if (method === 'POST' && /^\/sync\//.test(path))
      throw new Error('Live provider sync needs the local server (OAuth needs a client secret). Import a Strava or Garmin export file instead.');

    if (method === 'POST' && path === '/import/garmin') {
      // json = what tools/garmin-sync.py writes; csv/gpx = what Garmin Connect or Strava exports.
      const r = body.format === 'json' ? importJson(body.text)
        : { activities: body.format === 'gpx' ? importGpx(body.text, body.name) : importCsv(body.text, body.units || 'metric'), bests: [] };
      const added = upsertActivities(db, r.activities);
      for (const e of r.bests) upsertBestEfforts(db, e.activity_id, e.start_ts, [e]);
      logSync(db, 'file-import', added, `${body.format || 'csv'} import: ${r.activities.length} rows${r.bests.length ? `, ${r.bests.length} bests` : ''}`);
      save();
      return { added, parsed: r.activities.length, bests: r.bests.length };
    }

    if (method === 'POST' && path === '/demo') {
      if (body.clear) {
        db.activities = db.activities.filter(a => a.provider !== 'demo');
        db.best_efforts = db.best_efforts.filter(b => !String(b.activity_id).startsWith('demo:'));
        save();
        return { cleared: true };
      }
      const { activities: acts, efforts } = demoActivities(now());
      const added = upsertActivities(db, acts);
      for (const e of efforts) upsertBestEfforts(db, e.activity_id, e.start_ts, [e]);
      logSync(db, 'demo', added, 'seeded demo athlete');
      save();
      return { added };
    }

    if (method === 'POST' && path === '/athlete') {
      for (const k of ['name', 'sex', 'birth_year', 'weight_kg']) if (body[k] != null) db.athlete[k] = body[k];
      if ('rival' in body) db.athlete.settings.rival = body.rival && BY_ID.has(body.rival) ? body.rival : null;
      save();
      return db.athlete;
    }

    if (method === 'GET' && path === '/backup') return {
      version: 1, exported_at: new Date().toISOString(),
      athlete: { ...db.athlete, settings: JSON.stringify(db.athlete.settings || {}) },
      queue: db.queue, goals: db.goals, attempts: db.attempts,
      manual_activities: db.activities.filter(a => !['strava', 'demo'].includes(a.provider)),
    };

    if (method === 'POST' && path === '/restore') {
      if (body.version !== 1) throw new Error('unrecognised backup version');
      let n = 0;
      if (body.athlete) {
        const s = body.athlete.settings;
        db.athlete = { ...db.athlete, ...body.athlete, settings: typeof s === 'string' ? JSON.parse(s || '{}') : (s || {}) };
      }
      for (const q of body.queue || []) if (BY_ID.has(q.feat_id) && !db.queue.some(x => x.feat_id === q.feat_id))
        { db.queue.push({ ...q, id: ++db.seq, created_ts: q.created_ts || now() }); n++; }
      // Cloud sync restores on every pull, so the same row arriving twice must land once:
      // a goal is identified by feat + date, an attempt by feat + date + metric.
      const same = (x, y) => (x ?? '') === (y ?? '');
      for (const g of body.goals || []) if (BY_ID.has(g.feat_id)
        && !db.goals.some(x => x.feat_id === g.feat_id && same(x.target_date, g.target_date)))
        { db.goals.push({ ...g, id: ++db.seq, created_ts: g.created_ts || now() }); n++; }
      for (const a of body.attempts || []) if (BY_ID.has(a.feat_id)
        && !db.attempts.some(x => x.feat_id === a.feat_id && x.date === a.date && same(x.metric, a.metric)))
        { db.attempts.push({ ...a, id: ++db.seq, created_ts: a.created_ts || now() }); n++; }
      if (body.manual_activities?.length) n += upsertActivities(db, body.manual_activities);
      save();
      return { restored: n };
    }

    // ---- queue
    if (method === 'POST' && path === '/queue') {
      feat(body.feat_id);
      if (!db.queue.some(q => q.feat_id === body.feat_id))
        db.queue.push({
          id: ++db.seq, feat_id: body.feat_id, position: db.queue.reduce((m, q) => Math.max(m, q.position || 0), 0) + 1,
          status: body.status || 'queued', target_date: body.target_date || null, notes: body.notes || null, created_ts: now(),
        });
      save();
      return byPosition(db.queue);
    }
    if (method === 'PATCH' && /^\/queue\/\d+$/.test(path)) {
      const rows = byPosition(db.queue), i = rows.findIndex(r => r.id === id());
      if (body.move) {
        const j = body.move === 'up' ? i - 1 : i + 1;
        if (i >= 0 && j >= 0 && j < rows.length) {
          const a = rows[i].position ?? i + 1, b = rows[j].position ?? j + 1;
          rows[i].position = b; rows[j].position = a;
        }
      } else if (i >= 0) {
        for (const k of ['status', 'target_date', 'notes']) if (body[k] != null) rows[i][k] = body[k];
      }
      save();
      return byPosition(db.queue);
    }
    if (method === 'DELETE' && /^\/queue\/\d+$/.test(path)) {
      db.queue = db.queue.filter(q => q.id !== id());
      save();
      return byPosition(db.queue);
    }

    // ---- goals
    if (method === 'POST' && path === '/goals') {
      feat(body.feat_id);
      db.goals.push({ id: ++db.seq, feat_id: body.feat_id, target_date: body.target_date || null, status: 'active', notes: body.notes || null, created_ts: now() });
      save();
      return byCreated(db.goals);
    }
    if (method === 'PATCH' && /^\/goals\/\d+$/.test(path)) {
      const g = db.goals.find(x => x.id === id());
      if (g) for (const k of ['target_date', 'status', 'notes']) if (body[k] != null) g[k] = body[k];
      save();
      return byCreated(db.goals);
    }
    if (method === 'DELETE' && /^\/goals\/\d+$/.test(path)) {
      db.goals = db.goals.filter(g => g.id !== id());
      save();
      return byCreated(db.goals);
    }
    if (method === 'GET' && /^\/goals\/\d+\/plan$/.test(path)) {
      const g = db.goals.find(x => x.id === id());
      if (!g) throw new Error('no such goal');
      return planFor(feat(g.feat_id), profile(db), g.target_date);
    }
    if (method === 'GET' && /^\/plan\//.test(path))
      return planFor(feat(decodeURIComponent(path.slice(6))), profile(db), url.searchParams.get('date'));

    // ---- attempts
    if (method === 'POST' && path === '/attempts') {
      feat(body.feat_id);
      if (!body.date) throw new Error('date required');
      db.attempts.push({
        id: ++db.seq, feat_id: body.feat_id, date: body.date, metric: body.metric || null,
        value: body.value ?? null, unit: body.unit || null, evidence: body.evidence || null,
        verified: body.verified ? 1 : 0, notes: body.notes || null, created_ts: now(),
      });
      save();
      return byDate(db.attempts);
    }
    if (method === 'DELETE' && /^\/attempts\/\d+$/.test(path)) {
      db.attempts = db.attempts.filter(a => a.id !== id());
      save();
      return byDate(db.attempts);
    }

    throw new Error(`no local route for ${method} ${path}`);
  };
}

/** Browser entry: load the ledger over fetch, hand back a ready `handle`. */
export async function boot() {
  const lists = await Promise.all(FILES.map(f =>
    fetch(new URL(`../data/${f}`, import.meta.url)).then(r => {
      if (!r.ok) throw new Error(`cannot load ${f} (${r.status})`);
      return r.json();
    })));
  return backend(assemble(lists), localStore());
}
