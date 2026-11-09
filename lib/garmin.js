// Garmin has two doors and this supports both.
//
//  1. FILE IMPORT (works today, no approval): Garmin Connect → Activities → Export CSV,
//     or any .gpx from the bulk "Export Your Data" archive. Nothing to register.
//  2. GARMIN CONNECT DEVELOPER PROGRAM (Activity API, OAuth2 PKCE): needs an approved
//     partner account. Endpoints are env-overridable because Garmin moves them and the
//     programme docs are behind the partner portal.
//
// If you already sync Garmin → Strava, door 1 is redundant: the sessions arrive via
// Strava and the dedupe key drops the copies.
// ponytail: env read through a helper and Web Crypto instead of node:crypto, so the
// file also imports in a browser (the static build needs importCsv/importGpx from here).
const env = (k, d) => globalThis.process?.env?.[k] || d;
const AUTH_URL = () => env('GARMIN_AUTH_URL', 'https://connect.garmin.com/oauth2Confirm');
const TOKEN_URL = () => env('GARMIN_TOKEN_URL', 'https://diauth.garmin.com/di-oauth2-service/oauth/token');
const API_BASE = () => env('GARMIN_API_BASE', 'https://apis.garmin.com/wellness-api/rest');

export const configured = () => !!(env('GARMIN_CLIENT_ID') && env('GARMIN_CLIENT_SECRET'));

const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export async function pkce() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: b64url(digest) };
}

export function authUrl(redirectUri, state, challenge) {
  const q = new URLSearchParams({
    client_id: env('GARMIN_CLIENT_ID'), response_type: 'code', redirect_uri: redirectUri,
    state, code_challenge: challenge, code_challenge_method: 'S256',
  });
  return `${AUTH_URL()}?${q}`;
}

