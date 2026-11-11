// The local project store: the files of a project live in the browser
// (IndexedDB), so a dataset can be added and kept without a server.
//
// Everything is stored under its path inside the project ("data/..."), which
// makes the local project a mirror of the server bundle.

const DB_NAME = 'omicexplorer';
const DB_VERSION = 1;
const STORE = 'files';

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in globalThis)) {
      reject(new Error('this browser has no IndexedDB - the local mode needs it'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(mode) {
  return openDb().then((db) => db.transaction(STORE, mode).objectStore(STORE));
}

function done(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Store a file (ArrayBuffer or string). */
export async function putFile(path, data) {
  const store = await tx('readwrite');
  const value = typeof data === 'string' ? new TextEncoder().encode(data).buffer : data;
  await done(store.put(value, path));
  return path;
}

/** Read a file, or null. */
export async function getFile(path) {
  const store = await tx('readonly');
  const value = await done(store.get(path));
  return value || null;
}

/** Remove a file. */
export async function deleteFile(path) {
  const store = await tx('readwrite');
  await done(store.delete(path));
}

/** All stored paths (optionally filtered by a prefix). */
export async function listFiles(prefix = '') {
  const store = await tx('readonly');
  const keys = await done(store.getAllKeys());
  return keys.map(String).filter((k) => k.startsWith(prefix)).sort();
}

/** Store a JSON file. */
export async function putJSON(path, value) {
  return putFile(path, JSON.stringify(value));
}

/** Read a JSON file. */
export async function getJSON(path) {
  const buf = await getFile(path);
  if (!buf) return null;
  return JSON.parse(new TextDecoder().decode(new Uint8Array(buf)));
}

/** Remove every file of a directory (a dataset). */
export async function removeDir(prefix) {
  const paths = await listFiles(prefix);
  for (const p of paths) await deleteFile(p);
  return paths.length;
}

/** How much space the local project uses (in bytes). */
export async function usage() {
  const store = await tx('readonly');
  const values = await done(store.getAll());
  return values.reduce((sum, v) => sum + (v.byteLength || 0), 0);
}
