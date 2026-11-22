// The Garmin watched folder: a folder the reader picks once, whose newest Garmin export is
// re-imported on every load (the remembered-folder import from GymTracker315). Cloud sync lives in
// lib/cloudsync.js, through font.js's appFont.cloud; the old folder and Drive sync code is retired
// (house standards 1 and 30).
import { t } from '../lib/i18n.js';

// ---------------------------------------------------------------- handle storage
// File System Access handles are structured-cloneable but not JSON — they need IndexedDB.
// ponytail: 20 lines of raw IndexedDB beats a wrapper dependency for one object store.
let _db = null;
function idbOpen() {
  if (_db) return Promise.resolve(_db);
  return new Promise((res, rej) => {
    if (typeof indexedDB === 'undefined') return rej(new Error('no indexedDB'));
    const r = indexedDB.open('crusher-fs', 1);
    r.onupgradeneeded = () => { try { r.result.createObjectStore('handles'); } catch { /* exists */ } };
    r.onsuccess = () => { _db = r.result; res(r.result); };
    r.onerror = () => rej(r.error);
  });
}
export async function getHandle(key) {
  try {
    const db = await idbOpen();
    return await new Promise((res, rej) => {
      const rq = db.transaction('handles', 'readonly').objectStore('handles').get(key);
      rq.onsuccess = () => res(rq.result || null);
      rq.onerror = () => rej(rq.error);
    });
  } catch { return null; }
}
/** Erase: close and delete the whole handle database (remembered sync and Garmin folders). */
export async function eraseHandles() {
  try { _db?.close(); } catch { /* already closed */ }
  _db = null;
  if (typeof indexedDB === 'undefined') return;
  await new Promise(res => { const r = indexedDB.deleteDatabase('crusher-fs'); r.onsuccess = r.onerror = r.onblocked = () => res(); });
}
export async function setHandle(key, val) {
  try {
    const db = await idbOpen();
    await new Promise((res, rej) => {
      const store = db.transaction('handles', 'readwrite').objectStore('handles');
      const rq = val == null ? store.delete(key) : store.put(val, key);
      rq.onsuccess = () => res(); rq.onerror = () => rej(rq.error);
    });
  } catch { /* private mode — sync still works for the session */ }
}

async function ensureDirPermission(handle, mode = 'readwrite') {
  if (!handle) return false;
  if (!handle.queryPermission) return true;
  if ((await handle.queryPermission({ mode })) === 'granted') return true;
  return (await handle.requestPermission({ mode })) === 'granted';
}

// ---------------------------------------------------------------- garmin folder watcher
// Garmin, the way GymTracker315 does it. A browser cannot read Garmin Connect directly:
// no public per-user read API, the internal endpoints are not CORS-enabled and sit behind
// SSO. So the data arrives as a file. tools/garmin-sync.py writes one; point this at the
// folder it writes to and every load re-imports the newest file. Always merges.
const GARMIN_NAME = /(garmin|crusher|activit)/i;
const GARMIN_EXT = /\.(json|csv|gpx)$/i;
/** Exported for the test: which files in the watched folder count as ours. */
export const matchesGarminFile = name => GARMIN_EXT.test(name) && GARMIN_NAME.test(name);

async function newestInDir(dir) {
  const named = [], anyOther = [];
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind !== 'file') continue;
    if (matchesGarminFile(name)) named.push({ name, handle });
    else if (GARMIN_EXT.test(name)) anyOther.push({ name, handle });
  }
  const pool = named.length ? named : anyOther;
  let best = null, bestT = -1;
  for (const e of pool) {
    try { const f = await e.handle.getFile(); if (f.lastModified > bestT) { bestT = f.lastModified; best = e; } } catch { /* unreadable */ }
  }
  return best;
}

export const garminFolderSupported = () => typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
export const garminFolderName = async () => (await getHandle('garminDir'))?.name || null;

export async function pickGarminFolder() {
  if (!garminFolderSupported()) throw new Error(t('This browser has no directory picker — use the file import instead.'));
  const dir = await window.showDirectoryPicker({ id: 'crusher-garmin', mode: 'read' });
  if (!(await ensureDirPermission(dir, 'read'))) throw new Error(t('Folder permission was denied.'));
  await setHandle('garminDir', dir);
  return dir.name;
}
export const forgetGarminFolder = () => setHandle('garminDir', null);

/**
 * Re-import the newest Garmin file in the remembered folder.
 * @param {Function} api the app's api() helper
 * @param {{interactive?: boolean}} opts interactive may re-prompt for permission (needs a click)
 */
export async function garminAutoLoad(api, { interactive = false } = {}) {
  const dir = await getHandle('garminDir');
  if (!dir) return { skipped: 'no-folder' };
  if (dir.queryPermission) {
    let perm = await dir.queryPermission({ mode: 'read' });
    if (perm !== 'granted' && interactive && dir.requestPermission) perm = await dir.requestPermission({ mode: 'read' });
    if (perm !== 'granted') return { skipped: 'no-permission' };
  }
  const entry = await newestInDir(dir);
  if (!entry) return { skipped: 'no-file' };
  const text = await (await entry.handle.getFile()).text();
  const format = /\.gpx$/i.test(entry.name) ? 'gpx' : /\.csv$/i.test(entry.name) ? 'csv' : 'json';
  const r = await api('/api/import/garmin', { body: { format, text, name: entry.name } });
  return { ...r, file: entry.name };
}
