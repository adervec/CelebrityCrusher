// Cloud sync + the Garmin folder watcher. Ported from the two apps that already do this:
// the provider interface and Drive plumbing from Tachyread, the remembered-folder import
// from GymTracker315. Nothing here talks to a server of ours — it is your browser, your
// Drive, your disk.
//
// A provider is a tiny async interface the sync manager drives:
//   supported()      -> can this browser use it at all?
//   available(cfg)   -> true | { ok:false, reason }   (config gate, e.g. a missing client id)
//   connect(cfg)     -> an opaque connection (dir handle, access token) or throws
//   isConnected()    -> remembered connection still usable?
//   upload/download/stat(conn, name, …)
//
// Two ship:
//   • LOCAL FOLDER — a File System Access directory handle. Point it at your Google Drive,
//     Dropbox or OneDrive *desktop sync folder* and you get cloud sync with no accounts.
//   • GOOGLE DRIVE — straight into the private app-data folder over Google Identity
//     Services + the Drive REST API.

export const BACKUP_FILE_NAME = 'celebrity-crusher-backup.json';

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

// ---------------------------------------------------------------- local folder
export const localFolderProvider = {
  id: 'localFolder',
  label: 'Local folder (or a Drive / Dropbox sync folder)',
  supported: () => typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function',
  available: () => true,
  async connect() {
    let handle = await getHandle('syncDir');
    if (handle && (await ensureDirPermission(handle))) return handle;
    handle = await window.showDirectoryPicker({ id: 'crusher-sync', mode: 'readwrite' });
    if (!(await ensureDirPermission(handle))) throw new Error('Folder permission was denied.');
    await setHandle('syncDir', handle);
    return handle;
  },
  async isConnected() {
    const h = await getHandle('syncDir');
    return !!h && h.queryPermission && (await h.queryPermission({ mode: 'readwrite' })) === 'granted';
  },
  async accountLabel() { return (await getHandle('syncDir'))?.name || null; },
  async disconnect() { await setHandle('syncDir', null); },
  async upload(dir, name, blob) {
    const fh = await dir.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(blob); await w.close();
  },
  async download(dir, name) {
    try { return await (await dir.getFileHandle(name)).getFile(); } catch { return null; }
  },
  // Cheap change probe: mtime without reading the bytes. null = no file there yet.
  async stat(dir, name) {
    try { return (await (await dir.getFileHandle(name)).getFile()).lastModified || null; } catch { return null; }
  },
};

// ---------------------------------------------------------------- google drive
// Public OAuth client id (shared with Tachyread and GymTracker315 — an identifier, not a
// secret). Google only honours it from the JavaScript origins registered against it, and
// the gate below refuses it app-side anywhere else, so a fork must supply its own.
export const BUILTIN_DRIVE_CLIENT_ID = '547617739897-br6dj2facmsc34qnkjb5u4dbfhju39pu.apps.googleusercontent.com';
const OAUTH_ORIGINS = ['https://adervec.github.io'];
export function driveOriginAllowed() {
  try {
    const h = location.hostname;
    if (h === 'localhost' || h === '127.0.0.1' || h === '[::1]') return true;    // local dev, any port
    return OAUTH_ORIGINS.indexOf(location.origin) !== -1;
  } catch { return false; }
}
export function driveClientId(cfg) {
  return (cfg?.driveClientId || '').trim() || (driveOriginAllowed() ? BUILTIN_DRIVE_CLIENT_ID : '');
}

let gisLoaded = null;
function loadGis() {
  if (gisLoaded) return gisLoaded;
  gisLoaded = new Promise((resolve, reject) => {
    if (window.google?.accounts?.oauth2) return resolve();
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Could not load Google sign-in.'));
    document.head.appendChild(s);
  });
  return gisLoaded;
}
// drive.appdata sees this app's own folder and nothing else of yours. The identity scopes
// are only so the Connect tab can show which account is signed in.
const DRIVE_SCOPE = 'openid email profile https://www.googleapis.com/auth/drive.appdata';

