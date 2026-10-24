// Offline upload queue for photos / PDFs. A file picked in the field is stored on the device first (blob store) and
// uploaded later, one at a time, with retry. The uploaded media id is handed to the open inspection screen, which
// adds it to the answer through the normal autosave. Local placeholders (`local:...`) never reach the server.
import { ApiError, NetworkError } from './apiClient.ts';
import { uploadError } from './media.ts';
import type { UploadParams } from './media.ts';
import type { KeyValueStore } from './session.ts';
import type { Scheduler } from './inspectionSync.ts';
import { BACKOFF_MS } from './inspectionSync.ts';
import type { MessageKey } from '../../../../packages/i18n/src/index.ts';

export const LOCAL_PREFIX = 'local:';
export const isLocalId = (id: unknown): boolean => typeof id === 'string' && id.startsWith(LOCAL_PREFIX);

/** Removes queue placeholders from an answer; an answer left empty becomes null ("not answered"). */
export function stripLocalIds(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  const rest = value.filter((x) => !isLocalId(x));
  return rest.length === value.length ? value : rest.length ? rest : null;
}

export interface BlobStore {
  put(key: string, blob: Blob): Promise<void>;
  get(key: string): Promise<Blob | null>;
  remove(key: string): Promise<void>;
}

export type UploadOutcome =
  | { kind: 'ok'; mediaId: string }
  | { kind: 'network' }                                               // offline or temporary server problem: retry later
  | { kind: 'auth' }                                                  // session expired: stop until the user signs in
  | { kind: 'rejected'; key: MessageKey; params?: Record<string, number | string> }; // retrying cannot help

export interface PhotoUploader {
  upload(params: UploadParams, blob: Blob): Promise<UploadOutcome>;
  /** best effort: removes a file that was uploaded but is no longer wanted */
  remove(mediaId: string): Promise<void>;
}

/** Adapts the HTTP helpers to the queue. */
export function createPhotoUploader(
  uploadFn: (params: UploadParams, blob: Blob) => Promise<{ id: string }>,
  removeFn: (mediaId: string) => Promise<unknown>,
): PhotoUploader {
  return {
    async upload(params, blob) {
      try {
        const m = await uploadFn(params, blob);
        return { kind: 'ok', mediaId: m.id };
      } catch (err) {
        return toUploadOutcome(err);
      }
    },
    async remove(mediaId) { try { await removeFn(mediaId); } catch { /* best effort */ } },
  };
}

export function toUploadOutcome(err: unknown): UploadOutcome {
  if (err instanceof NetworkError) return { kind: 'network' };
  if (err instanceof ApiError) {
    if (err.status === 401) return { kind: 'auth' };
    if (err.status === 408 || err.status === 429 || err.status >= 500) return { kind: 'network' };
    const m = uploadError(err);
    return { kind: 'rejected', key: m.key, params: m.params };
  }
  return { kind: 'network' };
}

export type QueueItem = {
  id: string;                       // `local:<random>`: what the screen shows until the server id exists
  inspectionId: string;
  questionId: string;
  kind: 'photo' | 'file' | 'audio';
  mime: string;
  takenAt: string;
  mediaId?: string;                 // set once uploaded (the answer may not have it yet)
  failed?: { key: MessageKey; params?: Record<string, number | string> };
};

/** Return false when the file cannot be attached any more (the inspection is closed): the item is then marked failed. */
export type DeliverHandler = (item: QueueItem & { mediaId: string }) => Promise<boolean>;

export type PhotoQueueOptions = {
  store: KeyValueStore;
  blobs: BlobStore;
  uploader: PhotoUploader;
  scheduler?: Scheduler;
  newId?: () => string;
  onAuthError?: () => void;
};

