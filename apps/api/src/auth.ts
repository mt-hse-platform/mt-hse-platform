import { AppError } from './ports.ts';
import type { IdentityStore, MembershipRecord, TokenVerifier, UserProfile } from './ports.ts';
import type { Subject } from '../../../packages/engines/src/permission.ts';

export type AuthContext = {
  subject: Subject;
  orgId: string;
  user: UserProfile & { id: string };
};

type Headers = Record<string, string | string[] | undefined>;

const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

/**
 * Pipeline: Bearer token -> Firebase verification -> membership lookup -> grants + sites.
 * Every failure is an AppError with a stable code; internal details never reach the client.
 */
export async function authenticate(
  headers: Headers,
  deps: { verifier: TokenVerifier; store: IdentityStore },
): Promise<AuthContext> {
  const match = /^Bearer\s+(\S+)$/i.exec(first(headers['authorization']) ?? '');
  if (!match) throw new AppError(401, 'unauthenticated');

  let token;
  try {
    token = await deps.verifier.verify(match[1]!);
  } catch {
    throw new AppError(401, 'unauthenticated');
  }
  const uid = token.uid;

  let records = await deps.store.resolveByFirebaseUid(uid);
  // Valid Firebase account but not provisioned in any organization, or deactivated: no access.
  let usable = records.filter((r) => r.userActive && r.membershipActive);

  // First sign-in of an invited person: the invitation is claimed by the owner of the VERIFIED e-mail address only.
  if (usable.length === 0 && token.email) {
    if (!token.emailVerified) throw new AppError(403, 'email_not_verified');
    const claimed = (await deps.store.claimInvitations?.(uid, token.email)) ?? 0;
    if (claimed > 0) {
      records = await deps.store.resolveByFirebaseUid(uid);
      usable = records.filter((r) => r.userActive && r.membershipActive);
    }
  }
  if (usable.length === 0) throw new AppError(403, 'forbidden');

  const requestedOrg = first(headers['x-org-id']);
  let chosen: MembershipRecord | undefined;
  if (requestedOrg) {
    chosen = usable.find((r) => r.orgId === requestedOrg);
    if (!chosen) throw new AppError(403, 'forbidden');
  } else if (usable.length === 1) {
    chosen = usable[0];
  } else {
    throw new AppError(409, 'org_required');
  }
  if (!chosen) throw new AppError(403, 'forbidden');

  const [profile, grants, siteIds] = await Promise.all([
    deps.store.loadUser(chosen),
    deps.store.loadGrants(chosen),
    deps.store.loadSiteIds(chosen),
  ]);

  return {
    orgId: chosen.orgId,
    user: { id: chosen.userId, ...profile },
    subject: { userId: chosen.userId, orgId: chosen.orgId, active: true, grants, siteIds },
  };
}
