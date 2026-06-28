// Minimal promise wrapper over IndexedDB: one key-value object store.
// Used for the durable crash-recovery draft (survives app close, unlike
// sessionStorage). Values are structured-cloned, so Uint8Array project bytes
// round-trip natively. All calls reject gracefully if IndexedDB is unavailable.

const DB_NAME = 'bumpforge';
const STORE   = 'kv';
const VERSION = 1;

let _dbPromise = null;

function _db() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB unavailable')); return; }
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
  return _dbPromise;
}

async function _tx(mode, run) {
  const db = await _db();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE, mode);
    const req = run(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req ? req.result : undefined);
    tx.onerror    = () => reject(tx.error);
    tx.onabort    = () => reject(tx.error);
  });
}

export const idbGet = (key)        => _tx('readonly',  (s) => s.get(key));
export const idbSet = (key, value) => _tx('readwrite', (s) => s.put(value, key));
export const idbDel = (key)        => _tx('readwrite', (s) => s.delete(key));
