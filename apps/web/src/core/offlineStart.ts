// Starting an inspection without a connection. The app picks the inspection's id and remembers the start ("draft")
// on the device; the server creates it when it can (re-sending is safe: same id = same inspection). Answers typed in
// the meantime wait in the normal outbox and are only sent after the creation succeeded.
import { ApiError, NetworkError } from './apiClient.ts';
import type { PutOutcome, SyncApi } from './inspectionSync.ts';
import type { KeyValueStore } from './session.ts';
import type { InspectionDto } from './types.ts';

export type DraftStart = {
  id: string; templateId: string; templateVersionId: string; siteId: string | null; title: string | null;
  startedBy: string; startedAt: string;
  failedCode?: string;                      // the server refused the start for good (template unpublished, no permission...)
};
export type StartBody = { id: string; templateId: string; templateVersionId: string; siteId?: string; title?: string };

export type StartOutcome = { kind: 'ok' } | { kind: 'network' } | { kind: 'auth' } | { kind: 'rejected'; code: string };
export interface StartApi { start(body: StartBody): Promise<StartOutcome> }

export function toStartOutcome(err: unknown): StartOutcome {
  if (err instanceof NetworkError) return { kind: 'network' };
  if (err instanceof ApiError) {
    if (err.status === 401) return { kind: 'auth' };
    if (err.status === 408 || err.status === 429 || err.status >= 500) return { kind: 'network' };
    return { kind: 'rejected', code: err.code };
  }
  return { kind: 'network' };
}

export function createStartApi(startFn: (body: StartBody) => Promise<unknown>): StartApi {
  return {
    async start(body) {
      try { await startFn(body); return { kind: 'ok' }; } catch (err) { return toStartOutcome(err); }
    },
  };
}

export type EnsureResult = { kind: 'ready' } | { kind: 'offline' } | { kind: 'auth' } | { kind: 'rejected'; code: string };

const KEY = 'mthse.starts.v1';
const UUID_V4 = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
  const r = Math.floor(Math.random() * 16);
  return (c === 'x' ? r : (r & 3) | 8).toString(16);
});
const randomUuid = () => globalThis.crypto?.randomUUID?.() ?? UUID_V4();

export type OfflineStartsOptions = { store: KeyValueStore; api: StartApi; newId?: () => string; now?: () => Date };

export class OfflineStarts {
  private o: OfflineStartsOptions;
  private drafts: DraftStart[] = [];
  private inFlight = new Map<string, Promise<EnsureResult>>();
  private listeners = new Set<() => void>();
  private authFailed = false;

  constructor(options: OfflineStartsOptions) { this.o = options; }

  async init(): Promise<void> {
    const raw = await this.o.store.get(KEY);
    if (raw) {
      try {
        const saved = JSON.parse(raw) as { drafts?: DraftStart[] };
        this.drafts = (saved.drafts ?? []).filter((d) => d && typeof d.id === 'string' && typeof d.templateId === 'string' && typeof d.templateVersionId === 'string');
      } catch { /* unreadable list: nothing to recover */ }
    }
    this.emit();
  }

