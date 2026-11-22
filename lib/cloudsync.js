// Cloud sync without overwrites (house standard 30), through font.js's appFont.cloud.syncDoc.
//
// The synced document is a list of RECORDS, one per thing the reader made, each with a stable id
// built from what it is (so two devices agree on it), an updatedAt, and deletions kept as tombstones
// ({ id, deleted: true, updatedAt }) so a stale device cannot bring a deleted item back:
//   queue:<feat>   goal:<feat>:<date>   attempt:<feat>:<date>:<metric>   activity:<id>   setting:<name>
//
// The stores (SQLite under node server.mjs, the browser blob otherwise) keep no change times, so each
// device remembers what it held at its last sync (the "shadow": id -> content hash + updatedAt). At the
// next sync, a record whose content differs from the shadow was changed here (stamped now); one in the
// shadow but gone from the store was deleted here (a tombstone). A device with no shadow yet (the first
// sync, or the move from the old whole-file sync) counts its records as old (updatedAt 0), so the cloud
// wins any conflict and nothing it holds is lost.
//
// Pure functions plus syncOnce(), which is handed the cloud and the API, so test.mjs can run two
// pretend devices against one pretend cloud.

export const DOC_NAME = 'celebrity-crusher-sync.json';
export const LEGACY_NAME = 'celebrity-crusher-backup.json';   // the old whole-file snapshot, read once to move over
export const SHADOW_KEY = 'crusher.cloudsync';
export const SCHEMA = 2;
const TOMBSTONE_DAYS = 90;
const SETTINGS = ['name', 'sex', 'birth_year', 'weight_kg', 'rival'];

/** JSON with sorted keys, so the same content always hashes the same. */
const stable = v => JSON.stringify(v, (k, x) => x && typeof x === 'object' && !Array.isArray(x)
  ? Object.keys(x).sort().reduce((o, k2) => { o[k2] = x[k2]; return o; }, {}) : x);
const hash = v => { const s = stable(v); let h = 5381; for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0; return h.toString(36) + ':' + s.length; };
const pick = (o, keys) => Object.fromEntries(keys.map(k => [k, o?.[k] ?? null]));

const QUEUE = ['feat_id', 'position', 'status', 'target_date', 'notes'];
const GOAL = ['feat_id', 'target_date', 'status', 'notes'];
const ATTEMPT = ['feat_id', 'date', 'metric', 'value', 'unit', 'evidence', 'verified', 'notes'];
const ACTIVITY = ['id', 'provider', 'sport', 'start_ts', 'distance_m', 'moving_s', 'elapsed_s', 'elev_m', 'avg_hr', 'max_hr', 'name'];

/** id -> { kind, data } for everything a backup holds (what this device has now). */
export function recordsFrom(backup) {
  const out = new Map();
  for (const q of backup.queue || []) out.set(`queue:${q.feat_id}`, { kind: 'queue', data: pick(q, QUEUE) });
  for (const g of backup.goals || []) out.set(`goal:${g.feat_id}:${g.target_date ?? ''}`, { kind: 'goal', data: pick(g, GOAL) });
  for (const a of backup.attempts || []) out.set(`attempt:${a.feat_id}:${a.date}:${a.metric ?? ''}`, { kind: 'attempt', data: { ...pick(a, ATTEMPT), verified: a.verified ? 1 : 0 } });
  for (const a of backup.manual_activities || []) out.set(`activity:${a.id}`, { kind: 'activity', data: pick(a, ACTIVITY) });
  const ath = backup.athlete || {};
  let settings = ath.settings;
  if (typeof settings === 'string') { try { settings = JSON.parse(settings); } catch { settings = {}; } }
  const vals = { ...pick(ath, ['name', 'sex', 'birth_year', 'weight_kg']), rival: settings?.rival ?? null };
  for (const k of SETTINGS) if (vals[k] != null && !(k === 'name' && vals[k] === 'Athlete')) out.set(`setting:${k}`, { kind: 'setting', data: { key: k, value: vals[k] } });
  return out;
}

/** This device's document: its records, stamped against the shadow from the last sync. */
export function buildLocalDoc(backup, shadow, now = Date.now()) {
  const have = recordsFrom(backup), records = [];
  for (const [id, r] of have) {
    const h = hash(r.data), s = shadow?.[id];
    records.push({ id, kind: r.kind, data: r.data, updatedAt: s && !s.deleted && s.h === h ? s.updatedAt : shadow ? now : 0 });
  }
  if (shadow) for (const [id, s] of Object.entries(shadow)) {
    if (have.has(id)) continue;
    records.push({ id, deleted: true, updatedAt: s.deleted ? s.updatedAt : now });   // deleted here since the last sync, or an old tombstone
  }
  return { schema: SCHEMA, records };
}

