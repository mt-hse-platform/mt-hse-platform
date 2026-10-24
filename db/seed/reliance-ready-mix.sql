-- MT-HSE-Platform bootstrap: 7 system roles + first admin for one organization.
-- Run as the database owner. Aborts and rolls back entirely on any error.
BEGIN;
DO $bootstrap$
DECLARE
  v_org uuid;
  v_user uuid;
  v_role uuid;
  v_admin_role uuid;
BEGIN
  INSERT INTO organizations (name, locale) VALUES ('ريلاينس ريدى ميكس', 'ar') RETURNING id INTO v_org;

  INSERT INTO roles (org_id, key, name, is_system) VALUES (v_org, 'super_admin', 'Super Admin', true) RETURNING id INTO v_role;
  INSERT INTO role_permissions (role_id, org_id, permission, scope) VALUES
      (v_role, v_org, 'template.create', 'org'),
      (v_role, v_org, 'template.read', 'org'),
      (v_role, v_org, 'template.edit', 'org'),
      (v_role, v_org, 'template.publish', 'org'),
      (v_role, v_org, 'inspection.create', 'org'),
      (v_role, v_org, 'inspection.read', 'org'),
      (v_role, v_org, 'inspection.edit', 'org'),
      (v_role, v_org, 'inspection.delete', 'org'),
      (v_role, v_org, 'inspection.publish', 'org'),
      (v_role, v_org, 'issue.create', 'org'),
      (v_role, v_org, 'issue.read', 'org'),
      (v_role, v_org, 'issue.edit', 'org'),
      (v_role, v_org, 'issue.close', 'org'),
      (v_role, v_org, 'incident.create', 'org'),
      (v_role, v_org, 'incident.read', 'org'),
      (v_role, v_org, 'incident.investigate', 'org'),
      (v_role, v_org, 'action.create', 'org'),
      (v_role, v_org, 'action.read', 'org'),
      (v_role, v_org, 'action.assign', 'org'),
      (v_role, v_org, 'action.edit', 'org'),
      (v_role, v_org, 'action.complete', 'org'),
      (v_role, v_org, 'asset.create', 'org'),
      (v_role, v_org, 'asset.read', 'org'),
      (v_role, v_org, 'asset.edit', 'org'),
      (v_role, v_org, 'asset.delete', 'org'),
      (v_role, v_org, 'report.view', 'org'),
      (v_role, v_org, 'report.export', 'org'),
      (v_role, v_org, 'user.manage', 'org'),
      (v_role, v_org, 'settings.manage', 'org');

  INSERT INTO roles (org_id, key, name, is_system) VALUES (v_org, 'org_admin', 'Organization Admin', true) RETURNING id INTO v_role;
  v_admin_role := v_role;
  INSERT INTO role_permissions (role_id, org_id, permission, scope) VALUES
      (v_role, v_org, 'template.create', 'org'),
      (v_role, v_org, 'template.read', 'org'),
      (v_role, v_org, 'template.edit', 'org'),
      (v_role, v_org, 'template.publish', 'org'),
      (v_role, v_org, 'inspection.create', 'org'),
      (v_role, v_org, 'inspection.read', 'org'),
      (v_role, v_org, 'inspection.edit', 'org'),
      (v_role, v_org, 'inspection.delete', 'org'),
      (v_role, v_org, 'inspection.publish', 'org'),
      (v_role, v_org, 'issue.create', 'org'),
      (v_role, v_org, 'issue.read', 'org'),
      (v_role, v_org, 'issue.edit', 'org'),
      (v_role, v_org, 'issue.close', 'org'),
      (v_role, v_org, 'incident.create', 'org'),
      (v_role, v_org, 'incident.read', 'org'),
      (v_role, v_org, 'incident.investigate', 'org'),
      (v_role, v_org, 'action.create', 'org'),
      (v_role, v_org, 'action.read', 'org'),
      (v_role, v_org, 'action.assign', 'org'),
      (v_role, v_org, 'action.edit', 'org'),
      (v_role, v_org, 'action.complete', 'org'),
      (v_role, v_org, 'asset.create', 'org'),
      (v_role, v_org, 'asset.read', 'org'),
      (v_role, v_org, 'asset.edit', 'org'),
      (v_role, v_org, 'asset.delete', 'org'),
      (v_role, v_org, 'report.view', 'org'),
      (v_role, v_org, 'report.export', 'org'),
      (v_role, v_org, 'user.manage', 'org'),
      (v_role, v_org, 'settings.manage', 'org');

  INSERT INTO roles (org_id, key, name, is_system) VALUES (v_org, 'hse_manager', 'HSE Manager', true) RETURNING id INTO v_role;
  INSERT INTO role_permissions (role_id, org_id, permission, scope) VALUES
      (v_role, v_org, 'template.create', 'org'),
      (v_role, v_org, 'template.read', 'org'),
      (v_role, v_org, 'template.edit', 'org'),
      (v_role, v_org, 'template.publish', 'org'),
      (v_role, v_org, 'inspection.create', 'org'),
      (v_role, v_org, 'inspection.read', 'org'),
      (v_role, v_org, 'inspection.edit', 'org'),
      (v_role, v_org, 'inspection.delete', 'org'),
      (v_role, v_org, 'inspection.publish', 'org'),
      (v_role, v_org, 'issue.create', 'org'),
      (v_role, v_org, 'issue.read', 'org'),
      (v_role, v_org, 'issue.edit', 'org'),
      (v_role, v_org, 'issue.close', 'org'),
      (v_role, v_org, 'incident.create', 'org'),
      (v_role, v_org, 'incident.read', 'org'),
      (v_role, v_org, 'incident.investigate', 'org'),
      (v_role, v_org, 'action.create', 'org'),
      (v_role, v_org, 'action.read', 'org'),
      (v_role, v_org, 'action.assign', 'org'),
      (v_role, v_org, 'action.edit', 'org'),
      (v_role, v_org, 'action.complete', 'org'),
      (v_role, v_org, 'asset.create', 'org'),
      (v_role, v_org, 'asset.read', 'org'),
      (v_role, v_org, 'asset.edit', 'org'),
      (v_role, v_org, 'report.view', 'org'),
      (v_role, v_org, 'report.export', 'org');

  INSERT INTO roles (org_id, key, name, is_system) VALUES (v_org, 'supervisor', 'Supervisor', true) RETURNING id INTO v_role;
  INSERT INTO role_permissions (role_id, org_id, permission, scope) VALUES
      (v_role, v_org, 'template.read', 'org'),
      (v_role, v_org, 'issue.create', 'org'),
      (v_role, v_org, 'incident.create', 'org'),
      (v_role, v_org, 'action.create', 'org'),
      (v_role, v_org, 'inspection.create', 'site'),
      (v_role, v_org, 'inspection.read', 'site'),
      (v_role, v_org, 'inspection.edit', 'site'),
      (v_role, v_org, 'issue.read', 'site'),
      (v_role, v_org, 'issue.edit', 'site'),
      (v_role, v_org, 'issue.close', 'site'),
      (v_role, v_org, 'incident.read', 'site'),
      (v_role, v_org, 'incident.investigate', 'site'),
      (v_role, v_org, 'action.read', 'site'),
      (v_role, v_org, 'action.assign', 'site'),
      (v_role, v_org, 'action.edit', 'site'),
      (v_role, v_org, 'action.complete', 'site'),
      (v_role, v_org, 'asset.read', 'site'),
      (v_role, v_org, 'report.view', 'site');

  INSERT INTO roles (org_id, key, name, is_system) VALUES (v_org, 'inspector', 'Inspector', true) RETURNING id INTO v_role;
  INSERT INTO role_permissions (role_id, org_id, permission, scope) VALUES
      (v_role, v_org, 'template.read', 'org'),
      (v_role, v_org, 'inspection.create', 'org'),
      (v_role, v_org, 'issue.create', 'org'),
      (v_role, v_org, 'incident.create', 'org'),
      (v_role, v_org, 'action.create', 'org'),
      (v_role, v_org, 'inspection.read', 'own'),
      (v_role, v_org, 'inspection.edit', 'own'),
      (v_role, v_org, 'issue.edit', 'own'),
      (v_role, v_org, 'issue.close', 'own'),
      (v_role, v_org, 'action.read', 'own'),
      (v_role, v_org, 'action.edit', 'own'),
      (v_role, v_org, 'report.view', 'own'),
      (v_role, v_org, 'issue.read', 'site'),
      (v_role, v_org, 'incident.read', 'site'),
      (v_role, v_org, 'asset.read', 'site'),
      (v_role, v_org, 'action.read', 'assigned'),
      (v_role, v_org, 'action.complete', 'assigned');

  INSERT INTO roles (org_id, key, name, is_system) VALUES (v_org, 'employee', 'Employee', true) RETURNING id INTO v_role;
  INSERT INTO role_permissions (role_id, org_id, permission, scope) VALUES
      (v_role, v_org, 'issue.create', 'org'),
      (v_role, v_org, 'incident.create', 'org'),
      (v_role, v_org, 'issue.read', 'own'),
      (v_role, v_org, 'incident.read', 'own'),
      (v_role, v_org, 'asset.read', 'site'),
      (v_role, v_org, 'action.read', 'assigned'),
      (v_role, v_org, 'action.complete', 'assigned');

  INSERT INTO roles (org_id, key, name, is_system) VALUES (v_org, 'viewer', 'Viewer', true) RETURNING id INTO v_role;
  INSERT INTO role_permissions (role_id, org_id, permission, scope) VALUES
      (v_role, v_org, 'template.read', 'org'),
      (v_role, v_org, 'inspection.read', 'site'),
      (v_role, v_org, 'issue.read', 'site'),
      (v_role, v_org, 'incident.read', 'site'),
      (v_role, v_org, 'action.read', 'site'),
      (v_role, v_org, 'asset.read', 'site'),
      (v_role, v_org, 'report.view', 'site');

  INSERT INTO users (firebase_uid, email, full_name, locale)
  VALUES ('cP1xDFQvnMV06uPSu6ioh5LGM213', 'mt.hse.platform@gmail.com', 'محمد طاهر', 'ar')
  ON CONFLICT (firebase_uid) DO UPDATE SET updated_at = now()
  RETURNING id INTO v_user;

  INSERT INTO memberships (org_id, user_id, role_id) VALUES (v_org, v_user, v_admin_role);

  INSERT INTO audit_logs (org_id, actor_user_id, entity_type, entity_id, action, new_value)
  VALUES (v_org, v_user, 'organization', v_org::text, 'bootstrapped',
          jsonb_build_object('admin_email', 'mt.hse.platform@gmail.com'));

  RAISE NOTICE 'Organization created: % (admin user: %)', v_org, v_user;
END
$bootstrap$;
COMMIT;
