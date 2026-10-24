// User management without handling passwords: invite by e-mail + role + sites; the person signs up and verifies the
// address; the invitation is claimed on first sign-in. Members can be re-assigned, restricted to sites, or deactivated.
// Safety rules: nobody can change their own access, the last active administrator cannot be removed, and the
// super_admin role can never be granted or edited through the API.
import { AppError } from './ports.ts';
import { asObject, fail, isUuid, txCtx } from './workRoutes.ts';
import type { Out, WorkDeps, WorkRequest } from './workRoutes.ts';
import { decide } from '../../../packages/engines/src/permission.ts';
import { diffEntity } from '../../../packages/engines/src/activity.ts';
import type { MemberRow } from './workTypes.ts';

const EMAIL_RE = /^[^\s@'";<>()\\,]+@[^\s@'";<>()\\,]+\.[^\s@'";<>()\\,]{2,}$/;
const ADMIN_KEYS = ['org_admin', 'super_admin'];
const MAX_SITES = 50;

export const isUsersPath = (path: string) => /^\/(users|roles)(\/|$)/.test(path);

function parseSiteIds(v: unknown): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > MAX_SITES || !v.every(isUuid)) throw fail('siteIds', 'invalid_type');
  return [...new Set(v as string[])];
}

export async function handleUsers(req: WorkRequest, deps: WorkDeps): Promise<Out | null> {
  const { ctx } = req;
  const segs = req.path.split('/').filter(Boolean);
  const [root, a, b, c] = segs;
  const m = req.method;
  if (!decide(ctx.subject, 'user.manage', { orgId: ctx.orgId }).allowed) {
    // consistent answer for every route of this module (also for ids that do not exist)
    if (root === 'roles' || root === 'users') throw new AppError(403, 'forbidden');
  }
  const actor = ctx.user.id;

  if (root === 'roles' && segs.length === 1 && m === 'GET') {
    return deps.work.transaction(txCtx(ctx), async (tx) => ({
      status: 200, body: { items: (await tx.listRoles()).filter((r) => r.key !== 'super_admin') },
    }));
  }
  if (root !== 'users') return null;

  if (segs.length === 1 && m === 'GET') {
    return deps.work.transaction(txCtx(ctx), async (tx) => ({
      status: 200, body: { members: await tx.listMembers(), invitations: await tx.listPendingInvitations() },
    }));
  }

  if (a === 'invitations' && segs.length === 2 && m === 'POST') {
    const body = asObject(req.body);
    for (const k of Object.keys(body)) if (!['email', 'fullName', 'roleId', 'siteIds'].includes(k)) throw fail(k, 'unknown_field');
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (!email) throw fail('email', 'required');
    if (email.length > 254 || !EMAIL_RE.test(email)) throw fail('email', 'invalid_type');
    const fullName = typeof body.fullName === 'string' ? body.fullName.trim() : '';
    if (fullName.length < 2) throw fail('fullName', fullName ? 'min_length' : 'required');
    if (fullName.length > 200) throw fail('fullName', 'max_length');
    if (!isUuid(body.roleId)) throw fail('roleId', 'required');
    const siteIds = parseSiteIds(body.siteIds);

    return deps.work.transaction(txCtx(ctx), async (tx) => {
      const role = await tx.getRole(body.roleId as string);
      if (!role || role.key === 'super_admin') throw fail('roleId', 'invalid_reference');
      const sites = new Set((await tx.listSites()).map((s) => s.id));
      if (siteIds.some((s) => !sites.has(s))) throw fail('siteIds', 'invalid_reference');
      const used = await tx.emailInUse(email);
      if (used) throw new AppError(409, used === 'member' ? 'already_member' : 'already_invited');
      const invitation = await tx.insertInvitation({ email, fullName, roleId: role.id, siteIds, invitedBy: actor });
      await tx.appendTimeline([{ entityType: 'invitation', entityId: invitation.id, event: 'created', field: null, actorUserId: actor, oldValue: null, newValue: { email, roleId: role.id, siteIds } }]);
      return { status: 201, body: { invitation } };
    });
  }

  if (a === 'invitations' && segs.length === 4 && c === 'revoke' && m === 'POST') {
    if (!isUuid(b)) return null;
    return deps.work.transaction(txCtx(ctx), async (tx) => {
      const revoked = await tx.revokeInvitation(b!);
      if (!revoked) throw new AppError(404, 'not_found');
      await tx.appendTimeline([{ entityType: 'invitation', entityId: b!, event: 'revoked', field: null, actorUserId: actor, oldValue: null, newValue: null }]);
      return { status: 200, body: { invitation: revoked } };
    });
  }

  if (segs.length === 2 && m === 'PATCH' && isUuid(a)) {
    const body = asObject(req.body);
    for (const k of Object.keys(body)) if (!['version', 'roleId', 'status', 'siteIds'].includes(k)) throw fail(k, 'unknown_field');
    if (!Number.isInteger(body.version)) throw fail('version', 'required');
    if (body.status !== undefined && body.status !== 'active' && body.status !== 'inactive') throw fail('status', 'invalid_option');
    if (body.roleId !== undefined && !isUuid(body.roleId)) throw fail('roleId', 'invalid_type');
    const siteIds = body.siteIds === undefined ? undefined : parseSiteIds(body.siteIds);

    return deps.work.transaction(txCtx(ctx), async (tx) => {
      const cur = await tx.getMember(a!);
      if (!cur) throw new AppError(404, 'not_found');
      if (cur.version !== body.version) throw new AppError(409, 'conflict');
      if (cur.userId === actor) throw new AppError(422, 'cannot_modify_self');
      if (cur.roleKey === 'super_admin') throw new AppError(403, 'forbidden');

      let newRole = { id: cur.roleId, key: cur.roleKey, name: cur.roleName };
      if (body.roleId !== undefined && body.roleId !== cur.roleId) {
        const r = await tx.getRole(body.roleId as string);
        if (!r || r.key === 'super_admin') throw fail('roleId', 'invalid_reference');
        newRole = r;
      }
      const newStatus = (body.status as MemberRow['status'] | undefined) ?? cur.status;
      if (siteIds) {
        const known = new Set((await tx.listSites()).map((s) => s.id));
        if (siteIds.some((s) => !known.has(s))) throw fail('siteIds', 'invalid_reference');
      }

      const wasAdmin = cur.status === 'active' && ADMIN_KEYS.includes(cur.roleKey ?? '');
      const willBeAdmin = newStatus === 'active' && ADMIN_KEYS.includes(newRole.key ?? '');
      if (wasAdmin && !willBeAdmin && (await tx.countActiveAdmins(cur.membershipId)) === 0) throw new AppError(422, 'last_admin');

      const roleChanged = newRole.id !== cur.roleId;
      const statusChanged = newStatus !== cur.status;
      const sitesChanged = siteIds !== undefined && JSON.stringify([...siteIds].sort()) !== JSON.stringify([...cur.siteIds].sort());
      if (!roleChanged && !statusChanged && !sitesChanged) return { status: 200, body: { member: cur } };

      if (roleChanged || statusChanged) {
        const ok = await tx.updateMember(cur.membershipId, { roleId: roleChanged ? newRole.id : undefined, status: statusChanged ? newStatus : undefined }, cur.version);
        if (!ok) throw new AppError(409, 'conflict');
      }
      if (sitesChanged) await tx.setMemberSites(cur.membershipId, siteIds!);

      const events = [
        ...diffEntity({ roleId: cur.roleId, status: cur.status }, { roleId: newRole.id, status: newStatus }, ['roleId', 'status']),
        ...(sitesChanged ? [{ event: 'updated' as const, field: 'siteIds', oldValue: cur.siteIds, newValue: siteIds }] : []),
      ];
      await tx.appendTimeline(events.map((e) => ({
        entityType: 'user' as const, entityId: cur.membershipId, event: e.field === 'status' ? (newStatus === 'inactive' ? 'deactivated' : 'reactivated') : e.field === 'roleId' ? 'role_changed' : 'sites_changed',
        field: e.field, actorUserId: actor, oldValue: e.oldValue, newValue: e.newValue,
      })));
      return { status: 200, body: { member: await tx.getMember(cur.membershipId) } };
    });
  }
  return null;
}
