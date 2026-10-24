// The signed-in person's notifications: list, unread counter (cheap, polled by the app), mark as read.
// Strictly personal: there is no way to read or change someone else's notifications.
import { AppError } from './ports.ts';
import { CURSOR_RE, asObject, fail, isUuid, txCtx } from './workRoutes.ts';
import type { Out, WorkDeps, WorkRequest } from './workRoutes.ts';

export const isNotificationPath = (path: string) => /^\/notifications(\/|$)/.test(path);

const MAX_IDS = 100;

export async function handleNotifications(req: WorkRequest, deps: WorkDeps): Promise<Out | null> {
  const segs = req.path.split('/').filter(Boolean);
  const m = req.method;

  if (segs.length === 1 && m === 'GET') {
    const unread = req.query.get('unread');
    if (unread !== null && unread !== '0' && unread !== '1') throw fail('unread', 'invalid_option');
    const limit = Number(req.query.get('limit') ?? 25);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw fail('limit', 'invalid_number');
    const cursor = req.query.get('cursor') ?? undefined;
    if (cursor && !CURSOR_RE.test(cursor)) throw fail('cursor', 'invalid_type');
    return deps.work.transaction(txCtx(req.ctx), async (tx) => {
      const rows = await tx.listNotifications({ unreadOnly: unread === '1', limit: limit + 1, cursor });
      const items = rows.slice(0, limit);
      const last = items[items.length - 1];
      return { status: 200, body: { items, nextCursor: rows.length > limit && last ? `${last.createdAt}|${last.id}` : null } };
    });
  }

  if (segs.length === 2 && segs[1] === 'unread-count' && m === 'GET') {
    return deps.work.transaction(txCtx(req.ctx), async (tx) => ({ status: 200, body: { count: await tx.countUnread() } }));
  }

  if (segs.length === 2 && segs[1] === 'read' && m === 'POST') {
    const b = asObject(req.body);
    for (const k of Object.keys(b)) if (!['ids', 'all'].includes(k)) throw fail(k, 'unknown_field');
    const all = b.all === true;
    const ids = b.ids;
    if (!all && !(Array.isArray(ids) && ids.length > 0 && ids.length <= MAX_IDS && ids.every(isUuid))) throw fail('ids', 'invalid_type');
    if (all && ids !== undefined) throw new AppError(422, 'validation', { ids: [{ code: 'invalid_type' }] });
    return deps.work.transaction(txCtx(req.ctx), async (tx) => {
      const changed = await tx.markNotificationsRead(all ? 'all' : (ids as string[]));
      return { status: 200, body: { changed, unread: await tx.countUnread() } };
    });
  }
  return null;
}
