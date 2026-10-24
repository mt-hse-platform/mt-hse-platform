// UNTESTED (needs a browser). IndexedDB store for the photo upload queue: keeps the file bytes on the device
// until the server has them. Separate database from the key-value stores so a failure here cannot hurt the session cache.
import type { BlobStore } from './core/photoQueue.ts';

export function createIdbBlobStore(dbName = 'mthse-photos', storeName = 'blobs'): BlobStore {
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
    put: async (k, b) => { await run('readwrite', (s) => s.put(b, k)); },
    get: async (k) => ((await run('readonly', (s) => s.get(k))) as Blob | undefined) ?? null,
    remove: async (k) => { await run('readwrite', (s) => s.delete(k)); },
  };
}
