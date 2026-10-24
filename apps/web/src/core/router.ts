// Tiny hash router: the address survives a refresh and the browser's back button works.
export type WorkFilter = 'mine' | 'overdue' | null;

export type Route =
  | { name: 'home' }
  | { name: 'inspections' }
  | { name: 'inspection_new' }
  | { name: 'inspection'; id: string }
  | { name: 'inspection_report'; id: string }
  | { name: 'actions'; filter: WorkFilter }
  | { name: 'action'; id: string }
  | { name: 'action_new' }
  | { name: 'issues'; filter: WorkFilter }
  | { name: 'issue'; id: string }
  | { name: 'issue_new'; type: string | null }
  | { name: 'templates' }
  | { name: 'users' }
  | { name: 'notifications' }
  | { name: 'settings' }
  | { name: 'not_found' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** '#/inspections/abc?x=1' -> '/inspections/abc' (query and trailing slash removed) */
export function pathOf(hash: string): string {
  const raw = hash.replace(/^#/, '').split('?')[0] ?? '';
  const p = raw.startsWith('/') ? raw : `/${raw}`;
  return p.length > 1 ? p.replace(/\/+$/, '') : p;
}

export function queryOf(hash: string): URLSearchParams {
  const i = hash.indexOf('?');
  return new URLSearchParams(i === -1 ? '' : hash.slice(i + 1));
}

export function parseRoute(hash: string): Route {
  const segs = pathOf(hash).split('/').filter(Boolean);
  const query = queryOf(hash);
  if (segs.length === 0) return { name: 'home' };
  const [a, b, c] = segs;
  if (a === 'settings' && segs.length === 1) return { name: 'settings' };
  if (a === 'templates' && segs.length === 1) return { name: 'templates' };
  if (a === 'users' && segs.length === 1) return { name: 'users' };
  if (a === 'notifications' && segs.length === 1) return { name: 'notifications' };
  if (a === 'actions' || a === 'issues') {
    const kind = a === 'actions' ? 'action' : 'issue';
    if (segs.length === 1) {
      const f = query.get('filter');
      const filter: WorkFilter = f === 'mine' || f === 'overdue' ? f : null;
      return a === 'actions' ? { name: 'actions', filter } : { name: 'issues', filter };
    }
    if (b === 'new' && segs.length === 2) return kind === 'action' ? { name: 'action_new' } : { name: 'issue_new', type: query.get('type') };
    if (b && UUID.test(b) && segs.length === 2) return kind === 'action' ? { name: 'action', id: b } : { name: 'issue', id: b };
  }
  if (a === 'inspections') {
    if (segs.length === 1) return { name: 'inspections' };
    if (b === 'new' && segs.length === 2) return { name: 'inspection_new' };
    if (b && UUID.test(b)) {
      if (segs.length === 2) return { name: 'inspection', id: b };
      if (c === 'report' && segs.length === 3) return { name: 'inspection_report', id: b };
    }
  }
  return { name: 'not_found' };
}

export function routePath(r: Route): string {
  switch (r.name) {
    case 'home': return '/';
    case 'inspections': return '/inspections';
    case 'inspection_new': return '/inspections/new';
    case 'inspection': return `/inspections/${r.id}`;
    case 'inspection_report': return `/inspections/${r.id}/report`;
    case 'templates': return '/templates';
    case 'users': return '/users';
    case 'notifications': return '/notifications';
    case 'actions': return r.filter ? `/actions?filter=${r.filter}` : '/actions';
    case 'action': return `/actions/${r.id}`;
    case 'action_new': return '/actions/new';
    case 'issues': return r.filter ? `/issues?filter=${r.filter}` : '/issues';
    case 'issue': return `/issues/${r.id}`;
    case 'issue_new': return r.type ? `/issues/new?type=${encodeURIComponent(r.type)}` : '/issues/new';
    case 'settings': return '/settings';
    case 'not_found': return '/';
  }
}

/** Which menu entry is highlighted: '/' only for home, every other entry for itself and its sub-pages. */
export function isActivePath(current: string, itemPath: string): boolean {
  if (itemPath === '/') return current === '/';
  return current === itemPath || current.startsWith(`${itemPath}/`);
}
