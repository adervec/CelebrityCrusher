// A backup arrives from outside: a file someone picked, or a pull from Drive or a sync folder
// that another device (or anyone with the file) wrote. Validate the shape and keep only known
// fields, as fresh objects (so no __proto__ or other stray keys ride along), before either
// backend stores a byte of it.
const DAY = /^\d{4}-\d\d-\d\d$/;
const QUEUE_STATUS = ['queued', 'training', 'scheduled', 'attempted', 'crushed', 'abandoned'];
const GOAL_STATUS = ['active', 'done', 'dropped'];
const SPORTS = ['run', 'ride', 'swim', 'walk', 'ski', 'row', 'other'];

const str = (v, max) => typeof v === 'string' ? v.slice(0, max) : null;
const day = v => typeof v === 'string' && DAY.test(v) ? v : null;
const num = (v, lo = -Infinity, hi = Infinity) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : null;
const ts = v => num(v, 0, 4102444800);                       // up to 2100
const list = (v, max) => Array.isArray(v) ? v.slice(0, max).filter(x => x && typeof x === 'object' && !Array.isArray(x)) : [];
const pick = (v, allowed, fallback) => allowed.includes(v) ? v : fallback;

/**
 * @param {object} b      parsed backup JSON
 * @param {Map} byId      the ledger, so only real feats are restored
 * @returns {{athlete:object|null, queue:object[], goals:object[], attempts:object[], manual_activities:object[]}}
 */
export function cleanBackup(b, byId) {
  if (!b || typeof b !== 'object' || b.version !== 1) throw new Error('unrecognised backup version');
  const feat = x => typeof x.feat_id === 'string' && byId.has(x.feat_id);
  let athlete = null;
  if (b.athlete && typeof b.athlete === 'object') {
    let s = b.athlete.settings;
    if (typeof s === 'string') { try { s = JSON.parse(s); } catch { s = null; } }
    const rival = s && typeof s === 'object' && typeof s.rival === 'string' && byId.has(s.rival) ? s.rival : null;
    athlete = {
      name: str(b.athlete.name, 80), sex: pick(b.athlete.sex, ['M', 'F'], null),
      birth_year: num(b.athlete.birth_year, 1900, 2030), weight_kg: num(b.athlete.weight_kg, 20, 400),
      settings: rival ? { rival } : {},
    };
  }
  return {
    athlete,
    queue: list(b.queue, 1000).filter(feat).map(q => ({
      feat_id: q.feat_id, position: num(q.position, 0, 1e6), status: pick(q.status, QUEUE_STATUS, 'queued'),
      target_date: day(q.target_date), notes: str(q.notes, 2000), created_ts: ts(q.created_ts),
    })),
    goals: list(b.goals, 1000).filter(feat).map(g => ({
      feat_id: g.feat_id, target_date: day(g.target_date), status: pick(g.status, GOAL_STATUS, 'active'),
      notes: str(g.notes, 2000), created_ts: ts(g.created_ts),
    })),
    attempts: list(b.attempts, 5000).filter(feat).filter(a => day(a.date)).map(a => ({
      feat_id: a.feat_id, date: a.date, metric: str(a.metric, 40), value: num(a.value, 0, 1e9), unit: str(a.unit, 12),
      evidence: str(a.evidence, 500), verified: a.verified ? 1 : 0, notes: str(a.notes, 2000), created_ts: ts(a.created_ts),
    })),
    manual_activities: list(b.manual_activities, 50000).filter(a => typeof a.id === 'string' && ts(a.start_ts)).map(a => ({
      id: a.id.slice(0, 120), provider: str(a.provider, 20) || 'import', sport: pick(a.sport, SPORTS, 'other'),
      start_ts: a.start_ts, distance_m: num(a.distance_m, 0, 1e8) || 0, moving_s: num(a.moving_s, 0, 1e7) || 0,
      elapsed_s: num(a.elapsed_s, 0, 1e7) || 0, elev_m: num(a.elev_m, -1e4, 1e6) || 0,
      avg_hr: num(a.avg_hr, 20, 260), max_hr: num(a.max_hr, 20, 260), name: str(a.name, 200) || '',
    })),
  };
}
