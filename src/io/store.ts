/** Tiny IndexedDB key–value store for autosave (fails silently when unavailable). */
const DB = 'liemorph';
const STORE = 'kv';

function open(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

export async function kvSet(key: string, value: unknown): Promise<void> {
  try {
    const db = await open();
    await new Promise<void>((res, rej) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
    db.close();
  } catch {
    /* ignore */
  }
}

export async function kvGet<T>(key: string): Promise<T | undefined> {
  try {
    const db = await open();
    const v = await new Promise<T | undefined>((res, rej) => {
      const r = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      r.onsuccess = () => res(r.result as T | undefined);
      r.onerror = () => rej(r.error);
    });
    db.close();
    return v;
  } catch {
    return undefined;
  }
}

export async function kvDelete(key: string): Promise<void> {
  try {
    const db = await open();
    db.transaction(STORE, 'readwrite').objectStore(STORE).delete(key);
    db.close();
  } catch {
    /* ignore */
  }
}
