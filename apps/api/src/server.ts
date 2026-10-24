import http from 'node:http';
import { authenticate } from './auth.ts';
import { AppError } from './ports.ts';
import type { IdentityStore, Logger, PdfRenderer, TokenVerifier } from './ports.ts';
import { handleWork, isWorkPath } from './workRoutes.ts';
import { handleTemplates, isTemplatePath } from './templateRoutes.ts';
import { handleInspections, isInspectionPath } from './inspectionRoutes.ts';
import { handleOrg, isOrgPath } from './orgRoutes.ts';
import { handleUsers, isUsersPath } from './usersRoutes.ts';
import { handleMedia, isMediaPath } from './mediaRoutes.ts';
import { handleNotifications, isNotificationPath } from './notificationRoutes.ts';
import type { BlobStore } from './blobStore.ts';
import { MAX_UPLOAD_BYTES } from '../../../packages/engines/src/media/rules.ts';
import type { Clock, WorkRepo } from './workTypes.ts';

export type ApiDeps = { verifier: TokenVerifier; store: IdentityStore; logger: Logger; work?: WorkRepo; clock?: Clock; pdf?: PdfRenderer; blobs?: BlobStore };

function sendRaw(res: http.ServerResponse, status: number, raw: NonNullable<import('./workRoutes.ts').Out['raw']>): void {
  res.writeHead(status, {
    'content-type': raw.contentType,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...(raw.headers ?? {}),
  });
  res.end(raw.data);
}

const MAX_BODY_BYTES = 1_000_000;

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new AppError(413, 'payload_too_large');
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return undefined;
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new AppError(400, 'invalid_json'); }
}

/** Reads a binary body (an upload) with a hard size limit; refuses early when the declared length is already too big. */
async function readBytes(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > limit) throw new AppError(413, 'payload_too_large');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new AppError(413, 'payload_too_large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

export const defaultClock: Clock = {
  now: () => new Date(),
  // Date in the organization's timezone (Africa/Cairo until per-organization timezone settings exist).
  today: () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo' }).format(new Date()),
};

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}

export function createApi(deps: ApiDeps): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');

      if (req.method === 'GET' && url.pathname === '/health') {
        return send(res, 200, { ok: true });
      }

      if (req.method === 'GET' && url.pathname === '/auth/session') {
        const ctx = await authenticate(req.headers, deps);
        return send(res, 200, {
          user: ctx.user,
          orgId: ctx.orgId,
          grants: ctx.subject.grants,
          siteIds: ctx.subject.siteIds,
        });
      }

      if (deps.work && (isWorkPath(url.pathname) || isTemplatePath(url.pathname) || isInspectionPath(url.pathname) || isOrgPath(url.pathname) || isUsersPath(url.pathname) || isMediaPath(url.pathname) || isNotificationPath(url.pathname))) {
        const ctx = await authenticate(req.headers, deps);
        const hasBody = req.method === 'POST' || req.method === 'PATCH' || req.method === 'PUT';
        const isUpload = req.method === 'POST' && url.pathname === '/media';
        const body = hasBody && !isUpload ? await readJson(req) : undefined;
        const raw = isUpload ? await readBytes(req, MAX_UPLOAD_BYTES) : undefined;
        const r = { method: req.method ?? 'GET', path: url.pathname, query: url.searchParams, body, ctx, raw, contentType: req.headers['content-type'] };
        const d = { work: deps.work, clock: deps.clock ?? defaultClock, pdf: deps.pdf, blobs: deps.blobs };
        const out = isWorkPath(url.pathname) ? await handleWork(r, d)
          : isTemplatePath(url.pathname) ? await handleTemplates(r, d)
          : isInspectionPath(url.pathname) ? await handleInspections(r, d)
          : isOrgPath(url.pathname) ? await handleOrg(r, d)
          : isUsersPath(url.pathname) ? await handleUsers(r, d)
          : isMediaPath(url.pathname) ? await handleMedia(r, d)
          : await handleNotifications(r, d);
        if (out) return out.raw ? sendRaw(res, out.status, out.raw) : send(res, out.status, out.body);
      }

      throw new AppError(404, 'not_found');
    } catch (err) {
      if (err instanceof AppError) {
        if (err.status === 413) {
          // an oversized upload: answer, then drop the connection so the rest of the body is not received
          res.setHeader('connection', 'close');
          res.on('finish', () => req.destroy());
        }
        return send(res, err.status, err.details === undefined ? { code: err.code } : { code: err.code, errors: err.details });
      }
      deps.logger.error('unhandled_error', err); // full detail goes to logs only
      return send(res, 500, { code: 'internal' });
    }
  });
}
