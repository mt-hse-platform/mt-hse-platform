import { ApiError, NetworkError } from './apiClient.ts';
import type { SessionCache, Session } from './session.ts';

export type AuthPort = {
  currentUser(): Promise<{ uid: string } | null>;
};

export type SessionResponse = Omit<Session, 'firebaseUid'>;

export type BootResult =
  | { status: 'ready'; session: Session; offline: boolean }
  | { status: 'signed_out'; reason: 'no_user' | 'session_expired' | 'forbidden' }
  | { status: 'org_required' }
  | { status: 'email_unverified' }
  | { status: 'error'; code: string };

export const DEFAULT_OFFLINE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // setting "Session timeout"

/**
 * App start. Online => the server decides (and refreshes the cache).
 * Offline => the cached session is used only if it is for the same Firebase user and was validated online recently.
 * A server answer of 401/403 ALWAYS wins over the cache: a deactivated user must lose access as soon as they are online.
 */
export async function bootSession(deps: {
  auth: AuthPort;
  cache: SessionCache;
  fetchSession: () => Promise<SessionResponse>;
  now: () => number;
  offlineMaxAgeMs?: number;
}): Promise<BootResult> {
  const user = await deps.auth.currentUser();
  if (!user) {
    await deps.cache.clear();
    return { status: 'signed_out', reason: 'no_user' };
  }

  try {
    const res = await deps.fetchSession();
    const session: Session = { ...res, firebaseUid: user.uid };
    await deps.cache.save(session, deps.now());
    return { status: 'ready', session, offline: false };
  } catch (err) {
    if (err instanceof NetworkError) {
      const cached = await deps.cache.load(user.uid, deps.now(), deps.offlineMaxAgeMs ?? DEFAULT_OFFLINE_MAX_AGE_MS);
      if (cached) return { status: 'ready', session: cached, offline: true };
      return { status: 'error', code: 'network' };
    }
    if (err instanceof ApiError) {
      if (err.status === 409 && err.code === 'org_required') return { status: 'org_required' };
      if (err.status === 403 && err.code === 'email_not_verified') return { status: 'email_unverified' };
      if (err.status === 401) {
        await deps.cache.clear();
        return { status: 'signed_out', reason: 'session_expired' };
      }
      if (err.status === 403) {
        await deps.cache.clear();
        return { status: 'signed_out', reason: 'forbidden' };
      }
      return { status: 'error', code: err.code };
    }
    return { status: 'error', code: 'unknown' };
  }
}
