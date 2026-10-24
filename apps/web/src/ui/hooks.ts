import { useCallback, useEffect, useState } from 'react';
import { parseRoute, pathOf } from '../core/router.ts';
import type { Route } from '../core/router.ts';

export type Loaded<T> = { data: T | null; error: unknown; loading: boolean; reload: () => void };

/** Runs `fn` on mount and whenever `deps` change; `reload()` runs it again. Ignores results of stale runs. */
export function useLoad<T>(fn: () => Promise<T>, deps: readonly unknown[]): Loaded<T> {
  const [state, setState] = useState<{ data: T | null; error: unknown; loading: boolean }>({ data: null, error: null, loading: true });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    setState((s) => ({ data: s.data, error: null, loading: true }));
    fn().then(
      (data) => { if (alive) setState({ data, error: null, loading: false }); },
      (error: unknown) => { if (alive) setState({ data: null, error, loading: false }); },
    );
    return () => { alive = false; };
  }, [...deps, tick]);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  return { ...state, reload };
}

export function useRoute(): { route: Route; path: string; navigate: (path: string) => void } {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const on = () => setHash(window.location.hash);
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const navigate = useCallback((path: string) => { window.location.hash = path; }, []);
  return { route: parseRoute(hash), path: pathOf(hash), navigate };
}

/**
 * Keeps a number fresh (the unread counter): loads now, then every `everyMs` while the page is visible,
 * and again when the tab becomes visible or the connection returns. Failures (offline) keep the last value.
 */
export function usePolledNumber(load: () => Promise<number>, everyMs: number, enabled: boolean): { value: number; refresh: () => void } {
  const [value, setValue] = useState(0);
  const refresh = useCallback(() => {
    if (!enabled || document.visibilityState !== 'visible') return;
    load().then(setValue, () => undefined);
  }, [enabled, load]);
  useEffect(() => {
    if (!enabled) { setValue(0); return; }
    refresh();
    const timer = window.setInterval(refresh, everyMs);
    const wake = () => refresh();
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('online', wake);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', wake); window.removeEventListener('online', wake); };
  }, [enabled, everyMs, refresh]);
  return { value, refresh };
}
