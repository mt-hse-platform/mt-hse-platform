import type { Grant } from '../../../packages/shared/src/permissions.ts';

/** Error that is safe to show to clients: only a stable code, never internal details. */
export class AppError extends Error {
  status: number;
  code: string;
  details?: unknown;
  constructor(status: number, code: string, details?: unknown) {
    super(code);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export type VerifiedToken = { uid: string; email?: string; emailVerified?: boolean };

/** Verifies a Firebase ID token. Must throw if the token is invalid/expired. */
export interface TokenVerifier {
  verify(idToken: string): Promise<VerifiedToken>;
}

export type MembershipRecord = {
  userId: string;
  orgId: string;
  membershipId: string;
  roleId: string;
  userActive: boolean;
  membershipActive: boolean;
};

export type UserProfile = { fullName: string; email: string; locale: 'ar' | 'en' };

/** Reads identity data. Implementations must run org-scoped reads inside the org context (RLS). */
export interface IdentityStore {
  resolveByFirebaseUid(uid: string): Promise<MembershipRecord[]>;
  loadUser(m: MembershipRecord): Promise<UserProfile>;
  loadGrants(m: MembershipRecord): Promise<Grant[]>;
  loadSiteIds(m: MembershipRecord): Promise<string[]>;
  /**
   * Turns pending invitations for a VERIFIED e-mail into memberships (SECURITY DEFINER function in PostgreSQL).
   * Returns how many were claimed. Optional so simple test doubles need not implement it.
   */
  claimInvitations?(firebaseUid: string, email: string): Promise<number>;
}

export type Logger = { error(message: string, meta?: unknown): void };

/** Turns a self-contained HTML document into a PDF. The production adapter drives headless Chromium. */
export interface PdfRenderer {
  render(html: string, options: { locale: 'ar' | 'en'; footerText: string }): Promise<Buffer>;
}
