// UNTESTED in the authoring sandbox (needs the pg package and PostgreSQL with migration 0001 applied).
import pg from 'pg';
import type { Grant } from '../../../packages/shared/src/permissions.ts';
import type { IdentityStore, MembershipRecord, UserProfile } from './ports.ts';

export class PgIdentityStore implements IdentityStore {
  private pool: pg.Pool;

  constructor(pool: pg.Pool) {
    this.pool = pool;
  }

  /** Runs `fn` in a transaction with the RLS context set (parameterized set_config, local to the transaction). */
  private async inOrgContext<T>(orgId: string, userId: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.org_id', $1, true), set_config('app.user_id', $2, true)", [orgId, userId]);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async resolveByFirebaseUid(uid: string): Promise<MembershipRecord[]> {
    // SECURITY DEFINER function: runs before the org context is known.
    const { rows } = await this.pool.query(
      'SELECT user_id, org_id, membership_id, role_id, user_active, membership_active FROM resolve_membership($1)',
      [uid],
    );
    return rows.map((r) => ({
      userId: r.user_id, orgId: r.org_id, membershipId: r.membership_id, roleId: r.role_id,
      userActive: r.user_active, membershipActive: r.membership_active,
    }));
  }

  async claimInvitations(firebaseUid: string, email: string): Promise<number> {
    const { rows } = await this.pool.query('SELECT claim_invitations($1, $2) AS n', [firebaseUid, email]);
    return Number(rows[0]?.n ?? 0);
  }

  loadUser(m: MembershipRecord): Promise<UserProfile> {
    return this.inOrgContext(m.orgId, m.userId, async (c) => {
      const { rows } = await c.query('SELECT full_name, email, locale FROM users WHERE id = $1', [m.userId]);
      const r = rows[0];
      if (!r) throw new Error('user row not visible');
      return { fullName: r.full_name, email: r.email, locale: r.locale };
    });
  }

  loadGrants(m: MembershipRecord): Promise<Grant[]> {
    return this.inOrgContext(m.orgId, m.userId, async (c) => {
      const { rows } = await c.query('SELECT permission, scope FROM role_permissions WHERE role_id = $1', [m.roleId]);
      return rows.map((r) => ({ permission: r.permission, scope: r.scope }));
    });
  }

  loadSiteIds(m: MembershipRecord): Promise<string[]> {
    return this.inOrgContext(m.orgId, m.userId, async (c) => {
      const { rows } = await c.query('SELECT site_id FROM membership_sites WHERE membership_id = $1', [m.membershipId]);
      return rows.map((r) => r.site_id);
    });
  }
}
