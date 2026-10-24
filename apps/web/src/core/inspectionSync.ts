// Offline-first autosave for ONE inspection. Answers are applied locally at once, kept in a persistent outbox, and sent
// to the server one question at a time (each with the server version it is based on). Conflicts are never resolved
// silently: the user chooses between the local and the server answer.
import { ApiError, NetworkError } from './apiClient.ts';
import type { KeyValueStore } from './session.ts';

export type RemoteResponse = { value: unknown; version: number };

export type PutOutcome =
  | { kind: 'ok'; version: number }
  | { kind: 'conflict'; current: RemoteResponse | null }
  | { kind: 'rejected'; code: string }   // retrying cannot help (validation, not editable, no permission...)
  | { kind: 'network' }                  // offline or a temporary server problem: retry later
  | { kind: 'auth' };                    // session expired: stop and sign in again

export interface SyncApi {
  putResponse(inspectionId: string, questionId: string, value: unknown, baseVersion: number): Promise<PutOutcome>;
}

/** Adapts the HTTP client to the sync API. */
export function createSyncApi(client: { request<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> }): SyncApi {
  return {
    async putResponse(inspectionId, questionId, value, baseVersion) {
      try {
        const r = await client.request<{ response: { version: number } }>(
          `/inspections/${inspectionId}/responses/${questionId}`, { method: 'PUT', body: { value, baseVersion } });
        return { kind: 'ok', version: r.response.version };
      } catch (err) {
        return toPutOutcome(err);
      }
    },
  };
}

export function toPutOutcome(err: unknown): PutOutcome {
  if (err instanceof NetworkError) return { kind: 'network' };
  if (err instanceof ApiError) {
    if (err.status === 401) return { kind: 'auth' };
    if (err.status === 409 && err.code === 'conflict') {
      const current = (err.details as { current?: { value?: unknown; version?: number } | null } | undefined)?.current;
      return { kind: 'conflict', current: current && typeof current.version === 'number' ? { value: current.value ?? null, version: current.version } : null };
    }
    if (err.status === 408 || err.status === 429 || err.status >= 500) return { kind: 'network' };
    return { kind: 'rejected', code: err.code };
  }
  return { kind: 'network' };
}

export type SyncStatus = 'saved' | 'saving' | 'offline' | 'conflict' | 'auth' | 'locked';

export type Scheduler = { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void };
const realScheduler: Scheduler = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };

type PendingOp = { value: unknown; baseVersion: number };

export type SyncOptions = {
  inspectionId: string;
  api: SyncApi;
  store: KeyValueStore;
  scheduler?: Scheduler;
  debounceMs?: number;
  onChange?: () => void;
  onAuthError?: () => void;
};

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
/** Where the unsent answers of one inspection are kept on the device. */
export const pendingStoreKey = (inspectionId: string) => `mthse.pending.${inspectionId}`;
export const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000];

export class InspectionSync {
  private o: SyncOptions;
  private sched: Scheduler;
  private server: Record<string, RemoteResponse> = {};
  private pending: Record<string, PendingOp> = {};
  private conflictMap: Record<string, { local: unknown; server: RemoteResponse | null }> = {};
  private errorMap: Record<string, string> = {};
  private inFlight: string | null = null;
  private offline = false;
  private authFailed = false;
  private locked = false;
  private attempt = 0;
  private flushTimer: unknown = null;
  private retryTimer: unknown = null;
  private flushPromise: Promise<void> | null = null;
  private again = false;
  private disposed = false;

  constructor(options: SyncOptions) {
    this.o = options;
    this.sched = options.scheduler ?? realScheduler;
  }

  private get key() { return pendingStoreKey(this.o.inspectionId); }

  /** Call with the server's current answers; restores answers that were typed offline and never sent. */
  async init(serverResponses: Record<string, RemoteResponse>, opts: { locked?: boolean } = {}): Promise<void> {
    this.server = { ...serverResponses };
    this.locked = opts.locked === true;
    const raw = await this.o.store.get(this.key);
    if (raw && !this.locked) {
      try {
        const saved = JSON.parse(raw) as { v?: number; pending?: Record<string, PendingOp> };
        for (const [q, op] of Object.entries(saved.pending ?? {})) {
          const s = this.server[q];
          if (s && s.version > op.baseVersion && same(s.value, op.value)) continue; // already applied elsewhere
          this.pending[q] = { value: op.value, baseVersion: op.baseVersion };
        }
      } catch { /* corrupted outbox: ignore, server data is the truth */ }
    }
    if (this.locked) await this.o.store.remove(this.key);
    this.emit();
    if (Object.keys(this.pending).length > 0 && !this.locked) this.scheduleFlush(0);
  }

  getValue(questionId: string): unknown {
    const p = this.pending[questionId];
    if (p) return p.value;
    return this.server[questionId]?.value ?? null;
  }

  getVersion(questionId: string): number { return this.server[questionId]?.version ?? 0; }
  pendingCount(): number { return Object.keys(this.pending).length; }
  errors(): Record<string, string> { return { ...this.errorMap }; }
  conflicts(): Record<string, { local: unknown; server: RemoteResponse | null }> {
    return Object.fromEntries(Object.entries(this.conflictMap).map(([q, c]) => [q, { ...c }]));
  }

