// UNTESTED (needs a browser + Firebase). Wires the tested core to Firebase Auth, IndexedDB and the API.
import { initializeApp } from 'firebase/app';
import {
  createUserWithEmailAndPassword, getAuth, sendEmailVerification, sendPasswordResetEmail, signInWithEmailAndPassword, signOut as fbSignOut,
} from 'firebase/auth';
import firebaseConfig from '../../../config/firebase.public.json';
import { ApiError, NetworkError, createApiClient, wrapTokenGetter } from './core/apiClient.ts';
import { createEndpoints } from './core/endpoints.ts';
import { createSyncApi } from './core/inspectionSync.ts';
import { uploadPath } from './core/media.ts';
import type { UploadParams } from './core/media.ts';
import type { MediaDto } from './core/types.ts';
import { SessionCache } from './core/session.ts';
import { bootSession } from './core/bootstrap.ts';
import type { BootResult, SessionResponse } from './core/bootstrap.ts';
import { createIdbStore } from './idbStore.ts';
import { createIdbBlobStore } from './idbBlobStore.ts';
import { PhotoQueue, createPhotoUploader } from './core/photoQueue.ts';
import { OfflineStarts, createEnsuringSyncApi, createStartApi } from './core/offlineStart.ts';
import { TemplateCache } from './core/templateCache.ts';
import { pendingStoreKey } from './core/inspectionSync.ts';

const auth = getAuth(initializeApp(firebaseConfig));
const cache = new SessionCache(createIdbStore());

const getToken = wrapTokenGetter(async () => {
  const u = auth.currentUser;
  if (!u) throw Object.assign(new Error('no user'), { code: 'unauthenticated' });
  return u.getIdToken();
});
const api = createApiClient({ baseUrl: '/api', getToken });

export const endpoints = createEndpoints(api);
export const syncApi = createSyncApi(api);
/** Local key-value store (IndexedDB): the answers outbox of the inspection screen lives here. */
export const localStore = createIdbStore('mthse-outbox');

/** GET with the user's token for non-JSON responses (report HTML / PDF). Errors become ApiError / NetworkError. */
export async function authorizedFetch(path: string): Promise<Response> {
  const token = await getToken();
  let res: Response;
  try {
    res = await fetch(`/api${path}`, { headers: { authorization: `Bearer ${token}` } });
  } catch {
    throw new NetworkError();
  }
  if (!res.ok) {
    let code = 'unknown';
    try { const b = (await res.json()) as { code?: unknown }; if (typeof b.code === 'string') code = b.code; } catch { /* not JSON */ }
    throw new ApiError(res.status, code);
  }
  return res;
}

/** Photos and PDFs picked in the field: kept on the device and uploaded when there is a connection. */
export const photoQueue = new PhotoQueue({
  store: localStore,
  blobs: createIdbBlobStore(),
  uploader: createPhotoUploader((params, blob) => uploadMedia(params, blob), (id) => endpoints.deleteMedia(id)),
});
let photoQueueStarted = false;

/** Inspections started without a connection (waiting to be created on the server) and the templates they use. */
export const offlineStarts = new OfflineStarts({ store: localStore, api: createStartApi((body) => endpoints.startInspection(body)) });
export const templateCache = new TemplateCache({
  store: localStore,
  api: {
    async listPublished() {
      const all: { id: string; name: import('../../../packages/engines/src/template/types.ts').LocalizedText; description: import('../../../packages/engines/src/template/types.ts').LocalizedText | null; publishedVersionId: string | null }[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 5; page++) {
        const r = await endpoints.listTemplates({ status: 'published', limit: 100, cursor });
        for (const t of r.items) all.push({ id: t.id, name: t.name, description: t.description, publishedVersionId: t.publishedVersionId });
        if (!r.nextCursor) break;
        cursor = r.nextCursor;
      }
      return all;
    },
    getVersionContent: async (templateId, versionId) => (await endpoints.getVersion(templateId, versionId)).version.content,
    listSites: async () => (await endpoints.listSites()).items.map((s) => ({ id: s.id, name: s.name })),
  },
});
/** The sync engine sends answers through this: nothing goes out for an inspection the server has not created yet. */
export const ensuringSyncApi = createEnsuringSyncApi(syncApi, offlineStarts);

