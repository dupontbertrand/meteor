const DB_NAME = '~name~';
const DB_VERSION = 1;
let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('documents')) {
        db.createObjectStore('documents', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('mutations')) {
        db.createObjectStore('mutations', { keyPath: 'mutationId' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

export async function idbPut(store, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, 'readwrite');
    t.objectStore(store).put(value);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

export async function idbDelete(store, key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, 'readwrite');
    t.objectStore(store).delete(key);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

export async function idbGetAll(store) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readonly').objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function idbClear(store) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, 'readwrite');
    t.objectStore(store).clear();
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}