  getStatus(): SyncStatus {
    if (this.locked) return 'locked';
    if (this.authFailed) return 'auth';
    if (Object.keys(this.conflictMap).length > 0) return 'conflict';
    if (this.offline && this.pendingCount() > 0) return 'offline';
    if (this.inFlight !== null || this.pendingCount() > 0) return 'saving';
    return 'saved';
  }

  async setAnswer(questionId: string, value: unknown): Promise<void> {
    if (this.locked || this.disposed) return;
    delete this.errorMap[questionId];
    const conflict = this.conflictMap[questionId];
    if (conflict) { conflict.local = value; this.pending[questionId] = { value, baseVersion: this.pending[questionId]?.baseVersion ?? 0 }; await this.persist(); this.emit(); return; }
    const existing = this.pending[questionId];
    if (!existing && same(this.server[questionId]?.value, value)) { this.emit(); return; } // nothing changed
    this.pending[questionId] = { value, baseVersion: existing ? existing.baseVersion : this.getVersion(questionId) };
    await this.persist();
    this.emit();
    this.scheduleFlush(this.o.debounceMs ?? 500);
  }

  /** Called when the browser reports it is online again. */
  notifyOnline(): void {
    this.attempt = 0;
    if (this.retryTimer) { this.sched.clear(this.retryTimer); this.retryTimer = null; }
    this.offline = false;
    this.emit();
    void this.flush();
  }

  async resolveConflict(questionId: string, choice: 'keep_local' | 'keep_server'): Promise<void> {
    const c = this.conflictMap[questionId];
    if (!c) return;
    delete this.conflictMap[questionId];
    if (choice === 'keep_server') {
      if (c.server) this.server[questionId] = c.server; else delete this.server[questionId];
      delete this.pending[questionId];
    } else {
      const op = this.pending[questionId] ?? { value: c.local, baseVersion: 0 };
      this.pending[questionId] = { value: c.local ?? op.value, baseVersion: c.server?.version ?? 0 };
      if (c.server) this.server[questionId] = c.server;
    }
    await this.persist();
    this.emit();
    if (choice === 'keep_local') this.scheduleFlush(0);
  }

  flush(): Promise<void> {
    if (this.flushPromise) { this.again = true; return this.flushPromise; }
    this.flushPromise = this.run().finally(() => { this.flushPromise = null; });
    return this.flushPromise;
  }

  dispose(): void {
    this.disposed = true;
    if (this.flushTimer) this.sched.clear(this.flushTimer);
    if (this.retryTimer) this.sched.clear(this.retryTimer);
  }

  // ---------- internals ----------

  private emit() { if (!this.disposed) this.o.onChange?.(); }

  private async persist() {
    if (Object.keys(this.pending).length === 0) await this.o.store.remove(this.key);
    else await this.o.store.set(this.key, JSON.stringify({ v: 1, pending: this.pending }));
  }

  private scheduleFlush(ms: number) {
    if (this.flushTimer) this.sched.clear(this.flushTimer);
    this.flushTimer = this.sched.set(() => { this.flushTimer = null; void this.flush(); }, ms);
  }

  private sendable(): string[] {
    return Object.keys(this.pending).filter((q) => !this.conflictMap[q]);
  }

  private async run(): Promise<void> {
    let passes = 0;
    do {
      if (++passes > 100) return; // safety net: never spin forever, whatever the state
      this.again = false;
      if (this.locked || this.authFailed || this.disposed) return;
      if (!(await this.sendAll())) return;
    } while (this.again || this.sendable().length > 0);
  }

  /** returns false when sending must stop (offline, auth, locked) */
  private async sendAll(): Promise<boolean> {
    for (const q of this.sendable()) {
      const op = this.pending[q];
      if (!op) continue;
      this.inFlight = q;
      this.emit();
      const out = await this.o.api.putResponse(this.o.inspectionId, q, op.value, op.baseVersion);
      this.inFlight = null;

      if (out.kind === 'network') {
        this.offline = true;
        this.attempt++;
        const delay = BACKOFF_MS[Math.min(this.attempt - 1, BACKOFF_MS.length - 1)]!;
        if (this.retryTimer) this.sched.clear(this.retryTimer);
        this.retryTimer = this.sched.set(() => { this.retryTimer = null; void this.flush(); }, delay);
        this.emit();
        return false;
      }
      this.offline = false;
      this.attempt = 0;

      if (out.kind === 'auth') {
        this.authFailed = true;
        this.emit();
        this.o.onAuthError?.();
        return false;
      }
      if (out.kind === 'ok') {
        this.applySuccess(q, op, out.version);
      } else if (out.kind === 'conflict') {
        if (out.current && same(out.current.value, op.value)) {
          // the first attempt had reached the server but its reply was lost: nothing to resolve
          this.applySuccess(q, op, out.current.version);
        } else {
          this.conflictMap[q] = { local: op.value, server: out.current };
        }
      } else {
        // rejected
        if (out.code === 'not_editable') {
          this.locked = true;
          this.pending = {};
          await this.persist();
          this.emit();
          return false;
        }
        this.errorMap[q] = out.code;
        if (this.pending[q] === op) delete this.pending[q];
      }
      await this.persist();
      this.emit();
    }
    return true;
  }

  private applySuccess(q: string, sent: PendingOp, version: number) {
    this.server[q] = { value: sent.value, version };
    const now = this.pending[q];
    if (now === sent) delete this.pending[q];              // nothing newer typed meanwhile
    else if (now) now.baseVersion = version;               // newer edit made while this one was in flight
  }
}
