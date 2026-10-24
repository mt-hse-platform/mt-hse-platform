// Generates the SQL that onboards a new customer organization:
// organization + 7 system roles with their grants + the first admin (linked to an existing Firebase account).
// Pure function (no DB access) so it can be unit-tested. Run the output as the DB owner (e.g. `postgres`), not app_user.
import { DEFAULT_ROLE_GRANTS, ROLE_KEYS } from '../packages/shared/src/permissions.ts';
import type { RoleKey } from '../packages/shared/src/permissions.ts';

export type BootstrapInput = {
  orgName: string;
  adminEmail: string;
  adminFullName: string;
  firebaseUid: string;
  locale?: 'ar' | 'en';
};

const ROLE_NAMES: Record<RoleKey, string> = {
  super_admin: 'Super Admin',
  org_admin: 'Organization Admin',
  hse_manager: 'HSE Manager',
  supervisor: 'Supervisor',
  inspector: 'Inspector',
  employee: 'Employee',
  viewer: 'Viewer',
};

/** Standard SQL string literal: single quotes doubled. Rejects control characters (incl. NUL). */
export function sqlLiteral(value: string): string {
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error('Control characters are not allowed');
  return `'${value.replace(/'/g, "''")}'`;
}

const EMAIL_RE = /^[^\s@'";]+@[^\s@'";]+\.[^\s@'";]+$/;
const UID_RE = /^[A-Za-z0-9_-]{20,128}$/;

export function buildBootstrapSql(input: BootstrapInput): string {
  const orgName = input.orgName.trim();
  const fullName = input.adminFullName.trim();
  const email = input.adminEmail.trim().toLowerCase();
  const locale = input.locale ?? 'ar';

  if (orgName.length < 2 || orgName.length > 200) throw new Error('Organization name must be 2-200 characters');
  if (fullName.length < 2 || fullName.length > 200) throw new Error('Admin full name must be 2-200 characters');
  if (!EMAIL_RE.test(email)) throw new Error('Invalid admin email');
  if (!UID_RE.test(input.firebaseUid)) throw new Error('Invalid Firebase UID (copy the "User UID" from Firebase Authentication > Users)');
  if (locale !== 'ar' && locale !== 'en') throw new Error('Invalid locale');

  const roleBlocks = ROLE_KEYS.map((key) => {
    const rows = DEFAULT_ROLE_GRANTS[key]
      .map((g) => `(v_role, v_org, ${sqlLiteral(g.permission)}, ${sqlLiteral(g.scope)})`)
      .join(',\n      ');
    return [
      `  INSERT INTO roles (org_id, key, name, is_system) VALUES (v_org, ${sqlLiteral(key)}, ${sqlLiteral(ROLE_NAMES[key])}, true) RETURNING id INTO v_role;`,
      key === 'org_admin' ? '  v_admin_role := v_role;' : '',
      `  INSERT INTO role_permissions (role_id, org_id, permission, scope) VALUES\n      ${rows};`,
    ].filter(Boolean).join('\n');
  }).join('\n\n');

  return `-- MT-HSE-Platform bootstrap: ${ROLE_KEYS.length} system roles + first admin for one organization.
-- Run as the database owner. Aborts and rolls back entirely on any error.
BEGIN;
DO $bootstrap$
DECLARE
  v_org uuid;
  v_user uuid;
  v_role uuid;
  v_admin_role uuid;
BEGIN
  INSERT INTO organizations (name, locale) VALUES (${sqlLiteral(orgName)}, ${sqlLiteral(locale)}) RETURNING id INTO v_org;

${roleBlocks}

  INSERT INTO users (firebase_uid, email, full_name, locale)
  VALUES (${sqlLiteral(input.firebaseUid)}, ${sqlLiteral(email)}, ${sqlLiteral(fullName)}, ${sqlLiteral(locale)})
  ON CONFLICT (firebase_uid) DO UPDATE SET updated_at = now()
  RETURNING id INTO v_user;

  INSERT INTO memberships (org_id, user_id, role_id) VALUES (v_org, v_user, v_admin_role);

  INSERT INTO audit_logs (org_id, actor_user_id, entity_type, entity_id, action, new_value)
  VALUES (v_org, v_user, 'organization', v_org::text, 'bootstrapped',
          jsonb_build_object('admin_email', ${sqlLiteral(email)}));

  RAISE NOTICE 'Organization created: % (admin user: %)', v_org, v_user;
END
$bootstrap$;
COMMIT;
`;
}