async function token(form) {
  const res = await fetch(TOKEN_URL(), {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: 'Basic ' + btoa(`${env('GARMIN_CLIENT_ID')}:${env('GARMIN_CLIENT_SECRET')}`),
    },
    body: new URLSearchParams(form),
  });
  if (!res.ok) throw new Error(`Garmin token ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}
export const exchange = (code, redirectUri, verifier) =>
  token({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier });
export const refresh = refresh_token => token({ grant_type: 'refresh_token', refresh_token });

const SPORT = t => {
  t = (t || '').toLowerCase();
  if (/run|treadmill/.test(t)) return 'run';
  if (/cycl|bik|ride/.test(t)) return 'ride';
  if (/swim/.test(t)) return 'swim';
  if (/walk|hik/.test(t)) return 'walk';
  if (/ski|skat/.test(t)) return 'ski';
  if (/row|paddl|kayak/.test(t)) return 'row';
  return 'other';
};

/** Activity API pulls in ≤24h windows; walk back `days` from now. */
export async function fetchActivities(accessToken, days = 30) {
  const end = Math.floor(Date.now() / 1000), out = [];
  for (let t = end; t > end - days * 86400; t -= 86400) {
    const q = new URLSearchParams({ uploadStartTimeInSeconds: String(t - 86400), uploadEndTimeInSeconds: String(t) });
    const res = await fetch(`${API_BASE()}/activities?${q}`, { headers: { authorization: `Bearer ${accessToken}` } });
    if (res.status === 401) throw new Error('Garmin token rejected — reconnect');
    if (!res.ok) throw new Error(`Garmin activities ${res.status}: ${(await res.text()).slice(0, 200)}`);
    for (const a of await res.json()) {
      out.push({
        id: `garmin:${a.summaryId || a.activityId}`, provider: 'garmin', sport: SPORT(a.activityType),
        start_ts: a.startTimeInSeconds, distance_m: a.distanceInMeters || 0,
        moving_s: a.durationInSeconds || 0, elapsed_s: a.durationInSeconds || 0,
        elev_m: a.totalElevationGainInMeters || 0, avg_hr: a.averageHeartRateInBeatsPerMinute ?? null,
        max_hr: a.maxHeartRateInBeatsPerMinute ?? null, name: a.activityName || a.activityType || '',
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------- file import

/** Minimal RFC4180-ish CSV reader (quoted fields, embedded commas). */
export function parseCsv(text) {
  const rows = []; let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') q = false;
      else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (ch !== '\r') field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(c => c !== ''));
}

const hms = s => {
  if (!s) return 0;
  const p = String(s).trim().split(':').map(Number);
  if (p.some(isNaN)) return 0;
  return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p.length === 2 ? p[0] * 60 + p[1] : p[0];
};
const num = s => { const v = parseFloat(String(s ?? '').replace(/,/g, '').replace(/[^\d.\-]/g, '')); return isNaN(v) ? 0 : v; };
/** Epoch seconds from an epoch number, an ISO stamp, or Garmin's "2026-04-01 08:00:00". */
const toTs = v => {
  if (typeof v === 'number') return v > 1e11 ? Math.floor(v / 1000) : Math.floor(v);
  const t = Date.parse(String(v ?? '').trim().replace(/^(\d{4}-\d\d-\d\d) /, '$1T'));
  return isNaN(t) ? 0 : Math.floor(t / 1000);
};

/**
 * Garmin Connect "Export CSV" from the Activities list.
 * @param {'metric'|'imperial'} units — matches your Garmin account display units.
 */
export function importCsv(text, units = 'metric') {
  const rows = parseCsv(text);
  if (!rows.length) return [];
  const head = rows[0].map(h => h.trim().toLowerCase());
  const col = (...names) => { for (const n of names) { const i = head.indexOf(n); if (i >= 0) return i; } return -1; };
  const ix = {
    type: col('activity type'), date: col('date', 'activity date'), title: col('title', 'activity name'),
    dist: col('distance'), time: col('time', 'elapsed time'), moving: col('moving time'),
    ahr: col('avg hr', 'average heart rate'), mhr: col('max hr', 'max heart rate'),
    asc: col('total ascent', 'elevation gain'),
  };
  // Strava's bulk export uses different headers for the same columns; the aliases above cover both.
  if (ix.date < 0 || ix.dist < 0) throw new Error('Not an activities CSV (no Date/Distance columns)');
  const distFactor = units === 'imperial' ? 1609.34 : 1000;
  const out = [];
  for (const r of rows.slice(1)) {
    // Garmin writes "2025-08-17 07:12:03"; Strava writes "Aug 17, 2025, 7:12:03 AM".
    const ts = Math.floor(new Date(r[ix.date].trim().replace(/^(\d{4}-\d\d-\d\d) /, '$1T')).getTime() / 1000);
    if (!ts || isNaN(ts)) continue;
    const moving = ix.moving >= 0 ? hms(r[ix.moving]) : 0;
    out.push({
      id: `garmincsv:${ts}:${Math.round(num(r[ix.dist]) * 1000)}`, provider: 'garmin',
      sport: SPORT(r[ix.type]), start_ts: ts,
      distance_m: num(r[ix.dist]) * distFactor,
      moving_s: moving || hms(r[ix.time]), elapsed_s: hms(r[ix.time]),
      elev_m: ix.asc >= 0 ? num(r[ix.asc]) : 0,
      avg_hr: ix.ahr >= 0 && num(r[ix.ahr]) ? num(r[ix.ahr]) : null,
      max_hr: ix.mhr >= 0 && num(r[ix.mhr]) ? num(r[ix.mhr]) : null,
      name: ix.title >= 0 ? r[ix.title] : '',
    });
  }
  return out;
}

/**
 * The JSON written by tools/garmin-sync.py — the third Garmin door, and the one that needs
 * no clicking: a local script pulls your activities with your own login and drops a file in
 * a folder the app watches. Shape (every field but type/start optional):
 *   { version: 1, activities: [{ id, type, start, distance_m, moving_s, elapsed_s,
 *                                elev_m, avg_hr, max_hr, name }],
 *     bests: [{ activity_id, distance_m, seconds, date }] }
 * `type` is Garmin's own typeKey ("running", "lap_swimming"); mapping it stays here so the
 * script never has to know what sports this app believes in.
 */
export function importJson(text) {
  const data = typeof text === 'string' ? JSON.parse(text) : text;
  if (!data || !Array.isArray(data.activities)) throw new Error('Not a Garmin sync JSON (no activities array)');
  const activities = [];
  for (const a of data.activities) {
    const ts = toTs(a.start ?? a.start_ts);
    if (!ts) continue;                                    // no clock, no activity
    activities.push({
      id: `garmin:${a.id ?? ts}`, provider: 'garmin', sport: SPORT(a.type || a.sport),
      start_ts: ts, distance_m: num(a.distance_m), moving_s: Math.round(num(a.moving_s)),
      elapsed_s: Math.round(num(a.elapsed_s) || num(a.moving_s)), elev_m: num(a.elev_m),
      avg_hr: a.avg_hr ?? null, max_hr: a.max_hr ?? null, name: a.name || '',
    });
  }
  const bests = [];
  for (const b of data.bests || []) {
    const d = Math.round(num(b.distance_m)), secs = Math.round(num(b.seconds));
    if (!d || !secs) continue;
    bests.push({
      activity_id: b.activity_id != null ? `garmin:${b.activity_id}` : `garmin-pr:${d}`,
      distance_m: d, seconds: secs, start_ts: toTs(b.date) || toTs(b.start) || 0,
    });
  }
  return { activities, bests };
}

const R = 6371000;
const haversine = (a, b) => {
  const φ1 = a.lat * Math.PI / 180, φ2 = b.lat * Math.PI / 180;
  const dφ = φ2 - φ1, dλ = (b.lon - a.lon) * Math.PI / 180;
  const h = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

/** One .gpx track → one activity. Regex-parsed: GPX is flat enough not to need a DOM. */
export function importGpx(xml, name = 'GPX import') {
  const pts = [...xml.matchAll(/<trkpt[^>]*lat="([-\d.]+)"[^>]*lon="([-\d.]+)"[^>]*>([\s\S]*?)<\/trkpt>/g)].map(m => ({
    lat: +m[1], lon: +m[2],
    ele: (m[3].match(/<ele>([-\d.]+)<\/ele>/) || [])[1] ? +m[3].match(/<ele>([-\d.]+)<\/ele>/)[1] : null,
    t: (m[3].match(/<time>([^<]+)<\/time>/) || [])[1] || null,
  }));
  if (pts.length < 2) throw new Error('No track points in GPX');
  let dist = 0, gain = 0;
  for (let i = 1; i < pts.length; i++) {
    dist += haversine(pts[i - 1], pts[i]);
    const de = (pts[i].ele ?? 0) - (pts[i - 1].ele ?? 0);
    if (de > 1) gain += de;                       // 1 m threshold kills barometric noise
  }
  const t0 = pts.find(p => p.t)?.t, t1 = [...pts].reverse().find(p => p.t)?.t;
  const start = t0 ? Math.floor(new Date(t0).getTime() / 1000) : Math.floor(Date.now() / 1000);
  const elapsed = t0 && t1 ? Math.max(1, Math.floor((new Date(t1) - new Date(t0)) / 1000)) : 0;
  const typeHint = (xml.match(/<type>([^<]+)<\/type>/) || [])[1] || name;
  return [{
    id: `gpx:${start}:${Math.round(dist)}`, provider: 'garmin', sport: SPORT(typeHint),
    start_ts: start, distance_m: dist, moving_s: elapsed, elapsed_s: elapsed,
    elev_m: gain, avg_hr: null, max_hr: null, name: (xml.match(/<name>([^<]+)<\/name>/) || [])[1] || name,
  }];
}
