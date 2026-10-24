// UNTESTED (needs a browser). Minimal IndexedDB key-value store used for the offline session cache.
import type { KeyValueStore } from './core/session.ts';

export function createIdbStore(dbName = 'mthse', storeName = 'kv'): KeyValueStore {
  const open = () =>
    new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open(dbName, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(storeName);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });

  async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await open();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const req = fn(tx.objectStore(storeName));
      tx.oncomplete = () => { db.close(); resolve(req.result); };
      tx.onerror = () => { db.close(); reject(tx.error); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    });
  }

  return {
    get: async (k) => ((await run('readonly', (s) => s.get(k))) as string | undefined) ?? null,
    set: async (k, v) => { await run('readwrite', (s) => s.put(v, k)); },
    remove: async (k) => { await run('readwrite', (s) => s.delete(k)); },
  };
}
