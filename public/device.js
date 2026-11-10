// This app's footprint on the shared adervec.github.io origin. Every app lives on that one
// origin, so localStorage is shared: we touch only our own keys and our own rows in the
// maker portal's shared lists, and never call localStorage.clear().
export const APP = 'CelebrityCrusher';
export const KIND = 'cardio';
export const OWN_KEYS = ['crusher.v1', 'crusher.sync'];
const ACTIVITY = 'portal-activity';

/** Erase this app's data on this device; other apps' keys and rows are left alone. */
export function eraseLocalData(storage) {
  for (const k of OWN_KEYS) storage.removeItem(k);
  try {   // portal-activity: [[ts, app, kind, amount], ...] — drop ours, keep other apps'
    const rows = JSON.parse(storage.getItem(ACTIVITY) || 'null');
    if (Array.isArray(rows)) storage.setItem(ACTIVITY, JSON.stringify(rows.filter(r => r?.[1] !== APP)));
  } catch { /* not ours to repair */ }
  try {   // portal-installed: { app: ts }
    const reg = JSON.parse(storage.getItem('portal-installed') || 'null');
    if (reg && typeof reg === 'object' && APP in reg) { delete reg[APP]; storage.setItem('portal-installed', JSON.stringify(reg)); }
  } catch { /* not ours to repair */ }
}

/**
 * Tell the maker portal's character sheet about real work: [unixSeconds, slug, kind, amount],
 * amount ≈ minutes ÷ 10, at least 1. Demo data never comes through here.
 * @param {[number, number][]} sessions [startSeconds, durationSeconds]
 */
export function logActivity(storage, sessions) {
  if (!sessions.length) return;
  try {
    const a = JSON.parse(storage.getItem(ACTIVITY) || '[]');
    for (const [ts, secs] of sessions) a.push([Math.round(ts), APP, KIND, Math.max(1, Math.round((secs || 0) / 600))]);
    storage.setItem(ACTIVITY, JSON.stringify(a.slice(-2000)));
  } catch { /* quota or private mode — ignore */ }
}
