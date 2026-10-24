import type { Grant, Permission } from '../../shared/src/permissions.ts';

export type Subject = {
  userId: string;
  orgId: string;
  active: boolean;
  grants: Grant[];
  siteIds: string[];
};

export type Resource = {
  orgId: string;
  siteId?: string | null;
  ownerId?: string | null;
  assigneeId?: string | null;
};

export type Decision =
  | { allowed: true; scope: Grant['scope'] }
  | { allowed: false; reason: 'inactive' | 'cross_org' | 'no_grant' | 'scope_mismatch' };

/** Enforcement check: may this subject perform `permission` on this specific resource? Deny by default. */
export function decide(subject: Subject, permission: Permission, resource: Resource): Decision {
  if (!subject.active) return { allowed: false, reason: 'inactive' };
  if (resource.orgId !== subject.orgId) return { allowed: false, reason: 'cross_org' };

  const grants = subject.grants.filter((x) => x.permission === permission);
  if (grants.length === 0) return { allowed: false, reason: 'no_grant' };

  for (const grant of grants) {
    switch (grant.scope) {
      case 'org':
        return { allowed: true, scope: 'org' };
      case 'site':
        if (resource.siteId && subject.siteIds.includes(resource.siteId)) return { allowed: true, scope: 'site' };
        break;
      case 'own':
        if (resource.ownerId && resource.ownerId === subject.userId) return { allowed: true, scope: 'own' };
        break;
      case 'assigned':
        if (resource.assigneeId && resource.assigneeId === subject.userId) return { allowed: true, scope: 'assigned' };
        break;
    }
  }
  return { allowed: false, reason: 'scope_mismatch' };
}

/** UI helper only (show/hide). Never use as enforcement. */
export function hasPermission(subject: Subject, permission: Permission): boolean {
  return subject.active && subject.grants.some((x) => x.permission === permission);
}

export type ListFilter = {
  orgWide: boolean;
  siteIds: string[];
  ownerId?: string;
  assigneeId?: string;
};

/** Describes which rows a list query may return (conditions are OR-combined). null = nothing allowed. */
export function listFilter(subject: Subject, permission: Permission): ListFilter | null {
  if (!subject.active) return null;
  const grants = subject.grants.filter((x) => x.permission === permission);
  if (grants.length === 0) return null;
  if (grants.some((x) => x.scope === 'org')) return { orgWide: true, siteIds: [] };
  const filter: ListFilter = { orgWide: false, siteIds: [] };
  if (grants.some((x) => x.scope === 'site')) filter.siteIds = [...subject.siteIds];
  if (grants.some((x) => x.scope === 'own')) filter.ownerId = subject.userId;
  if (grants.some((x) => x.scope === 'assigned')) filter.assigneeId = subject.userId;
  return filter;
}
