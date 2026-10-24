// Thin fetch wrapper: adds auth headers, turns every failure into a typed error with a stable `code`
// (so i18n's userMessageKey() can map it to a safe message). Never exposes raw response text.

export class ApiError extends Error {
  status: number;
  code: string;
  /** the `errors` object of the response (field errors, or `{ current }` for an edit conflict) */
  details?: unknown;
  constructor(status: number, code: string, details?: unknown) {
    super(code);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class NetworkError extends Error {
  code = 'network';
  constructor() {
    super('network');
  }
}

export type ApiClientOptions = {
  baseUrl: string;
  getToken: () => Promise<string>;
  getOrgId?: () => string | undefined;
  fetchFn?: typeof fetch;
};

export function createApiClient(opts: ApiClientOptions) {
  const doFetch = opts.fetchFn ?? fetch;

  async function request<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const token = await opts.getToken();
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    const orgId = opts.getOrgId?.();
    if (orgId) headers['x-org-id'] = orgId;
    if (init.body !== undefined) headers['content-type'] = 'application/json';

    let res: Response;
    try {
      res = await doFetch(`${opts.baseUrl}${path}`, {
        method: init.method ?? 'GET',
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      });
    } catch {
      throw new NetworkError();
    }

    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      /* non-JSON body: ignore */
    }
    if (!res.ok) {
      const b = body as { code?: unknown; errors?: unknown } | null;
      const code = typeof b?.code === 'string' ? b.code : 'unknown';
      throw new ApiError(res.status, code, b?.errors);
    }
    return body as T;
  }

  return { request };
}

/**
 * Wraps Firebase's getIdToken(): when the token must be refreshed but the device is offline, Firebase throws
 * `auth/network-request-failed`. We turn that into NetworkError so the app falls back to the offline session
 * instead of treating it as an unknown failure.
 */
export function wrapTokenGetter(getIdToken: () => Promise<string>): () => Promise<string> {
  return async () => {
    try {
      return await getIdToken();
    } catch (err) {
      if ((err as { code?: unknown } | null)?.code === 'auth/network-request-failed') throw new NetworkError();
      throw err;
    }
  };
}
