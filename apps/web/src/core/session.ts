import type { Grant } from '../../../../packages/shared/src/permissions.ts';

export type Session = {
  firebaseUid: string;
  user: { id: string; fullName: string; email: string; locale: 'ar' | 'en' };
  orgId: string;
  grants: Grant[];
  siteIds: string[];
};

/** Async key-value store (IndexedDB in the browser; in-memory in tests). */
export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

const KEY = 'mthse.session.v1';

type Cached = { session: Session; validatedAt: number };

export class SessionCache {
  private store: KeyValueStore;
  constructor(store: KeyValueStore) {
    this.store = store;
  }

  async save(session: Session, now: number): Promise<void> {
    const entry: Cached = { session, validatedAt: now };
    await this.store.set(KEY, JSON.stringify(entry));
  }

  /** Returns the cached session only if it belongs to `firebaseUid` and was validated online within `maxAgeMs`. */
  async load(firebaseUid: string, now: number, maxAgeMs: number): Promise<Session | null> {
    const raw = await this.store.get(KEY);
    if (!raw) return null;
    let entry: Cached;
    try {
      entry = JSON.parse(raw) as Cached;
    } catch {
      return null;
    }
    if (!entry?.session || typeof entry.validatedAt !== 'number') return null;
    if (entry.session.firebaseUid !== firebaseUid) return null;
    if (now - entry.validatedAt > maxAgeMs) return null;
    return entry.session;
  }

  async clear(): Promise<void> {
    await this.store.remove(KEY);
  }
}
