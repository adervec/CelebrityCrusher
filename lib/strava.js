// Strava OAuth + activity pull. Built-in fetch, no SDK.
const API = 'https://www.strava.com/api/v3';
const OAUTH = 'https://www.strava.com/oauth';

export const configured = () => !!(process.env.STRAVA_CLIENT_ID && process.env.STRAVA_CLIENT_SECRET);

const SPORT = {
  Run: 'run', TrailRun: 'run', VirtualRun: 'run', Treadmill: 'run',
  Ride: 'ride', VirtualRide: 'ride', GravelRide: 'ride', MountainBikeRide: 'ride', EBikeRide: 'ride', Handcycle: 'ride',
  Swim: 'swim', Walk: 'walk', Hike: 'walk', Snowshoe: 'walk',
  NordicSki: 'ski', BackcountrySki: 'ski', AlpineSki: 'ski', RollerSki: 'ski',
  Rowing: 'row', Kayaking: 'row', Canoeing: 'row', StandUpPaddling: 'row',
};

export function authUrl(redirectUri, state) {
  const q = new URLSearchParams({
    client_id: process.env.STRAVA_CLIENT_ID, redirect_uri: redirectUri, response_type: 'code',
    approval_prompt: 'auto', scope: 'read,activity:read_all', state,
  });
  return `${OAUTH}/authorize?${q}`;
}

async function token(body) {
  const res = await fetch(`${OAUTH}/token`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: process.env.STRAVA_CLIENT_ID, client_secret: process.env.STRAVA_CLIENT_SECRET, ...body }),
  });
  if (!res.ok) throw new Error(`Strava token ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}
export const exchange = code => token({ code, grant_type: 'authorization_code' });
export const refresh = refresh_token => token({ refresh_token, grant_type: 'refresh_token' });

async function get(path, accessToken, params = {}) {
  const url = `${API}${path}?${new URLSearchParams(params)}`;
  const res = await fetch(url, { headers: { authorization: `Bearer ${accessToken}` } });
  if (res.status === 429) throw new Error('Strava rate limit hit (100/15min, 1000/day) — try again later');
  if (!res.ok) throw new Error(`Strava ${path} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

export function normalise(a) {
  return {
    id: `strava:${a.id}`, provider: 'strava',
    sport: SPORT[a.sport_type] || SPORT[a.type] || 'other',
    start_ts: Math.floor(new Date(a.start_date).getTime() / 1000),
    distance_m: a.distance || 0, moving_s: a.moving_time || 0, elapsed_s: a.elapsed_time || 0,
    elev_m: a.total_elevation_gain || 0, avg_hr: a.average_heartrate ?? null, max_hr: a.max_heartrate ?? null,
    name: a.name || '',
  };
}

/** Page through /athlete/activities since `after` (unix seconds). */
export async function fetchActivities(accessToken, after = 0, maxPages = 20) {
  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    const batch = await get('/athlete/activities', accessToken, { after, page, per_page: 200 });
    out.push(...batch.map(normalise));
    if (batch.length < 200) break;
  }
  return out;
}

/** Detailed activity carries Strava's measured best efforts (5k, 10k, half, marathon…).
 *  ponytail: capped per sync because detail calls are the rate-limit killer. */
export async function fetchBestEfforts(accessToken, stravaId) {
  const a = await get(`/activities/${stravaId}`, accessToken, { include_all_efforts: true });
  return (a.best_efforts || []).map(e => ({ distance_m: e.distance, seconds: e.moving_time ?? e.elapsed_time }));
}
