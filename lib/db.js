// SQLite via node:sqlite (Node 22.5+). No ORM, no migrations framework.
// ponytail: schema is CREATE TABLE IF NOT EXISTS, run on every boot. Add a real
// migration story when the schema needs to change under live data.
import { DatabaseSync } from 'node:sqlite';
import { dedupeKey } from './engine.js';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function open(file) {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS athlete (
      id INTEGER PRIMARY KEY CHECK (id=1), name TEXT, sex TEXT, birth_year INTEGER,
      weight_kg REAL, settings TEXT DEFAULT '{}');
    CREATE TABLE IF NOT EXISTS connections (
      provider TEXT PRIMARY KEY, access_token TEXT, refresh_token TEXT,
      expires_at INTEGER, athlete_ref TEXT, scope TEXT, connected_ts INTEGER, meta TEXT);
    CREATE TABLE IF NOT EXISTS activities (
      id TEXT PRIMARY KEY, provider TEXT NOT NULL, sport TEXT NOT NULL,
      start_ts INTEGER NOT NULL, distance_m REAL DEFAULT 0, moving_s INTEGER DEFAULT 0,
      elapsed_s INTEGER DEFAULT 0, elev_m REAL DEFAULT 0, avg_hr REAL, max_hr REAL,
      name TEXT, dedupe_key TEXT, raw TEXT);
    CREATE INDEX IF NOT EXISTS activities_start ON activities(start_ts);
    CREATE UNIQUE INDEX IF NOT EXISTS activities_dedupe ON activities(dedupe_key);
    CREATE TABLE IF NOT EXISTS best_efforts (
      activity_id TEXT NOT NULL, distance_m INTEGER NOT NULL, seconds INTEGER NOT NULL,
      start_ts INTEGER NOT NULL, PRIMARY KEY (activity_id, distance_m));
    CREATE TABLE IF NOT EXISTS queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT, feat_id TEXT NOT NULL UNIQUE, position INTEGER,
      status TEXT DEFAULT 'queued', target_date TEXT, notes TEXT, created_ts INTEGER);
    CREATE TABLE IF NOT EXISTS goals (
      id INTEGER PRIMARY KEY AUTOINCREMENT, feat_id TEXT NOT NULL, target_date TEXT,
      status TEXT DEFAULT 'active', notes TEXT, created_ts INTEGER,
      weekly_target_km REAL);
    CREATE TABLE IF NOT EXISTS attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, feat_id TEXT NOT NULL, date TEXT NOT NULL,
      metric TEXT, value REAL, unit TEXT, evidence TEXT, verified INTEGER DEFAULT 0,
      notes TEXT, created_ts INTEGER);
    CREATE TABLE IF NOT EXISTS sync_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT, started_ts INTEGER,
      finished_ts INTEGER, status TEXT, added INTEGER DEFAULT 0, message TEXT);
    INSERT OR IGNORE INTO athlete (id, name) VALUES (1, 'Athlete');
  `);
  return db;
}

// tiny helpers so route code stays one-liners
export const all = (db, sql, ...p) => db.prepare(sql).all(...p);
export const one = (db, sql, ...p) => db.prepare(sql).get(...p);
export const run = (db, sql, ...p) => db.prepare(sql).run(...p);

/** Insert activities, ignoring anything already stored under the same dedupe key.
 *  Garmin rides into Strava for most people, so the same session arrives twice. */
export function upsertActivities(db, acts) {
  const stmt = db.prepare(`INSERT OR IGNORE INTO activities
    (id, provider, sport, start_ts, distance_m, moving_s, elapsed_s, elev_m, avg_hr, max_hr, name, dedupe_key, raw)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  let added = 0;
  for (const a of acts) {
    const r = stmt.run(a.id, a.provider, a.sport, a.start_ts, a.distance_m || 0, a.moving_s || 0,
      a.elapsed_s || a.moving_s || 0, a.elev_m || 0, a.avg_hr ?? null, a.max_hr ?? null,
      a.name || '', dedupeKey(a), a.raw ? JSON.stringify(a.raw) : null);
    added += r.changes;
  }
  return added;
}

export { dedupeKey };

export function upsertBestEfforts(db, activityId, startTs, efforts) {
  const stmt = db.prepare(`INSERT OR REPLACE INTO best_efforts (activity_id, distance_m, seconds, start_ts) VALUES (?,?,?,?)`);
  for (const e of efforts) stmt.run(activityId, Math.round(e.distance_m), Math.round(e.seconds), startTs);
}
