#!/usr/bin/env node
// Celebrity Crusher — node:http + node:sqlite, zero dependencies.
//   node server.mjs           → http://localhost:8787
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';
import * as DB from './lib/db.js';
import * as strava from './lib/strava.js';
import * as garmin from './lib/garmin.js';
import { FEATS, BY_ID, stats as featStats } from './lib/feats.js';
import { buildProfile, judge, planFor, compare, fmtDur, fmtKm, STATUS, racesFrom, milestones } from './lib/engine.js';
import { demoActivities } from './lib/demo.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = +(process.env.PORT || 8787);
const ORIGIN = process.env.APP_ORIGIN || `http://localhost:${PORT}`;
const db = DB.open(process.env.DB_FILE || join(ROOT, 'data', 'crusher.db'));

// .env, if present. ponytail: 6 lines beats a dotenv dependency.
const envFile = join(ROOT, '.env');
if (existsSync(envFile)) for (const line of readFileSync(envFile, 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const now = () => Math.floor(Date.now() / 1000);
const pending = new Map();                    // oauth state → {provider, verifier}

// ---------------------------------------------------------------- data access

const activities = () => DB.all(db, 'SELECT * FROM activities ORDER BY start_ts');
const bestEfforts = () => DB.all(db, 'SELECT * FROM best_efforts');
const attemptsByFeat = () => {
  const out = {};
  for (const a of DB.all(db, 'SELECT * FROM attempts ORDER BY date DESC')) (out[a.feat_id] ||= []).push(a);
  return out;
};

function profile() {
  const ath = DB.one(db, 'SELECT * FROM athlete WHERE id=1') || {};
  return buildProfile(activities(), bestEfforts(), now(), ath, racesFrom(DB.all(db, 'SELECT * FROM attempts'), BY_ID));
}

function fullState() {
  const p = profile();
  const att = attemptsByFeat();
  const ath0 = DB.one(db, 'SELECT * FROM athlete WHERE id=1');
  const yourAge = ath0?.birth_year ? new Date().getFullYear() - ath0.birth_year : null;
  const verdicts = {};
  for (const f of FEATS) {
    verdicts[f.id] = judge(f, p, att[f.id] || []);
    const h = compare(f, p, yourAge);
    if (h) verdicts[f.id].h2h = h;
  }
  const acts = activities();
  const conns = DB.all(db, 'SELECT provider, athlete_ref, connected_ts, scope, expires_at FROM connections');
  return {
    generated_at: p.generated_at,
    athlete: { ...ath0, age: yourAge, settings: JSON.parse(ath0?.settings || '{}') },
    feats: FEATS, feat_stats: featStats(), verdicts,
    profile: {
      counts: p.counts, fitness: p.fitness, weekly: p.weekly, maxes: p.maxes, k: p.k, vo2max: p.vo2max,
      bands: [5000, 10000, 21097.5, 42195].map(d => ({ distance_m: d, ...(p.predictBand(d) || {}) })),
      improveRate: p.improveRate, thresholds: p.thresholds, eddingtons: p.eddingtons, calibration: p.calibration,
      pbs: p.pbs.map(x => ({ ...x, predicted: x.predicted ?? null })),
      windows: [1, 7, 14, 30, 51, 90, 143].map(d => ({ days: d, run: p.bestWindow('run', d), ride: p.bestWindow('ride', d), all: p.bestWindow('multi', d) })),
      series: p.series,
    },
    activities: acts.slice(-60).reverse().map(a => ({ ...a, raw: undefined })),
    activity_count: acts.length,
    queue: DB.all(db, 'SELECT * FROM queue ORDER BY position, id'),
    goals: DB.all(db, 'SELECT * FROM goals ORDER BY created_ts DESC'),
    attempts: DB.all(db, 'SELECT * FROM attempts ORDER BY date DESC'),
    sync_log: DB.all(db, 'SELECT * FROM sync_log ORDER BY id DESC LIMIT 12'),
    connections: conns,
    providers: {
      strava: { configured: strava.configured(), connected: conns.some(c => c.provider === 'strava') },
      garmin: { configured: garmin.configured(), connected: conns.some(c => c.provider === 'garmin'), import: true },
    },
  };
}

// ---------------------------------------------------------------- sync

async function stravaToken() {
  const c = DB.one(db, `SELECT * FROM connections WHERE provider='strava'`);
  if (!c) throw new Error('Strava not connected');
  if (c.expires_at && c.expires_at < now() + 120) {
    const t = await strava.refresh(c.refresh_token);
    DB.run(db, `UPDATE connections SET access_token=?, refresh_token=?, expires_at=? WHERE provider='strava'`,
      t.access_token, t.refresh_token, t.expires_at);
    return t.access_token;
  }
  return c.access_token;
}

async function syncStrava({ full = false } = {}) {
  const started = now();
  const log = DB.run(db, `INSERT INTO sync_log (provider, started_ts, status) VALUES ('strava', ?, 'running')`, started);
  try {
    const token = await stravaToken();
    const last = DB.one(db, 'SELECT MAX(start_ts) t FROM activities WHERE provider=\'strava\'')?.t || 0;
    const acts = await strava.fetchActivities(token, full ? 0 : Math.max(0, last - 86400));
    const added = DB.upsertActivities(db, acts);
    // Detailed calls are the rate-limited ones: only long runs, newest first, capped.
    // ponytail: 15/sync keeps us far inside 100/15min. Raise it if you have patience.
    const need = acts.filter(a => a.sport === 'run' && a.distance_m >= 5000)
      .filter(a => !DB.one(db, 'SELECT 1 x FROM best_efforts WHERE activity_id=?', a.id))
      .sort((x, y) => y.start_ts - x.start_ts).slice(0, 15);
    for (const a of need) {
      try { DB.upsertBestEfforts(db, a.id, a.start_ts, await strava.fetchBestEfforts(token, a.id.split(':')[1])); }
      catch { /* rate limit or deleted activity — best efforts are a bonus, not the point */ }
    }
    DB.run(db, `UPDATE sync_log SET finished_ts=?, status='ok', added=?, message=? WHERE id=?`,
      now(), added, `${acts.length} fetched, ${need.length} detailed`, log.lastInsertRowid);
    return { added, fetched: acts.length };
  } catch (e) {
    DB.run(db, `UPDATE sync_log SET finished_ts=?, status='error', message=? WHERE id=?`, now(), String(e.message), log.lastInsertRowid);
    throw e;
  }
}

async function syncGarmin({ days = 30 } = {}) {
  const started = now();
  const log = DB.run(db, `INSERT INTO sync_log (provider, started_ts, status) VALUES ('garmin', ?, 'running')`, started);
  try {
    const c = DB.one(db, `SELECT * FROM connections WHERE provider='garmin'`);
    if (!c) throw new Error('Garmin not connected');
    let token = c.access_token;
    if (c.expires_at && c.expires_at < now() + 120 && c.refresh_token) {
      const t = await garmin.refresh(c.refresh_token);
      DB.run(db, `UPDATE connections SET access_token=?, refresh_token=?, expires_at=? WHERE provider='garmin'`,
        t.access_token, t.refresh_token, now() + (t.expires_in || 86400));
      token = t.access_token;
    }
    const acts = await garmin.fetchActivities(token, days);
    const added = DB.upsertActivities(db, acts);
    DB.run(db, `UPDATE sync_log SET finished_ts=?, status='ok', added=?, message=? WHERE id=?`,
      now(), added, `${acts.length} fetched over ${days}d`, log.lastInsertRowid);
    return { added, fetched: acts.length };
  } catch (e) {
    DB.run(db, `UPDATE sync_log SET finished_ts=?, status='error', message=? WHERE id=?`, now(), String(e.message), log.lastInsertRowid);
    throw e;
  }
}

/** One shape out of the three import formats: { acts, bests }. */
function readImport(b) {
  if (b.format === 'json') { const r = garmin.importJson(b.text); return { acts: r.activities, bests: r.bests }; }
  if (b.format === 'gpx') return { acts: garmin.importGpx(b.text, b.name), bests: [] };
  return { acts: garmin.importCsv(b.text, b.units || 'metric'), bests: [] };
}

// ---------------------------------------------------------------- http

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const json = (res, body, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const redirect = (res, to) => { res.writeHead(302, { location: to }); res.end(); };

async function body(req, limit = 20e6) {
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > limit) throw new Error('payload too large'); chunks.push(c); }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try { return JSON.parse(text); } catch { throw new Error('invalid JSON body'); }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, ORIGIN);
  const path = url.pathname;
  const m = (method, re) => req.method === method && re.exec(path);
  try {
    // ---- static: exactly the tree GitHub Pages serves, so one shell covers both.
    if (req.method === 'GET') {
      const p = path === '/' ? '/index.html' : path;
      const ok = /^\/(index\.html|manifest\.webmanifest|sw\.js|icon\.svg|icon-\d+\.png)$/.test(p)
        || /^\/(public|lib)\/[\w-]+\.(m?js|css)$/.test(p)
        || /^\/data\/[\w-]+\.json$/.test(p);        // .json only, never the local crusher.db
      if (ok) return send(res, join(ROOT, p.slice(1)), p === '/index.html');
    }

    // ---- oauth: strava
    if (m('GET', /^\/connect\/strava$/)) {
      if (!strava.configured()) return json(res, { error: 'Set STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET in .env' }, 400);
      const state = Math.random().toString(36).slice(2);
      pending.set(state, { provider: 'strava' });
      return redirect(res, strava.authUrl(`${ORIGIN}/oauth/strava/callback`, state));
    }
    if (m('GET', /^\/oauth\/strava\/callback$/)) {
      const code = url.searchParams.get('code');
      if (!code) return redirect(res, '/#connect?error=denied');
      const t = await strava.exchange(code);
      DB.run(db, `INSERT OR REPLACE INTO connections (provider, access_token, refresh_token, expires_at, athlete_ref, scope, connected_ts, meta)
                  VALUES ('strava',?,?,?,?,?,?,?)`,
        t.access_token, t.refresh_token, t.expires_at, String(t.athlete?.id ?? ''), url.searchParams.get('scope') || '', now(), JSON.stringify(t.athlete || {}));
      if (t.athlete) DB.run(db, `UPDATE athlete SET name=COALESCE(NULLIF(name,'Athlete'),?), sex=COALESCE(sex,?), weight_kg=COALESCE(weight_kg,?) WHERE id=1`,
        [t.athlete.firstname, t.athlete.lastname].filter(Boolean).join(' ') || 'Athlete', t.athlete.sex || null, t.athlete.weight || null);
      syncStrava({ full: true }).catch(() => {});          // fire and forget; UI polls the sync log
      return redirect(res, '/#connect');
    }

    // ---- oauth: garmin
    if (m('GET', /^\/connect\/garmin$/)) {
      if (!garmin.configured()) return json(res, { error: 'Garmin API keys not set — use CSV/GPX import instead' }, 400);
      const state = Math.random().toString(36).slice(2);
      const { verifier, challenge } = await garmin.pkce();
      pending.set(state, { provider: 'garmin', verifier });
      return redirect(res, garmin.authUrl(`${ORIGIN}/oauth/garmin/callback`, state, challenge));
    }
    if (m('GET', /^\/oauth\/garmin\/callback$/)) {
      const code = url.searchParams.get('code'), state = url.searchParams.get('state');
      const p = pending.get(state);
      if (!code || !p) return redirect(res, '/#connect?error=state');
      pending.delete(state);
      const t = await garmin.exchange(code, `${ORIGIN}/oauth/garmin/callback`, p.verifier);
      DB.run(db, `INSERT OR REPLACE INTO connections (provider, access_token, refresh_token, expires_at, athlete_ref, scope, connected_ts, meta)
                  VALUES ('garmin',?,?,?,?,?,?,?)`,
        t.access_token, t.refresh_token || null, now() + (t.expires_in || 86400), t.user_id || '', t.scope || '', now(), '{}');
      syncGarmin({ days: 60 }).catch(() => {});
      return redirect(res, '/#connect');
    }

    // ---- api
    if (m('GET', /^\/api\/state$/)) return json(res, fullState());
    if (m('POST', /^\/api\/sync\/strava$/)) return json(res, await syncStrava(await body(req)));
    if (m('POST', /^\/api\/sync\/garmin$/)) return json(res, await syncGarmin(await body(req)));

    if (m('POST', /^\/api\/import\/garmin$/)) {
      const b = await body(req);
      // json = what tools/garmin-sync.py writes; csv/gpx = what Garmin Connect or Strava exports.
      const { acts, bests } = readImport(b);
      const added = DB.upsertActivities(db, acts);
      for (const e of bests) DB.upsertBestEfforts(db, e.activity_id, e.start_ts, [e]);
      DB.run(db, `INSERT INTO sync_log (provider, started_ts, finished_ts, status, added, message) VALUES ('garmin-file',?,?,'ok',?,?)`,
        now(), now(), added, `${b.format || 'csv'} import: ${acts.length} rows${bests.length ? `, ${bests.length} bests` : ''}`);
      return json(res, { added, parsed: acts.length, bests: bests.length });
    }

    if (m('POST', /^\/api\/demo$/)) {
      const b = await body(req);
      if (b.clear) {
        DB.run(db, `DELETE FROM activities WHERE provider='demo'`);
        DB.run(db, `DELETE FROM best_efforts WHERE activity_id LIKE 'demo:%'`);
        return json(res, { cleared: true });
      }
      const { activities: acts, efforts } = demoActivities(now());
      const added = DB.upsertActivities(db, acts);
      for (const e of efforts) DB.upsertBestEfforts(db, e.activity_id, e.start_ts, [e]);
      DB.run(db, `INSERT INTO sync_log (provider, started_ts, finished_ts, status, added, message) VALUES ('demo',?,?,'ok',?,'seeded demo athlete')`, now(), now(), added);
      return json(res, { added });
    }

    if (m('POST', /^\/api\/erase$/)) {
      db.exec(`DELETE FROM activities; DELETE FROM best_efforts; DELETE FROM queue; DELETE FROM goals;
        DELETE FROM attempts; DELETE FROM sync_log; DELETE FROM connections;
        UPDATE athlete SET name='Athlete', sex=NULL, birth_year=NULL, weight_kg=NULL, settings='{}' WHERE id=1;`);
      return json(res, { erased: true });
    }

    if (m('GET', /^\/api\/milestones$/))
      return json(res, milestones(FEATS, activities(), bestEfforts(), attemptsByFeat(), now(), DB.one(db, 'SELECT * FROM athlete WHERE id=1') || {}));

    if (m('POST', /^\/api\/athlete$/)) {
      const b = await body(req);
      DB.run(db, `UPDATE athlete SET name=COALESCE(?,name), sex=COALESCE(?,sex), birth_year=COALESCE(?,birth_year), weight_kg=COALESCE(?,weight_kg) WHERE id=1`,
        b.name ?? null, b.sex ?? null, b.birth_year ?? null, b.weight_kg ?? null);
      if ('rival' in b) {                       // pin one name to chase from the dashboard
        const cur = JSON.parse(DB.one(db, 'SELECT settings FROM athlete WHERE id=1')?.settings || '{}');
        cur.rival = b.rival && BY_ID.has(b.rival) ? b.rival : null;
        DB.run(db, `UPDATE athlete SET settings=? WHERE id=1`, JSON.stringify(cur));
      }
      return json(res, DB.one(db, 'SELECT * FROM athlete WHERE id=1'));
    }

    // backup / restore: everything you typed, none of what a provider can re-send
    if (m('GET', /^\/api\/backup$/)) {
      return json(res, {
        version: 1, exported_at: new Date().toISOString(),
        athlete: DB.one(db, 'SELECT * FROM athlete WHERE id=1'),
        queue: DB.all(db, 'SELECT * FROM queue'), goals: DB.all(db, 'SELECT * FROM goals'),
        attempts: DB.all(db, 'SELECT * FROM attempts'),
        manual_activities: DB.all(db, `SELECT * FROM activities WHERE provider NOT IN ('strava','demo')`),
      });
    }
    if (m('POST', /^\/api\/restore$/)) {
      const b = await body(req);
      if (b.version !== 1) return json(res, { error: 'unrecognised backup version' }, 400);
      let n = 0;
      if (b.athlete) DB.run(db, `UPDATE athlete SET name=?, sex=?, birth_year=?, weight_kg=?, settings=? WHERE id=1`,
        b.athlete.name ?? null, b.athlete.sex ?? null, b.athlete.birth_year ?? null, b.athlete.weight_kg ?? null, b.athlete.settings || '{}');
      for (const q of b.queue || []) if (BY_ID.has(q.feat_id)) {
        n += DB.run(db, `INSERT OR IGNORE INTO queue (feat_id, position, status, target_date, notes, created_ts) VALUES (?,?,?,?,?,?)`,
          q.feat_id, q.position, q.status, q.target_date, q.notes, q.created_ts || now()).changes;   // already queued = not restored
      }
      // Cloud sync restores on every pull, so the same row arriving twice must land once:
      // a goal is identified by feat + date, an attempt by feat + date + metric.
      for (const g of b.goals || []) if (BY_ID.has(g.feat_id)
        && !DB.one(db, `SELECT 1 x FROM goals WHERE feat_id=? AND IFNULL(target_date,'')=IFNULL(?,'')`, g.feat_id, g.target_date ?? null)) {
        DB.run(db, `INSERT INTO goals (feat_id, target_date, status, notes, created_ts) VALUES (?,?,?,?,?)`,
          g.feat_id, g.target_date, g.status, g.notes, g.created_ts || now()); n++;
      }
      for (const a of b.attempts || []) if (BY_ID.has(a.feat_id)
        && !DB.one(db, `SELECT 1 x FROM attempts WHERE feat_id=? AND date=? AND IFNULL(metric,'')=IFNULL(?,'')`, a.feat_id, a.date, a.metric ?? null)) {
        DB.run(db, `INSERT INTO attempts (feat_id, date, metric, value, unit, evidence, verified, notes, created_ts) VALUES (?,?,?,?,?,?,?,?,?)`,
          a.feat_id, a.date, a.metric, a.value, a.unit, a.evidence, a.verified ? 1 : 0, a.notes, a.created_ts || now()); n++;
      }
      if (b.manual_activities?.length) n += DB.upsertActivities(db, b.manual_activities);
      return json(res, { restored: n });
    }

    // queue
    if (m('POST', /^\/api\/queue$/)) {
      const b = await body(req);
      if (!BY_ID.has(b.feat_id)) return json(res, { error: 'unknown feat' }, 400);
      const pos = (DB.one(db, 'SELECT COALESCE(MAX(position),0)+1 p FROM queue')?.p) || 1;
      DB.run(db, `INSERT OR IGNORE INTO queue (feat_id, position, status, target_date, notes, created_ts) VALUES (?,?,?,?,?,?)`,
        b.feat_id, pos, b.status || 'queued', b.target_date || null, b.notes || null, now());
      return json(res, DB.all(db, 'SELECT * FROM queue ORDER BY position, id'));
    }
    let mm;
    if ((mm = m('PATCH', /^\/api\/queue\/(\d+)$/))) {
      const b = await body(req);
      if (b.move) {                                  // 'up' | 'down' — swap positions with the neighbour
        const rows = DB.all(db, 'SELECT * FROM queue ORDER BY position, id');
        const i = rows.findIndex(r => r.id === +mm[1]);
        const j = b.move === 'up' ? i - 1 : i + 1;
        if (i >= 0 && j >= 0 && j < rows.length) {
          DB.run(db, 'UPDATE queue SET position=? WHERE id=?', rows[j].position ?? j + 1, rows[i].id);
          DB.run(db, 'UPDATE queue SET position=? WHERE id=?', rows[i].position ?? i + 1, rows[j].id);
        }
      } else {
        DB.run(db, `UPDATE queue SET status=COALESCE(?,status), target_date=COALESCE(?,target_date), notes=COALESCE(?,notes) WHERE id=?`,
          b.status ?? null, b.target_date ?? null, b.notes ?? null, +mm[1]);
      }
      return json(res, DB.all(db, 'SELECT * FROM queue ORDER BY position, id'));
    }
    if ((mm = m('DELETE', /^\/api\/queue\/(\d+)$/))) {
      DB.run(db, 'DELETE FROM queue WHERE id=?', +mm[1]);
      return json(res, DB.all(db, 'SELECT * FROM queue ORDER BY position, id'));
    }

    // goals
    if (m('POST', /^\/api\/goals$/)) {
      const b = await body(req);
      if (!BY_ID.has(b.feat_id)) return json(res, { error: 'unknown feat' }, 400);
      DB.run(db, `INSERT INTO goals (feat_id, target_date, status, notes, created_ts) VALUES (?,?,'active',?,?)`,
        b.feat_id, b.target_date || null, b.notes || null, now());
      return json(res, DB.all(db, 'SELECT * FROM goals ORDER BY created_ts DESC'));
    }
    if ((mm = m('PATCH', /^\/api\/goals\/(\d+)$/))) {
      const b = await body(req);
      DB.run(db, `UPDATE goals SET target_date=COALESCE(?,target_date), status=COALESCE(?,status), notes=COALESCE(?,notes) WHERE id=?`,
        b.target_date ?? null, b.status ?? null, b.notes ?? null, +mm[1]);
      return json(res, DB.all(db, 'SELECT * FROM goals ORDER BY created_ts DESC'));
    }
    if ((mm = m('DELETE', /^\/api\/goals\/(\d+)$/))) {
      DB.run(db, 'DELETE FROM goals WHERE id=?', +mm[1]);
      return json(res, DB.all(db, 'SELECT * FROM goals ORDER BY created_ts DESC'));
    }
    if ((mm = m('GET', /^\/api\/goals\/(\d+)\/plan$/))) {
      const g = DB.one(db, 'SELECT * FROM goals WHERE id=?', +mm[1]);
      if (!g) return json(res, { error: 'no such goal' }, 404);
      return json(res, planFor(BY_ID.get(g.feat_id), profile(), g.target_date));
    }
    if ((mm = m('GET', /^\/api\/plan\/([\w.-]+)$/))) {
      const f = BY_ID.get(mm[1]);
      if (!f) return json(res, { error: 'no such feat' }, 404);
      return json(res, planFor(f, profile(), url.searchParams.get('date')));
    }

    // attempts / logbook
    if (m('POST', /^\/api\/attempts$/)) {
      const b = await body(req);
      if (!BY_ID.has(b.feat_id)) return json(res, { error: 'unknown feat' }, 400);
      if (!b.date) return json(res, { error: 'date required' }, 400);
      DB.run(db, `INSERT INTO attempts (feat_id, date, metric, value, unit, evidence, verified, notes, created_ts) VALUES (?,?,?,?,?,?,?,?,?)`,
        b.feat_id, b.date, b.metric || null, b.value ?? null, b.unit || null, b.evidence || null, b.verified ? 1 : 0, b.notes || null, now());
      return json(res, DB.all(db, 'SELECT * FROM attempts ORDER BY date DESC'));
    }
    if ((mm = m('DELETE', /^\/api\/attempts\/(\d+)$/))) {
      DB.run(db, 'DELETE FROM attempts WHERE id=?', +mm[1]);
      return json(res, DB.all(db, 'SELECT * FROM attempts ORDER BY date DESC'));
    }

    res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found');
  } catch (e) {
    json(res, { error: String(e.message || e) }, 500);
  }
});

async function send(res, file, isShell = false) {
  try {
    let buf = await readFile(file);
    // The shell is shared with the static build, which otherwise runs its own in-browser
    // backend. This flag is how it knows a real server is answering /api.
    if (isShell) buf = buf.toString('utf8').replace('</head>', '<script>window.CRUSHER_SERVER=1</script>\n</head>');
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(buf);
  } catch { res.writeHead(404); res.end('not found'); }
}

server.listen(PORT, () => {
  const s = featStats();
  console.log(`Celebrity Crusher on ${ORIGIN}`);
  console.log(`${s.total} feats · ${s.celebrities} names · ${s.computable} machine-checkable · ${s.logbook} logbook`);
  console.log(`Strava: ${strava.configured() ? 'configured' : 'no keys (set STRAVA_CLIENT_ID/SECRET)'} · Garmin API: ${garmin.configured() ? 'configured' : 'no keys (CSV/GPX import still works)'}`);
  if (!DB.one(db, 'SELECT 1 x FROM activities LIMIT 1')) console.log(`No activities yet — POST /api/demo or use the Connect tab to seed the demo athlete.`);
});

export { server, db, fullState, syncStrava, syncGarmin };