  subscribe(fn: () => void): () => void { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  list(): DraftStart[] { return this.drafts.map((d) => ({ ...d })); }
  get(id: string): DraftStart | null { const d = this.drafts.find((x) => x.id === id); return d ? { ...d } : null; }

  /** Remembers the start on the device first; the caller then tries to send it (ensureCreated). */
  async create(input: { templateId: string; templateVersionId: string; siteId?: string | null; title?: string | null; startedBy: string }): Promise<DraftStart> {
    const d: DraftStart = {
      id: (this.o.newId ?? randomUuid)(), templateId: input.templateId, templateVersionId: input.templateVersionId,
      siteId: input.siteId || null, title: input.title?.trim() || null, startedBy: input.startedBy, startedAt: (this.o.now?.() ?? new Date()).toISOString(),
    };
    this.drafts.push(d);
    await this.persist();
    this.emit();
    return { ...d };
  }

  /** Makes sure the server has this inspection. Safe to call often; concurrent calls share one request. */
  ensureCreated(id: string): Promise<EnsureResult> {
    const d = this.drafts.find((x) => x.id === id);
    if (!d) return Promise.resolve({ kind: 'ready' });          // already on the server (or never a draft)
    if (d.failedCode) return Promise.resolve({ kind: 'rejected', code: d.failedCode });
    if (this.authFailed) return Promise.resolve({ kind: 'auth' });
    const running = this.inFlight.get(id);
    if (running) return running;
    const p = this.send(d).finally(() => { this.inFlight.delete(id); });
    this.inFlight.set(id, p);
    return p;
  }

  /** Sends every waiting start, oldest first; stops at the first sign of "offline" or "signed out". */
  async flushAll(): Promise<void> {
    for (const d of this.list()) {
      if (d.failedCode) continue;
      const r = await this.ensureCreated(d.id);
      if (r.kind === 'offline' || r.kind === 'auth') return;
    }
  }

  /** Called when the connection is back or the person signed in again. */
  notifyOnline(): void { this.authFailed = false; void this.flushAll(); }

  async discard(id: string): Promise<void> {
    if (!this.drafts.some((d) => d.id === id)) return;
    this.drafts = this.drafts.filter((d) => d.id !== id);
    await this.persist();
    this.emit();
  }

  async clear(): Promise<void> {
    this.drafts = [];
    this.authFailed = false;
    await this.o.store.remove(KEY);
    this.emit();
  }

  /** What the screens show for a start the server does not know yet. */
  toInspection(d: DraftStart): InspectionDto {
    return {
      id: d.id, templateId: d.templateId, templateVersionId: d.templateVersionId, title: d.title, status: 'in_progress',
      startedBy: d.startedBy, siteId: d.siteId, startedAt: d.startedAt, completedAt: null, scorePct: null, passed: null, flaggedRate: null, version: 0,
    };
  }

  // ---------- internals ----------

  private emit() { for (const l of [...this.listeners]) l(); }
  private async persist() {
    if (this.drafts.length === 0) await this.o.store.remove(KEY);
    else await this.o.store.set(KEY, JSON.stringify({ v: 1, drafts: this.drafts }));
  }

  private async send(d: DraftStart): Promise<EnsureResult> {
    const out = await this.o.api.start({
      id: d.id, templateId: d.templateId, templateVersionId: d.templateVersionId,
      ...(d.siteId ? { siteId: d.siteId } : {}), ...(d.title ? { title: d.title } : {}),
    });
    if (out.kind === 'network') return { kind: 'offline' };
    if (out.kind === 'auth') { this.authFailed = true; return { kind: 'auth' }; }
    const still = this.drafts.find((x) => x.id === d.id);
    if (out.kind === 'ok') {
      if (still) { this.drafts = this.drafts.filter((x) => x.id !== d.id); await this.persist(); this.emit(); }
      return { kind: 'ready' };
    }
    if (still) { still.failedCode = out.code; await this.persist(); this.emit(); }
    return { kind: 'rejected', code: out.code };
  }
}

/** The sync engine sends answers through this: nothing is sent for an inspection the server has not created yet. */
export function createEnsuringSyncApi(base: SyncApi, starts: { ensureCreated(id: string): Promise<EnsureResult> }): SyncApi {
  return {
    async putResponse(inspectionId, questionId, value, baseVersion): Promise<PutOutcome> {
      const r = await starts.ensureCreated(inspectionId);
      if (r.kind === 'offline') return { kind: 'network' };
      if (r.kind === 'auth') return { kind: 'auth' };
      if (r.kind === 'rejected') return { kind: 'rejected', code: r.code };
      return base.putResponse(inspectionId, questionId, value, baseVersion);
    },
  };
}