/** Record by record, the latest change wins; tombstones older than 90 days are dropped. */
export function mergeDocs(local, remote, mergeRecords, now = Date.now()) {
  const merged = mergeRecords(local?.records || [], remote?.records || []);
  const cutoff = now - TOMBSTONE_DAYS * 86400000;
  return { schema: SCHEMA, records: merged.filter(r => !(r.deleted && r.updatedAt < cutoff)) };
}

/** What the store must do to match the document: upserts (by kind) and deletions (by id). */
export function diffToApply(doc, backup) {
  const have = recordsFrom(backup), upserts = [], deletes = [];
  for (const r of doc.records || []) {
    if (!r || typeof r.id !== 'string') continue;
    if (r.deleted) { if (have.has(r.id)) deletes.push(r.id); continue; }
    const cur = have.get(r.id);
    if (!cur || hash(cur.data) !== hash(r.data)) upserts.push({ id: r.id, kind: r.kind, data: r.data });
  }
  return { upserts, deletes };
}

/** What this device holds after a sync, to stamp the next one against. */
export const shadowFrom = doc => Object.fromEntries((doc.records || []).map(r =>
  [r.id, r.deleted ? { deleted: true, updatedAt: r.updatedAt } : { h: hash(r.data), updatedAt: r.updatedAt }]));

/**
 * One sync. cloud = appFont.cloud (read, syncDoc, mergeRecords); api = the app's api(); storage = localStorage.
 * -> { pulled, pushed, applied }
 */
export async function syncOnce({ cloud, api, storage, now = () => Date.now() }) {
  let shadow = null;
  try { shadow = JSON.parse(storage.getItem(SHADOW_KEY) || 'null'); } catch { /* none yet */ }
  if (!shadow) {
    // Moving over from the old whole-file sync: fold that snapshot in once (add-only), so nothing it held is lost.
    try { const old = await cloud.read(LEGACY_NAME); if (old) await api('/api/restore', { body: JSON.parse(old) }); } catch { /* none, or unreadable */ }
  }
  let final = null, applied = 0;
  const r = await cloud.syncDoc(DOC_NAME, {
    load: async () => (final = buildLocalDoc(await api('/api/backup', { method: 'GET' }), shadow, now())),
    merge: (local, remote) => mergeDocs(local, remote, cloud.mergeRecords, now()),
    save: async doc => {
      const d = diffToApply(doc, await api('/api/backup', { method: 'GET' }));
      if (d.upserts.length || d.deletes.length) applied = (await api('/api/sync-apply', { body: d })).applied || 0;
      final = doc;
    },
  });
  if (final) { try { storage.setItem(SHADOW_KEY, JSON.stringify(shadowFrom(final))); } catch { /* private mode: next sync stamps again */ } }
  return { ...r, applied };
}

/** Turn validated upserts back into the backup shape the stores already know how to clean and apply. */
export function upsertsAsBackup(upserts) {
  const b = { version: 1, queue: [], goals: [], attempts: [], manual_activities: [], athlete: null };
  for (const u of upserts || []) {
    const d = u && typeof u.data === 'object' && u.data ? u.data : null;
    if (!d) continue;
    if (u.kind === 'queue') b.queue.push(d);
    else if (u.kind === 'goal') b.goals.push(d);
    else if (u.kind === 'attempt') b.attempts.push(d);
    else if (u.kind === 'activity') b.manual_activities.push(d);
    else if (u.kind === 'setting' && SETTINGS.includes(d.key)) {
      b.athlete ||= {};
      if (d.key === 'rival') b.athlete.settings = { rival: d.value }; else b.athlete[d.key] = d.value;
    }
  }
  return b;
}

/** A deletion id, split into what it names. Returns null for anything malformed. */
export function parseDeleteId(id) {
  const m = typeof id === 'string' && id.match(/^(queue|goal|attempt|activity|setting):(.+)$/);
  if (!m) return null;
  const [, kind, rest] = m, parts = rest.split(':');
  if (kind === 'queue') return { kind, feat_id: rest };
  if (kind === 'goal') return { kind, feat_id: parts[0], target_date: parts[1] || null };
  if (kind === 'attempt') return { kind, feat_id: parts[0], date: parts[1], metric: parts.slice(2).join(':') || null };
  if (kind === 'activity') return { kind, id: rest };
  return SETTINGS.includes(rest) ? { kind, key: rest } : null;
}