const KEY = 'mthse.photoq.v1';
const realScheduler: Scheduler = { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };
const randomId = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`);

export class PhotoQueue {
  private o: PhotoQueueOptions;
  private sched: Scheduler;
  private items: QueueItem[] = [];
  private handlers = new Map<string, DeliverHandler>();
  private listeners = new Set<() => void>();
  private inFlight: string | null = null;
  private authFailed = false;
  private attempt = 0;
  private retryTimer: unknown = null;
  private runPromise: Promise<void> | null = null;
  private again = false;
  private discarded = new Set<string>();   // discarded while its upload was running

  constructor(options: PhotoQueueOptions) {
    this.o = options;
    this.sched = options.scheduler ?? realScheduler;
  }

  /** Loads what was left from the last session and starts uploading it. */
  async init(): Promise<void> {
    const raw = await this.o.store.get(KEY);
    if (raw) {
      try {
        const saved = JSON.parse(raw) as { items?: QueueItem[] };
        this.items = (saved.items ?? []).filter((i) => i && typeof i.id === 'string' && typeof i.inspectionId === 'string' && typeof i.questionId === 'string');
      } catch { /* corrupted list: nothing to recover */ }
    }
    this.emit();
    if (this.items.length > 0) void this.drain();
  }

  subscribe(fn: () => void): () => void { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }

  list(inspectionId: string): QueueItem[] { return this.items.filter((i) => i.inspectionId === inspectionId).map((i) => ({ ...i })); }
  forQuestion(inspectionId: string, questionId: string): QueueItem[] { return this.list(inspectionId).filter((i) => i.questionId === questionId); }
  /** Files of this inspection that are not yet part of its answers. Completion must wait for 0. */
  unfinishedCount(inspectionId: string): number { return this.items.filter((i) => i.inspectionId === inspectionId).length; }
  totalCount(): number { return this.items.length; }
  getBlob(id: string): Promise<Blob | null> { return this.o.blobs.get(id); }

  async enqueue(input: { inspectionId: string; questionId: string; kind: 'photo' | 'file' | 'audio'; blob: Blob; takenAt: string }): Promise<QueueItem> {
    const id = `${LOCAL_PREFIX}${(this.o.newId ?? randomId)()}`;
    await this.o.blobs.put(id, input.blob);               // blob first: a crash here leaves a harmless orphan, never a lost record
    const item: QueueItem = { id, inspectionId: input.inspectionId, questionId: input.questionId, kind: input.kind, mime: input.blob.type, takenAt: input.takenAt };
    this.items.push(item);
    await this.persist();
    this.emit();
    void this.drain();
    return { ...item };
  }

  async discard(id: string): Promise<void> {
    const item = this.items.find((i) => i.id === id);
    if (!item) return;
    if (this.inFlight === id) this.discarded.add(id);     // the running upload cleans up after itself
    this.items = this.items.filter((i) => i.id !== id);
    await this.persist();                                  // record first, then blob
    await this.o.blobs.remove(id);
    if (item.mediaId) await this.o.uploader.remove(item.mediaId);
    this.emit();
  }

  async discardQuestion(inspectionId: string, questionId: string): Promise<void> {
    for (const i of this.forQuestion(inspectionId, questionId)) await this.discard(i.id);
  }

  /** Drops every waiting file of one inspection (the draft was cancelled). */
  async discardInspection(inspectionId: string): Promise<void> {
    for (const i of this.list(inspectionId)) await this.discard(i.id);
  }

  /** Puts a failed file back in the line (after the person fixed the cause, or just to try again). */
  async retry(id: string): Promise<void> {
    const item = this.items.find((i) => i.id === id);
    if (!item || !item.failed) return;
    delete item.failed;
    await this.persist();
    this.emit();
    void this.drain();
  }

  /** The inspection screen registers here; uploaded files that wait for it are delivered at once. */
  attach(inspectionId: string, handler: DeliverHandler): () => void {
    this.handlers.set(inspectionId, handler);
    void this.drain();
    return () => { if (this.handlers.get(inspectionId) === handler) this.handlers.delete(inspectionId); };
  }

  /** Called when the browser reports it is online again (or after signing in). */
  notifyOnline(): void {
    this.attempt = 0;
    this.authFailed = false;
    if (this.retryTimer) { this.sched.clear(this.retryTimer); this.retryTimer = null; }
    void this.drain();
  }

  /** Removes everything (sign-out: the files belong to the previous person). */
  async clear(): Promise<void> {
    if (this.retryTimer) { this.sched.clear(this.retryTimer); this.retryTimer = null; }
    const all = this.items;
    for (const i of all) if (this.inFlight === i.id) this.discarded.add(i.id);
    this.items = [];
    await this.o.store.remove(KEY);
    for (const i of all) await this.o.blobs.remove(i.id);
    this.emit();
  }

  drain(): Promise<void> {
    if (this.runPromise) { this.again = true; return this.runPromise; }
    this.runPromise = this.run().finally(() => { this.runPromise = null; });
    return this.runPromise;
  }

  // ---------- internals ----------

  private emit() { for (const l of [...this.listeners]) l(); }
  private async persist() {
    if (this.items.length === 0) await this.o.store.remove(KEY);
    else await this.o.store.set(KEY, JSON.stringify({ v: 1, items: this.items }));
  }

  private async run(): Promise<void> {
    let passes = 0;
    do {
      if (++passes > 100) return;               // safety net: never spin forever
      this.again = false;
      if (this.authFailed) return;
      if (!(await this.pass())) return;
    } while (this.again);
  }

  /** false = stop (offline or session expired) */
  private async pass(): Promise<boolean> {
    // 1) uploaded files that now have a screen waiting for them
    for (const item of [...this.items]) {
      if (!item.mediaId || item.failed) continue;
      await this.deliver(item);
    }
    // 2) files still to upload, oldest first
    for (const item of [...this.items]) {
      if (item.mediaId || item.failed) continue;
      if (!this.items.includes(item)) continue;            // discarded meanwhile
      const blob = await this.o.blobs.get(item.id);
      if (!blob) { item.failed = { key: 'media.queueLost' }; await this.persist(); this.emit(); continue; }
      this.inFlight = item.id;
      this.emit();
      const out = await this.o.uploader.upload(
        { ownerType: 'inspection', ownerId: item.inspectionId, kind: item.kind, questionId: item.questionId, takenAt: item.takenAt }, blob);
      this.inFlight = null;

      if (this.discarded.delete(item.id)) {                // the person removed it while it was uploading
        if (out.kind === 'ok') await this.o.uploader.remove(out.mediaId);
        continue;
      }
      if (out.kind === 'network') {
        this.attempt++;
        const delay = BACKOFF_MS[Math.min(this.attempt - 1, BACKOFF_MS.length - 1)]!;
        if (this.retryTimer) this.sched.clear(this.retryTimer);
        this.retryTimer = this.sched.set(() => { this.retryTimer = null; void this.drain(); }, delay);
        this.emit();
        return false;
      }
      this.attempt = 0;
      if (out.kind === 'auth') { this.authFailed = true; this.emit(); this.o.onAuthError?.(); return false; }
      if (out.kind === 'rejected') {
        item.failed = { key: out.key, params: out.params };
      } else {
        item.mediaId = out.mediaId;                         // saved BEFORE delivery: a restart never uploads it twice
      }
      await this.persist();
      this.emit();
      if (item.mediaId) await this.deliver(item);
    }
    return true;
  }

  private async deliver(item: QueueItem): Promise<void> {
    const handler = this.handlers.get(item.inspectionId);
    if (!handler || !item.mediaId) return;                  // no screen yet: stays until the inspection is opened
    let applied = false;
    try { applied = await handler({ ...item, mediaId: item.mediaId }); } catch { return; }
    if (!this.items.includes(item)) return;
    if (applied) {
      this.items = this.items.filter((i) => i !== item);
      await this.persist();
      await this.o.blobs.remove(item.id);
    } else {
      item.failed = { key: 'media.queueClosed' };
      await this.persist();
    }
    this.emit();
  }
}
