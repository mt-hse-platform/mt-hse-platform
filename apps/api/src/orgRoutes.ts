// Organization structure endpoints used by the UI pickers. Sites are readable by every member of the organization
// (names only); creating sites needs settings.manage.
import { AppError } from './ports.ts';
import { asObject, fail, txCtx } from './workRoutes.ts';
import type { Out, WorkDeps, WorkRequest } from './workRoutes.ts';
import { decide, hasPermission, listFilter } from '../../../packages/engines/src/permission.ts';

export const isOrgPath = (path: string) => /^\/(sites|people|dashboard)(\/|$)/.test(path);

export async function handleOrg(req: WorkRequest, deps: WorkDeps): Promise<Out | null> {
  const segs = req.path.split('/').filter(Boolean);
  const { ctx } = req;

  // Active members' names for assignment pickers: only for people who can assign or manage.
  if (segs[0] === 'people' && segs.length === 1 && req.method === 'GET') {
    const may = (['action.assign', 'issue.edit', 'user.manage'] as const).some((p) => hasPermission(ctx.subject, p));
    if (!may) throw new AppError(403, 'forbidden');
    return deps.work.transaction(txCtx(ctx), async (tx) => ({
      status: 200,
      body: { items: (await tx.listMembers()).filter((m) => m.status === 'active').map((m) => ({ userId: m.userId, fullName: m.fullName })) },
    }));
  }

  // Counters for the home screen, limited to what the caller may read.
  if (segs[0] === 'dashboard' && segs.length === 1 && req.method === 'GET') {
    const today = deps.clock.today();
    return deps.work.transaction(txCtx(ctx), async (tx) => {
      const count = async (kind: 'issues' | 'actions' | 'inspections', perm: 'issue.read' | 'action.read' | 'inspection.read') => {
        const f = listFilter(ctx.subject, perm);
        return f ? tx.statusCounts(kind, f, today, ctx.user.id) : null;
      };
      return { status: 200, body: { issues: await count('issues', 'issue.read'), actions: await count('actions', 'action.read'), inspections: await count('inspections', 'inspection.read'), today } };
    });
  }

  if (segs[0] !== 'sites') return null;

  if (segs.length === 1 && req.method === 'GET') {
    return deps.work.transaction(txCtx(ctx), async (tx) => ({ status: 200, body: { items: await tx.listSites() } }));
  }
  if (segs.length === 1 && req.method === 'POST') {
    if (!decide(ctx.subject, 'settings.manage', { orgId: ctx.orgId }).allowed) throw new AppError(403, 'forbidden');
    const b = asObject(req.body);
    for (const k of Object.keys(b)) if (k !== 'name') throw fail(k, 'unknown_field');
    const name = typeof b.name === 'string' ? b.name.trim() : '';
    if (name.length < 2) throw fail('name', name ? 'min_length' : 'required');
    if (name.length > 200) throw fail('name', 'max_length');
    return deps.work.transaction(txCtx(ctx), async (tx) => ({ status: 201, body: { site: await tx.insertSite(name) } }));
  }
  return null;
}
