// IndexedDB persistence with localStorage fallback. All records are plain JSON.
const DB_NAME = 'tome-and-table';
const DB_VERSION = 1;
const STORES = ['characters', 'notes', 'meta'];

let dbPromise = null;
let fallback = false;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in globalThis)) { fallback = true; resolve(null); return; }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of STORES) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { fallback = true; resolve(null); };
  });
  return dbPromise;
}

export const usingFallback = () => fallback;

const lsKey = (store) => `tt:${store}`;
const lsRead = (store) => { try { return JSON.parse(localStorage.getItem(lsKey(store)) || '{}'); } catch { return {}; } };
const lsWrite = (store, obj) => localStorage.setItem(lsKey(store), JSON.stringify(obj));

function tx(db, store, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const os = t.objectStore(store);
    const req = fn(os);
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export async function getAll(store) {
  const db = await openDb();
  if (!db) return Object.values(lsRead(store));
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readonly').objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

export async function get(store, id) {
  const db = await openDb();
  if (!db) return lsRead(store)[id] || null;
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readonly').objectStore(store).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

export async function put(store, record) {
  if (!record.id) throw new Error('record needs an id');
  const db = await openDb();
  if (!db) { const all = lsRead(store); all[record.id] = record; lsWrite(store, all); return record; }
  await tx(db, store, 'readwrite', (os) => os.put(record));
  return record;
}

export async function putMany(store, records) {
  const db = await openDb();
  if (!db) { const all = lsRead(store); for (const r of records) all[r.id] = r; lsWrite(store, all); return; }
  await new Promise((resolve, reject) => {
    const t = db.transaction(store, 'readwrite');
    const os = t.objectStore(store);
    for (const r of records) os.put(r);
    t.oncomplete = resolve; t.onerror = () => reject(t.error);
  });
}

export async function remove(store, id) {
  const db = await openDb();
  if (!db) { const all = lsRead(store); delete all[id]; lsWrite(store, all); return; }
  await tx(db, store, 'readwrite', (os) => os.delete(id));
}

export async function clearAll() {
  const db = await openDb();
  if (!db) { for (const s of STORES) localStorage.removeItem(lsKey(s)); return; }
  for (const s of STORES) await tx(db, s, 'readwrite', (os) => os.clear());
}

export async function exportAll() {
  const [characters, notes, meta] = await Promise.all(STORES.map(getAll));
  return { app: 'tome-and-table', version: 1, exportedAt: new Date().toISOString(), characters, notes, meta };
}

// Merge-import: records with the same id are replaced; nothing else is touched.
export async function importAll(data) {
  if (!data || data.app !== 'tome-and-table') throw new Error('Not a Tome & Table export');
  const report = { characters: 0, notes: 0, skipped: 0 };
  const ok = (r) => r && typeof r === 'object' && typeof r.id === 'string';
  const chars = (data.characters || []).filter((c) => { if (ok(c) && typeof c.name === 'string') return true; report.skipped++; return false; });
  const notes = (data.notes || []).filter((n) => { if (ok(n) && typeof n.title === 'string') return true; report.skipped++; return false; });
  await putMany('characters', chars); report.characters = chars.length;
  await putMany('notes', notes); report.notes = notes.length;
  return report;
}

export const uid = () => (globalThis.crypto?.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);
