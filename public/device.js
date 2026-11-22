// This app's footprint on the shared adervec.github.io origin. Every app lives on that one
// origin, so localStorage is shared: we touch only our own keys and our own rows in the
// maker portal's shared lists, and never call localStorage.clear().
export const APP = 'CelebrityCrusher';
export const KIND = 'cardio';
// crusher.coach = the last coaching reply; cowork-state:<app> = the shared Cowork engine's state for us.
// ("cowork-device" is the device id every app's Cowork panel shares, so it stays.)
// crusher.cloudsync = what this device held at its last cloud sync (lib/cloudsync.js); crusher.sync = the retired
// folder/Drive sync settings, still removed on devices that had them; cowork-transport:<app> = where cowork.js v5 talks.
export const OWN_KEYS = ['crusher.v1', 'crusher.sync', 'crusher.cloudsync', 'crusher.cloudsync-paused', 'crusher.coach', 'cowork-state:celebritycrusher', 'cowork-transport:celebritycrusher'];
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

/** The retired Cowork folder method kept every app's folder handle in one shared IndexedDB ("cowork-ui",
 *  store "dirs", keyed by app). Erase drops only ours, and never creates the database just to empty it. */
export function dropLegacyCoworkHandle(idb = globalThis.indexedDB, app = 'celebritycrusher') {
  if (!idb) return Promise.resolve();
  return new Promise(res => {
    const open = idb.open('cowork-ui', 1);
    open.onupgradeneeded = () => open.transaction.abort();      // it did not exist: nothing of ours in it
    open.onerror = () => res();
    open.onsuccess = () => {
      const db = open.result;
      try { const tx = db.transaction('dirs', 'readwrite'); tx.objectStore('dirs').delete(app); tx.oncomplete = tx.onerror = () => { db.close(); res(); }; }
      catch { db.close(); res(); }
    };
  });
}

/**
 * Tell the hub's session ledger about work that happened only in this app (house standard 25),
 * through font.js: logged attempts at logbook feats. Imported activities never come through here
 * (the shared feed holds them), nor does demo data.
 * @param {{id:string, at:number, seconds:number}[]} sessions  at = unix seconds the session ended
 * @param {object} font  appFont (injectable for tests)
 */
export function logActivity(sessions, font = globalThis.appFont) {
  if (!font?.logSession) return 0;
  let n = 0;
  for (const s of sessions) if (font.logSession({ app: APP, kind: s.kind || KIND, minutes: Math.max(1, (s.seconds || 0) / 60), id: s.id, at: s.at * 1000 })) n++;
  return n;
}