let _driveToken = null;      // { value, exp } — memory only, never persisted
let _driveProfile = null;    // { name, email, picture } — cosmetic
const driveTokenValid = () => !!_driveToken && _driveToken.exp > Date.now() + 60000;
export const getDriveProfile = () => _driveProfile;
/** The profile picture, only if it is an https URL — it goes straight into an <img src>. */
export const avatarUrl = profile => (profile?.picture || '').startsWith('https://') ? profile.picture : '';

async function fetchDriveProfile(token) {
  try {
    const r = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: `Bearer ${token}` } });
    if (r.ok) { const j = await r.json(); _driveProfile = { name: j.name || j.email || 'Google account', email: j.email || '', picture: j.picture || '' }; }
  } catch { /* cosmetic only */ }
  return _driveProfile;
}

function requestToken(clientId, prompt = '') {
  return new Promise((resolve, reject) => {
    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId, scope: DRIVE_SCOPE,
      callback: resp => {
        if (resp?.access_token) {
          _driveToken = { value: resp.access_token, exp: Date.now() + ((resp.expires_in || 3600) * 1000) };
          resolve(resp.access_token);
        } else reject(new Error(resp?.error || 'Sign-in failed.'));
      },
      // Without this a dismissed or blocked popup leaves the promise hanging forever.
      error_callback: err => reject(new Error(err?.message || err?.type || 'Sign-in was dismissed.')),
    });
    client.requestAccessToken({ prompt });
  });
}
async function driveFind(token, name) {
  const q = encodeURIComponent(`name='${name}' and trashed=false`);
  const r = await fetch(`https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${q}&fields=files(id,name,modifiedTime)`,
    { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`Drive list failed (${r.status}).`);
  return (await r.json()).files?.[0] || null;
}

export const googleDriveProvider = {
  id: 'googleDrive',
  label: 'Google Drive (private app folder)',
  supported: () => true,
  available: cfg => (driveClientId(cfg) ? true : { ok: false, reason: 'Google Drive sync is not enabled on this deployment — add your own OAuth client ID below.' }),
  // `silent` (boot, auto-sync) only reuses an existing grant; it never opens a popup.
  async connect(cfg, { silent = false } = {}) {
    const clientId = driveClientId(cfg);
    if (!clientId) throw new Error('Google Drive sync is not available here.');
    if (driveTokenValid()) {
      if (!_driveProfile) await fetchDriveProfile(_driveToken.value);
      return { token: _driveToken.value };
    }
    await loadGis();
    let token;
    try { token = await requestToken(clientId, ''); }             // silent: existing grant
    catch (e) {
      if (silent) throw e;
      token = await requestToken(clientId, 'consent');            // user asked for it: prompt once
    }
    await fetchDriveProfile(token);
    return { token };
  },
  async isConnected() { return driveTokenValid(); },
  async accountLabel() { return _driveProfile?.email || _driveProfile?.name || null; },
  accountPicture() { return avatarUrl(_driveProfile); },
  async disconnect() { _driveToken = null; _driveProfile = null; },
  async upload(conn, name, blob) {
    const existing = (await driveFind(conn.token, name))?.id || null;
    const meta = existing ? {} : { name, parents: ['appDataFolder'] };
    // Multipart is capped around 5 MB; a big ledger backup goes resumable instead.
    if (blob.size > 4 * 1024 * 1024) {
      const init = await fetch(existing
        ? `https://www.googleapis.com/upload/drive/v3/files/${existing}?uploadType=resumable`
        : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable', {
        method: existing ? 'PATCH' : 'POST',
        headers: { Authorization: `Bearer ${conn.token}`, 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': 'application/json' },
        body: JSON.stringify(meta),
      });
      if (!init.ok) throw new Error(`Drive upload init failed (${init.status}).`);
      const session = init.headers.get('Location');
      if (!session) throw new Error('Drive upload init returned no session URL.');
      const put = await fetch(session, { method: 'PUT', body: blob });
      if (!put.ok) throw new Error(`Drive upload failed (${put.status}).`);
      return;
    }
    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify(meta)], { type: 'application/json' }));
    form.append('file', blob);
    const r = await fetch(existing
      ? `https://www.googleapis.com/upload/drive/v3/files/${existing}?uploadType=multipart`
      : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
      { method: existing ? 'PATCH' : 'POST', headers: { Authorization: `Bearer ${conn.token}` }, body: form });
    if (!r.ok) throw new Error(`Drive upload failed (${r.status}).`);
  },
  async download(conn, name) {
    const id = (await driveFind(conn.token, name))?.id || null;
    if (!id) return null;
    const r = await fetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`, { headers: { Authorization: `Bearer ${conn.token}` } });
    return r.ok ? await r.blob() : null;
  },
  async stat(conn, name) {
    const f = await driveFind(conn.token, name);
    return f?.modifiedTime ? Date.parse(f.modifiedTime) : null;
  },
};

export const SYNC_PROVIDERS = [localFolderProvider, googleDriveProvider];
export const getSyncProvider = id => SYNC_PROVIDERS.find(p => p.id === id) || null;

// ---------------------------------------------------------------- sync manager
// What travels is exactly the app's own backup payload: what you typed (queue, goals,
// logged attempts, imported activities), never provider tokens. Restore merges, so two
// devices converge instead of clobbering.
//
// ponytail: merge is add-only — a row deleted on one device comes back from the other.
// Add tombstones (deleted_ids with timestamps) if that starts to bite.
const resolve = p => (typeof p === 'string' ? getSyncProvider(p) : p);

async function ready(providerOrId, cfg) {
  const p = resolve(providerOrId);
  if (!p) throw new Error('Unknown sync target.');
  if (!p.supported()) throw new Error('This browser cannot use that sync target.');
  const gate = p.available(cfg);
  if (gate !== true) throw new Error(gate.reason || 'That sync target is not available.');
  return p;
}

export async function backupTo(providerOrId, cfg, api, opts = {}) {
  const p = await ready(providerOrId, cfg);
  const conn = await p.connect(cfg, opts);
  const bundle = await api('/api/backup', { method: 'GET' });
  const blob = new Blob([JSON.stringify(bundle)], { type: 'application/json' });
  await p.upload(conn, BACKUP_FILE_NAME, blob);
  return { at: Date.now(), bytes: blob.size };
}

export async function restoreFrom(providerOrId, cfg, api, opts = {}) {
  const p = await ready(providerOrId, cfg);
  const conn = await p.connect(cfg, opts);
  const blob = await p.download(conn, BACKUP_FILE_NAME);
  if (!blob) return { at: Date.now(), restored: 0, empty: true };
  let bundle;
  try { bundle = JSON.parse(await blob.text()); }
  catch { throw new Error('The sync file is corrupt or incomplete — back up again from a device that has your data.'); }
  const r = await api('/api/restore', { body: bundle });
  return { at: Date.now(), restored: r.restored || 0 };
}

/** Read-merge-write, so two devices converge rather than the last one winning. */
export async function syncNow(providerOrId, cfg, api, opts = {}) {
  const pulled = await restoreFrom(providerOrId, cfg, api, opts);
  const pushed = await backupTo(providerOrId, cfg, api, opts);
  return { at: pushed.at, restored: pulled.restored, bytes: pushed.bytes };
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
  if (!garminFolderSupported()) throw new Error('This browser has no directory picker — use the file import instead.');
  const dir = await window.showDirectoryPicker({ id: 'crusher-garmin', mode: 'read' });
  if (!(await ensureDirPermission(dir, 'read'))) throw new Error('Folder permission was denied.');
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
