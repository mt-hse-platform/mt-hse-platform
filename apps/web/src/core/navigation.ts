import type { Grant, Permission } from '../../../../packages/shared/src/permissions.ts';
import type { MessageKey } from '../../../../packages/i18n/src/index.ts';

export type ModuleId =
  | 'home' | 'inspections' | 'templates' | 'issues' | 'incidents' | 'actions' | 'assets'
  | 'analytics' | 'reports' | 'documents' | 'training' | 'notifications' | 'library' | 'users' | 'settings';

export type NavItem = { id: ModuleId; path: string; labelKey: MessageKey; permission?: Permission };

export const NAV_ITEMS: NavItem[] = [
  { id: 'home', path: '/', labelKey: 'nav.home' },
  { id: 'inspections', path: '/inspections', labelKey: 'nav.inspections', permission: 'inspection.read' },
  { id: 'templates', path: '/templates', labelKey: 'nav.templates', permission: 'template.read' },
  { id: 'issues', path: '/issues', labelKey: 'nav.issues', permission: 'issue.read' },
  { id: 'incidents', path: '/incidents', labelKey: 'nav.incidents', permission: 'incident.read' },
  { id: 'actions', path: '/actions', labelKey: 'nav.actions', permission: 'action.read' },
  { id: 'assets', path: '/assets', labelKey: 'nav.assets', permission: 'asset.read' },
  { id: 'analytics', path: '/analytics', labelKey: 'nav.analytics', permission: 'report.view' },
  { id: 'reports', path: '/reports', labelKey: 'nav.reports', permission: 'report.view' },
  { id: 'documents', path: '/documents', labelKey: 'nav.documents' },
  { id: 'training', path: '/training', labelKey: 'nav.training' },
  { id: 'notifications', path: '/notifications', labelKey: 'nav.notifications' },
  { id: 'library', path: '/library', labelKey: 'nav.library', permission: 'template.read' },
  { id: 'users', path: '/users', labelKey: 'nav.users', permission: 'user.manage' },
  { id: 'settings', path: '/settings', labelKey: 'nav.settings' },
];

/**
 * Only modules that are really implemented are enabled. A menu entry for a module that does not exist yet would be a
 * dummy button, so it stays hidden until the module ships (add its id here in the same change that builds it).
 */
export const ENABLED_MODULES: ReadonlySet<ModuleId> = new Set<ModuleId>(['home', 'inspections', 'actions', 'issues', 'notifications', 'templates', 'users', 'settings']);

const allows = (grants: Grant[], p?: Permission) => !p || grants.some((g) => g.permission === p);

/** UI visibility only. The API enforces permissions independently. */
export function visibleNav(grants: Grant[], enabled: ReadonlySet<ModuleId> = ENABLED_MODULES): NavItem[] {
  return NAV_ITEMS.filter((i) => enabled.has(i.id) && allows(grants, i.permission));
}

const MOBILE_PRIMARY: ModuleId[] = ['home', 'inspections', 'actions', 'issues'];

export function mobileNav(items: NavItem[]): { primary: NavItem[]; more: NavItem[] } {
  const primary = MOBILE_PRIMARY.map((id) => items.find((i) => i.id === id)).filter((x): x is NavItem => !!x);
  const more = items.filter((i) => !primary.includes(i));
  if (more.length === 1) return { primary: [...primary, more[0]!], more: [] }; // a "More" menu with one entry is pointless
  return { primary, more };
}

export type QuickAction = { id: string; labelKey: MessageKey; permission: Permission; module: ModuleId; path: string };

export const QUICK_ACTIONS: QuickAction[] = [
  { id: 'start_inspection', labelKey: 'quick.start_inspection', permission: 'inspection.create', module: 'inspections', path: '/inspections/new' },
  { id: 'report_hazard', labelKey: 'quick.report_hazard', permission: 'issue.create', module: 'issues', path: '/issues/new?type=hazard' },
  { id: 'report_observation', labelKey: 'quick.report_observation', permission: 'issue.create', module: 'issues', path: '/issues/new?type=observation' },
  { id: 'report_near_miss', labelKey: 'quick.report_near_miss', permission: 'issue.create', module: 'issues', path: '/issues/new?type=near_miss' },
  { id: 'report_incident', labelKey: 'quick.report_incident', permission: 'incident.create', module: 'incidents', path: '/incidents/new' },
  { id: 'create_issue', labelKey: 'quick.create_issue', permission: 'issue.create', module: 'issues', path: '/issues/new' },
  { id: 'create_action', labelKey: 'quick.create_action', permission: 'action.create', module: 'actions', path: '/actions/new' },
  { id: 'add_asset', labelKey: 'quick.add_asset', permission: 'asset.create', module: 'assets', path: '/assets/new' },
];

export function visibleQuickActions(grants: Grant[], enabled: ReadonlySet<ModuleId> = ENABLED_MODULES): QuickAction[] {
  return QUICK_ACTIONS.filter((a) => enabled.has(a.module) && allows(grants, a.permission));
}
