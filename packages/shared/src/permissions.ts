// Single source of truth for permissions and default roles.
// Matrix reference: PHASE-0-ARCHITECTURE (v1 §4, v2 §4).

export const PERMISSIONS = [
  'template.create', 'template.read', 'template.edit', 'template.publish',
  'inspection.create', 'inspection.read', 'inspection.edit', 'inspection.delete', 'inspection.publish',
  'issue.create', 'issue.read', 'issue.edit', 'issue.close',
  'incident.create', 'incident.read', 'incident.investigate',
  'action.create', 'action.read', 'action.assign', 'action.edit', 'action.complete',
  'asset.create', 'asset.read', 'asset.edit', 'asset.delete',
  'report.view', 'report.export',
  'user.manage', 'settings.manage',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/** org: any record in the org · site: records in the user's sites · own: records the user created · assigned: records assigned to the user */
export type Scope = 'org' | 'site' | 'own' | 'assigned';

export type Grant = { permission: Permission; scope: Scope };

export const ROLE_KEYS = [
  'super_admin', 'org_admin', 'hse_manager', 'supervisor', 'inspector', 'employee', 'viewer',
] as const;
export type RoleKey = (typeof ROLE_KEYS)[number];

const g = (scope: Scope, ...permissions: Permission[]): Grant[] =>
  permissions.map((permission) => ({ permission, scope }));

const ALL_ORG: Grant[] = g('org', ...PERMISSIONS);

const HSE_MANAGER: Grant[] = g(
  'org',
  'template.create', 'template.read', 'template.edit', 'template.publish',
  'inspection.create', 'inspection.read', 'inspection.edit', 'inspection.delete', 'inspection.publish',
  'issue.create', 'issue.read', 'issue.edit', 'issue.close',
  'incident.create', 'incident.read', 'incident.investigate',
  'action.create', 'action.read', 'action.assign', 'action.edit', 'action.complete',
  'asset.create', 'asset.read', 'asset.edit',
  'report.view', 'report.export',
);

export const DEFAULT_ROLE_GRANTS: Record<RoleKey, Grant[]> = {
  // Platform-level differences of super_admin (cross-org) are a later concern; inside one org it equals org_admin.
  super_admin: ALL_ORG,
  org_admin: ALL_ORG,
  hse_manager: HSE_MANAGER,
  supervisor: [
    ...g('org', 'template.read', 'issue.create', 'incident.create', 'action.create'),
    ...g('site',
      'inspection.create', 'inspection.read', 'inspection.edit',
      'issue.read', 'issue.edit', 'issue.close',
      'incident.read', 'incident.investigate',
      'action.read', 'action.assign', 'action.edit', 'action.complete',
      'asset.read', 'report.view'),
  ],
  inspector: [
    ...g('org', 'template.read', 'inspection.create', 'issue.create', 'incident.create', 'action.create'),
    ...g('own', 'inspection.read', 'inspection.edit', 'issue.edit', 'issue.close', 'action.read', 'action.edit', 'report.view'),
    ...g('site', 'issue.read', 'incident.read', 'asset.read'),
    ...g('assigned', 'action.read', 'action.complete'),
  ],
  employee: [
    ...g('org', 'issue.create', 'incident.create'),
    ...g('own', 'issue.read', 'incident.read'),
    ...g('site', 'asset.read'),
    ...g('assigned', 'action.read', 'action.complete'),
  ],
  viewer: [
    ...g('org', 'template.read'),
    ...g('site', 'inspection.read', 'issue.read', 'incident.read', 'action.read', 'asset.read', 'report.view'),
  ],
};