let offlineBoot: Promise<void> | null = null;
/** Loads the device copies once (safe to call from anywhere, as often as needed), then sends waiting starts and refreshes templates. */
export function offlineReady(): Promise<void> {
  if (!offlineBoot) {
    offlineBoot = (async () => {
      await Promise.all([offlineStarts.init(), templateCache.init()]);
      await offlineStarts.flushAll();
      void templateCache.refresh(offlineStarts.list().map((d) => d.templateVersionId));
    })();
  }
  return offlineBoot;
}

/** Drops an inspection that only exists on this device (never reached the server): its start, answers and files. */
export async function discardLocalDraft(id: string): Promise<void> {
  await offlineStarts.discard(id);
  await photoQueue.discardInspection(id);
  await localStore.remove(pendingStoreKey(id));
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    if (photoQueueStarted) photoQueue.notifyOnline();
    if (offlineBoot) void offlineBoot.then(() => { offlineStarts.notifyOnline(); void templateCache.refresh(offlineStarts.list().map((d) => d.templateVersionId)); });
  });
}

export const platform = {
  /** Starts the upload queue once a signed-in session exists (it needs the user's token); later calls just retry. */
  startPhotoQueue(): void {
    if (photoQueueStarted) { photoQueue.notifyOnline(); return; }
    photoQueueStarted = true;
    void photoQueue.init();
  },
  /** Loads the offline copies and sends what was waiting; later calls (new session, back online) retry. */
  startOfflineServices(): void {
    const first = offlineBoot === null;
    void offlineReady().then(() => { if (!first) { offlineStarts.notifyOnline(); void templateCache.refresh(offlineStarts.list().map((d) => d.templateVersionId)); } });
  },
  /** Things that are only on this device and would be lost by signing out: files and inspections not yet sent. */
  pendingUploads(): number { return photoQueue.totalCount() + offlineStarts.list().length; },
  /** Firebase restores the signed-in user from IndexedDB, also when offline. */
  boot(): Promise<BootResult> {
    return bootSession({
      auth: {
        currentUser: async () => {
          await auth.authStateReady();
          return auth.currentUser ? { uid: auth.currentUser.uid } : null;
        },
      },
      cache,
      fetchSession: () => api.request<SessionResponse>('/auth/session'),
      now: () => Date.now(),
    });
  },
  async signIn(email: string, password: string): Promise<void> {
    await signInWithEmailAndPassword(auth, email.trim(), password);
  },
  /** Creates the Firebase account and sends the verification e-mail. Access still needs an invitation for this e-mail. */
  async signUp(email: string, password: string): Promise<void> {
    const cred = await createUserWithEmailAndPassword(auth, email.trim(), password);
    await sendEmailVerification(cred.user);
  },
  currentEmail(): string {
    return auth.currentUser?.email ?? '';
  },
  async resendVerification(): Promise<void> {
    if (auth.currentUser) await sendEmailVerification(auth.currentUser);
  },
  /** After the user clicked the link: reload the account and force a fresh token that carries email_verified. */
  async refreshVerification(): Promise<void> {
    if (!auth.currentUser) return;
    await auth.currentUser.reload();
    await auth.currentUser.getIdToken(true);
  },
  async resetPassword(email: string): Promise<void> {
    await sendPasswordResetEmail(auth, email.trim());
  },
  async signOut(): Promise<void> {
    await photoQueue.clear();   // the waiting files belong to the person who is leaving
    photoQueueStarted = false;
    await offlineStarts.clear();
    await templateCache.clear();
    offlineBoot = null;
    await cache.clear();
    await fbSignOut(auth);
  },
};

/** Uploads one file (binary body). Failures become ApiError (with field details) or NetworkError. */
export async function uploadMedia(params: UploadParams, blob: Blob): Promise<MediaDto> {
  const token = await getToken();
  let res: Response;
  try {
    res = await fetch(`/api${uploadPath(params)}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': blob.type }, body: blob });
  } catch {
    throw new NetworkError();
  }
  type UploadBody = { code?: string; errors?: unknown; media?: MediaDto };
  const body: UploadBody | null = await res.json().then((j: unknown) => j as UploadBody, () => null);
  if (!res.ok || !body?.media) throw new ApiError(res.status, typeof body?.code === 'string' ? body.code : 'unknown', body?.errors);
  return body.media;
}

/** A temporary address for showing a stored photo (the file needs the user's token, so it cannot be a plain link). */
export async function mediaObjectUrl(id: string): Promise<string> {
  return URL.createObjectURL(await (await authorizedFetch(`/media/${id}`)).blob());
}
