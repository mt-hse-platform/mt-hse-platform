// In-memory WorkRepo used by tests (and handy for local experiments). Simulates organization isolation like RLS:
// a transaction can only see rows of its own org. Not atomic across failures (no rollback) — tests don't need it.
import { randomUUID } from 'node:crypto';
import { AppError } from './ports.ts';
import type {
  ActionRow, CommentRow, CountKind, FlagRow, InspectionRow, InvitationRow, IssueRow, ListQuery, MediaRow, MemberRow, NotificationRow, SignatureRow, StatusCounts, ResponseRow, RoleRow, TemplateRow, TemplateVersionRow, TimelineEvent, TimelineRow, WorkRepo, WorkTx,
} from './workTypes.ts';

export class MemoryWorkRepo implements WorkRepo {
  members = new Set<string>(); // `${orgId}:${userId}`
  issues: IssueRow[] = [];
  actions: ActionRow[] = [];
  comments: CommentRow[] = [];
  templates: TemplateRow[] = [];
  inspections: InspectionRow[] = [];
  responses: (ResponseRow & { orgId: string })[] = [];
  flags: FlagRow[] = [];
  sites: { id: string; orgId: string; name: string }[] = [];
  media: (MediaRow & { deletedAt?: string })[] = [];
  signatures: (SignatureRow & { orgId: string })[] = [];
  notifications: (NotificationRow & { orgId: string; userId: string; dedupeKey?: string })[] = [];
  roles: (RoleRow & { orgId: string })[] = [];
  memberRows: (MemberRow & { orgId: string })[] = [];
  invitations: (InvitationRow & { orgId: string })[] = [];
  orgNames: Record<string, string> = {};
  siteNames: Record<string, string> = {};
  userNames: Record<string, string> = {};
  versions: TemplateVersionRow[] = [];
  timeline: (TimelineRow & { orgId: string })[] = [];
  private seq = 0;
  private tick = 0;

  addMember(orgId: string, userId: string) { this.members.add(`${orgId}:${userId}`); }

  private isActive(orgId: string, userId: string): boolean {
    return this.members.has(`${orgId}:${userId}`) || this.memberRows.some((m) => m.orgId === orgId && m.userId === userId && m.status === 'active');
  }

  async sweepOverdue(today: string): Promise<number> {
    let n = 0;
    const add = (orgId: string, userId: string | null, due: string | null, id: string, title: string, open: boolean, type: 'action_overdue' | 'issue_overdue', entityType: 'action' | 'issue') => {
      if (!open || !userId || !due || due >= today || !this.isActive(orgId, userId)) return;
      const key = `overdue:${id}`;
      if (this.notifications.some((x) => x.orgId === orgId && x.userId === userId && x.dedupeKey === key)) return;
      this.notifications.push({ id: randomUUID(), orgId, userId, type, entityType, entityId: id, actorUserId: null, data: { entityTitle: title, dueDate: due }, createdAt: this.stamp(), readAt: null, dedupeKey: key });
      n++;
    };
    for (const a of this.actions) add(a.orgId, a.assigneeId, a.dueDate, a.id, a.title, ['todo', 'in_progress', 'pending_verification'].includes(a.status), 'action_overdue', 'action');
    for (const i of this.issues) add(i.orgId, i.assigneeId, i.dueDate, i.id, i.title, ['open', 'under_review', 'assigned', 'in_progress'].includes(i.status), 'issue_overdue', 'issue');
    return n;
  }

  private stamp(): string { return new Date(Date.UTC(2026, 9, 3, 10, 0, this.tick++)).toISOString(); }

  async transaction<T>(ctx: { orgId: string; userId: string }, fn: (tx: WorkTx) => Promise<T>): Promise<T> {
    const org = ctx.orgId;
    const me = ctx.userId;
    const repo = this;

    const visible = <R extends { orgId: string; siteId: string | null; createdAt: string; id: string; status: string }>(
      rows: R[], q: ListQuery, ownerKey: 'reporterId' | 'ownerId', openStatuses: string[] = [],
    ): R[] => {
      const f = q.filter;
      return rows
        .filter((r) => r.orgId === org)
        .filter((r) => !q.status || r.status === q.status)
        .filter((r) => !q.assigneeOnly || (r as any).assigneeId === q.assigneeOnly)
        .filter((r) => !q.overdueBefore || (openStatuses.includes(r.status) && !!(r as any).dueDate && (r as any).dueDate < q.overdueBefore))
        .filter((r) => f.orgWide || (r.siteId && f.siteIds.includes(r.siteId)) ||
          (f.ownerId && (r as any)[ownerKey] === f.ownerId) || (f.assigneeId && (r as any).assigneeId === f.assigneeId))
        .sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1))
        .filter((r) => {
          if (!q.cursor) return true;
          const [at, id] = q.cursor.split('|');
          return r.createdAt < at! || (r.createdAt === at && r.id < id!);
        })
        .slice(0, q.limit);
    };

    const tx: WorkTx = {
      async isActiveMember(userId) {
        return repo.members.has(`${org}:${userId}`) || repo.memberRows.some((m) => m.orgId === org && m.userId === userId && m.status === 'active');
      },

      async insertIssue(row) {
        const now = repo.stamp();
        const r: IssueRow = { ...row, id: randomUUID(), orgId: org, createdAt: now, updatedAt: now, version: 1 };
        repo.issues.push(r); return { ...r };
      },
      async getIssue(id) { const r = repo.issues.find((x) => x.id === id && x.orgId === org); return r ? { ...r } : null; },
      async updateIssue(id, patch, expected) {
        const r = repo.issues.find((x) => x.id === id && x.orgId === org);
        if (!r || r.version !== expected) return null;
        Object.assign(r, patch, { version: r.version + 1, updatedAt: repo.stamp() });
        return { ...r };
      },
      async listIssues(q) { return visible(repo.issues, q, 'reporterId', ['open', 'under_review', 'assigned', 'in_progress']).map((r) => ({ ...r })); },

      async insertAction(row) {
        const now = repo.stamp();
        const r: ActionRow = { ...row, id: randomUUID(), orgId: org, createdAt: now, updatedAt: now, version: 1 };
        repo.actions.push(r); return { ...r };
      },
      async getAction(id) { const r = repo.actions.find((x) => x.id === id && x.orgId === org); return r ? { ...r } : null; },
      async updateAction(id, patch, expected) {
        const r = repo.actions.find((x) => x.id === id && x.orgId === org);
        if (!r || r.version !== expected) return null;
        Object.assign(r, patch, { version: r.version + 1, updatedAt: repo.stamp() });
        return { ...r };
      },
      async listActions(q) { return visible(repo.actions, q, 'ownerId', ['todo', 'in_progress', 'pending_verification']).map((r) => ({ ...r })); },

      async insertComment(row) {
        const r: CommentRow = { ...row, id: randomUUID(), orgId: org, createdAt: repo.stamp() };
        repo.comments.push(r); return { ...r };
      },
      async getComment(id) { const r = repo.comments.find((x) => x.id === id && x.orgId === org); return r ? { ...r } : null; },
      async listComments(actionId) { return repo.comments.filter((c) => c.orgId === org && c.actionId === actionId).map((c) => ({ ...c })); },

      async insertTemplate(row) {
        const now = repo.stamp();
        const r: TemplateRow = { ...row, id: randomUUID(), orgId: org, createdAt: now, updatedAt: now, version: 1 };
        repo.templates.push(r); return { ...r };
      },
      async getTemplate(id) { const r = repo.templates.find((x) => x.id === id && x.orgId === org); return r ? { ...r } : null; },
      async updateTemplate(id, patch, expected) {
        const r = repo.templates.find((x) => x.id === id && x.orgId === org);
        if (!r || r.version !== expected) return null;
        Object.assign(r, patch, { version: r.version + 1, updatedAt: repo.stamp() });
        return { ...r };
      },
      async listTemplates(q) {
        return repo.templates
          .filter((t) => t.orgId === org)
          .filter((t) => !q.status || t.status === q.status)
          .filter((t) => !q.onlyPublished || (t.status === 'published' && t.publishedVersionId !== null))
          .sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1))
          .filter((t) => {
            if (!q.cursor) return true;
            const [at, id] = q.cursor.split('|');
            return t.createdAt < at! || (t.createdAt === at && t.id < id!);
          })
          .slice(0, q.limit).map((t) => ({ ...t }));
      },
      async insertVersion(row) {
        if (row.status === 'draft' && repo.versions.some((v) => v.orgId === org && v.templateId === row.templateId && v.status === 'draft')) {
          throw new AppError(409, 'conflict'); // unique violation in PostgreSQL
        }
        const now = repo.stamp();
        const r: TemplateVersionRow = { ...row, id: randomUUID(), orgId: org, createdAt: now, updatedAt: now, version: 1, content: JSON.parse(JSON.stringify(row.content)) };
        repo.versions.push(r); return JSON.parse(JSON.stringify(r));
      },
      async getVersion(id) { const r = repo.versions.find((x) => x.id === id && x.orgId === org); return r ? JSON.parse(JSON.stringify(r)) : null; },
      async getDraftVersion(templateId) {
        const r = repo.versions.find((x) => x.orgId === org && x.templateId === templateId && x.status === 'draft');
        return r ? JSON.parse(JSON.stringify(r)) : null;
      },
      async getLatestPublishedVersion(templateId) {
        const r = repo.versions.filter((x) => x.orgId === org && x.templateId === templateId && x.status === 'published').sort((a, b) => b.versionNo - a.versionNo)[0];
        return r ? JSON.parse(JSON.stringify(r)) : null;
      },
      async listVersionSummaries(templateId) {
        return repo.versions.filter((x) => x.orgId === org && x.templateId === templateId).sort((a, b) => b.versionNo - a.versionNo)
          .map(({ content: _c, ...rest }) => ({ ...rest }));
      },
      async updateDraftContent(id, content, expected) {
        const r = repo.versions.find((x) => x.id === id && x.orgId === org);
        if (!r || r.status !== 'draft' || r.version !== expected) return null;
        r.content = JSON.parse(JSON.stringify(content)); r.version += 1; r.updatedAt = repo.stamp();
        return JSON.parse(JSON.stringify(r));
      },
      async markVersionPublished(id, p, expected) {
        const r = repo.versions.find((x) => x.id === id && x.orgId === org);
        if (!r || r.status !== 'draft' || r.version !== expected) return null;
        Object.assign(r, { status: 'published', fingerprint: p.fingerprint, publishedAt: p.publishedAt, publishedBy: p.publishedBy, version: r.version + 1, updatedAt: repo.stamp() });
        return JSON.parse(JSON.stringify(r));
      },

      async insertInspection(row) {
        if (row.id && repo.inspections.some((x) => x.id === row.id)) return null;
        const now = repo.stamp();
        const r: InspectionRow = {
          ...row, orgId: org, id: row.id ?? randomUUID(), status: 'in_progress', startedAt: now, completedAt: null, cancelledAt: null,
          scoreEarned: null, scorePossible: null, scorePct: null, passed: null, flaggedRate: null, createdAt: now, updatedAt: now, version: 1,
        };
        repo.inspections.push(r); return { ...r };
      },
      async getInspection(id) { const r = repo.inspections.find((x) => x.id === id && x.orgId === org); return r ? { ...r } : null; },
      async updateInspection(id, patch, expected) {
        const r = repo.inspections.find((x) => x.id === id && x.orgId === org);
        if (!r || r.version !== expected) return null;
        Object.assign(r, patch, { version: r.version + 1, updatedAt: repo.stamp() });
        return { ...r };
      },
      async listInspections(q) {
        const f = q.filter;
        return repo.inspections
          .filter((r) => r.orgId === org)
          .filter((r) => !q.status || r.status === q.status)
          .filter((r) => f.orgWide || (r.siteId && f.siteIds.includes(r.siteId)) || (f.ownerId && r.startedBy === f.ownerId))
          .sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1))
          .filter((r) => {
            if (!q.cursor) return true;
            const [at, id] = q.cursor.split('|');
            return r.createdAt < at! || (r.createdAt === at && r.id < id!);
          })
          .slice(0, q.limit).map((r) => ({ ...r }));
      },
      async listResponses(inspectionId) {
        return repo.responses.filter((r) => r.orgId === org && r.inspectionId === inspectionId).map(({ orgId: _o, ...r }) => ({ ...r }));
      },
      async upsertResponse(inspectionId, questionId, value, userId, expected) {
        const insp = repo.inspections.find((x) => x.id === inspectionId && x.orgId === org);
        if (!insp || insp.status !== 'in_progress') throw Object.assign(new Error('inspection not open'), { code: '55000' });
        const cur = repo.responses.find((r) => r.orgId === org && r.inspectionId === inspectionId && r.questionId === questionId);
        const strip = ({ orgId: _o, ...r }: ResponseRow & { orgId: string }): ResponseRow => ({ ...r });
        if (!cur) {
          if (expected !== 0) return { ok: false, current: null };
          const row = { orgId: org, inspectionId, questionId, value, updatedBy: userId, updatedAt: repo.stamp(), version: 1 };
          repo.responses.push(row);
          return { ok: true, row: strip(row) };
        }
        if (cur.version !== expected) return { ok: false, current: strip(cur) };
        Object.assign(cur, { value, updatedBy: userId, updatedAt: repo.stamp(), version: cur.version + 1 });
        return { ok: true, row: strip(cur) };
      },
      async insertFlags(inspectionId, flags) {
        const rows = flags.map((f): FlagRow => ({
          ...f, id: randomUUID(), orgId: org, inspectionId, status: 'open', issueId: null, actionId: null, createdAt: repo.stamp(),
        }));
        repo.flags.push(...rows); return rows.map((r) => ({ ...r }));
      },
      async getFlag(id) { const f = repo.flags.find((x) => x.id === id && x.orgId === org); return f ? { ...f } : null; },
      async linkFlag(id, link) {
        const f = repo.flags.find((x) => x.id === id && x.orgId === org);
        if (!f) return null;
        if ('issueId' in link) { if (f.issueId) return null; f.issueId = link.issueId; }
        else { if (f.actionId) return null; f.actionId = link.actionId; }
        return { ...f };
      },
      async listFlags(inspectionId) { return repo.flags.filter((f) => f.orgId === org && f.inspectionId === inspectionId).map((f) => ({ ...f })); },

      async statusCounts(kind: CountKind, filter, today, userId): Promise<StatusCounts> {
        const q: ListQuery = { filter, limit: Number.MAX_SAFE_INTEGER };
        const open = kind === 'issues' ? ['open', 'under_review', 'assigned', 'in_progress'] : kind === 'actions' ? ['todo', 'in_progress', 'pending_verification'] : ['in_progress'];
        const rows: any[] = kind === 'issues' ? visible(repo.issues, q, 'reporterId') : kind === 'actions' ? visible(repo.actions, q, 'ownerId')
          : repo.inspections.filter((r) => r.orgId === org && (filter.orgWide || (r.siteId && filter.siteIds.includes(r.siteId)) || (filter.ownerId && r.startedBy === filter.ownerId)));
        const byStatus: Record<string, number> = {};
        let overdue = 0; let mine = 0;
        for (const r of rows) {
          byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
          if (kind !== 'inspections' && open.includes(r.status) && r.dueDate && r.dueDate < today) overdue++;
          if (open.includes(r.status) && (kind === 'inspections' ? r.startedBy === userId : r.assigneeId === userId)) mine++;
        }
        return { byStatus, overdue, mine };
      },

      async insertNotifications(rows) {
        for (const r of rows) {
          if (r.dedupeKey && repo.notifications.some((x) => x.orgId === org && x.userId === r.userId && x.dedupeKey === r.dedupeKey)) continue;
          repo.notifications.push({ id: randomUUID(), orgId: org, userId: r.userId, type: r.type, entityType: r.entityType, entityId: r.entityId, actorUserId: r.actorUserId, data: r.data, createdAt: repo.stamp(), readAt: null, dedupeKey: r.dedupeKey });
        }
      },
      async listNotifications(q) {
        return repo.notifications
          .filter((n) => n.orgId === org && n.userId === me && (!q.unreadOnly || n.readAt === null))
          .sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1))
          .filter((n) => {
            if (!q.cursor) return true;
            const [at, id] = q.cursor.split('|');
            return n.createdAt < at! || (n.createdAt === at && n.id < id!);
          })
          .slice(0, q.limit).map(({ orgId: _o, userId: _u, dedupeKey: _d, ...n }) => ({ ...n }));
      },
      async countUnread() { return repo.notifications.filter((n) => n.orgId === org && n.userId === me && n.readAt === null).length; },
      async markNotificationsRead(ids) {
        let n = 0;
        for (const x of repo.notifications) {
          if (x.orgId === org && x.userId === me && x.readAt === null && (ids === 'all' || ids.includes(x.id))) { x.readAt = repo.stamp(); n++; }
        }
        return n;
      },

      async insertMedia(row) {
        const r = { ...row, orgId: org, createdAt: repo.stamp() };
        repo.media.push(r); return { ...r };
      },
      async getMedia(id) { const m = repo.media.find((x) => x.id === id && x.orgId === org && !x.deletedAt); return m ? { ...m } : null; },
      async getMediaMany(ids) { return repo.media.filter((x) => x.orgId === org && !x.deletedAt && ids.includes(x.id)).map((m) => ({ ...m })); },
      async listMedia(ownerType, ownerId, questionId) {
        return repo.media.filter((x) => x.orgId === org && !x.deletedAt && x.ownerType === ownerType && x.ownerId === ownerId && (questionId === undefined || x.questionId === questionId)).map((m) => ({ ...m }));
      },
      async countMedia(ownerType, ownerId, questionId, kind) {
        return repo.media.filter((x) => x.orgId === org && !x.deletedAt && x.ownerType === ownerType && x.ownerId === ownerId && x.questionId === questionId && x.kind === kind).length;
      },
      async softDeleteMedia(id) {
        const m = repo.media.find((x) => x.id === id && x.orgId === org && !x.deletedAt);
        if (!m) return false;
        m.deletedAt = repo.stamp(); return true;
      },
      async insertSignature(row) {
        if (repo.signatures.some((s) => s.orgId === org && s.mediaId === row.mediaId)) throw new AppError(409, 'conflict');
        const r = { ...row, id: randomUUID(), orgId: org, signedAt: repo.stamp() };
        repo.signatures.push(r);
        const { orgId: _o, ...out } = r; return { ...out };
      },
      async listSignatures(inspectionId) { return repo.signatures.filter((s) => s.orgId === org && s.inspectionId === inspectionId).map(({ orgId: _o, ...s }) => ({ ...s })); },

      async listRoles() { return repo.roles.filter((r) => r.orgId === org).map(({ orgId: _o, ...r }) => ({ ...r })); },
      async getRole(id) { const r = repo.roles.find((x) => x.id === id && x.orgId === org); return r ? { id: r.id, key: r.key, name: r.name } : null; },
      async listMembers() { return repo.memberRows.filter((m) => m.orgId === org).map(({ orgId: _o, ...m }) => ({ ...m, siteIds: [...m.siteIds] })); },
      async getMember(id) {
        const m = repo.memberRows.find((x) => x.membershipId === id && x.orgId === org);
        if (!m) return null;
        const { orgId: _o, ...rest } = m; return { ...rest, siteIds: [...m.siteIds] };
      },
      async updateMember(id, patch, expected) {
        const m = repo.memberRows.find((x) => x.membershipId === id && x.orgId === org);
        if (!m || m.version !== expected) return false;
        if (patch.roleId) { const r = repo.roles.find((x) => x.id === patch.roleId && x.orgId === org)!; m.roleId = r.id; m.roleKey = r.key; m.roleName = r.name; }
        if (patch.status) m.status = patch.status;
        m.version += 1; return true;
      },
      async setMemberSites(id, siteIds) { const m = repo.memberRows.find((x) => x.membershipId === id && x.orgId === org); if (m) m.siteIds = [...siteIds]; },
      async countActiveAdmins(exclude) {
        return repo.memberRows.filter((m) => m.orgId === org && m.status === 'active' && m.membershipId !== exclude && (m.roleKey === 'org_admin' || m.roleKey === 'super_admin')).length;
      },
      async emailInUse(email) {
        if (repo.memberRows.some((m) => m.orgId === org && m.email === email)) return 'member';
        if (repo.invitations.some((i) => i.orgId === org && i.email === email && i.status === 'pending')) return 'invited';
        return null;
      },
      async insertInvitation(row) {
        const role = repo.roles.find((r) => r.id === row.roleId && r.orgId === org)!;
        const created = repo.stamp();
        const inv = {
          id: randomUUID(), orgId: org, email: row.email, fullName: row.fullName, roleId: row.roleId, roleName: role.name, siteIds: [...row.siteIds],
          status: 'pending' as const, invitedBy: row.invitedBy, createdAt: created, expiresAt: new Date(Date.parse(created) + 14 * 86_400_000).toISOString(), version: 1,
        };
        repo.invitations.push(inv);
        const { orgId: _o, ...out } = inv; return { ...out };
      },
      async listPendingInvitations() { return repo.invitations.filter((i) => i.orgId === org && i.status === 'pending').map(({ orgId: _o, ...i }) => ({ ...i })); },
      async getInvitation(id) { const i = repo.invitations.find((x) => x.id === id && x.orgId === org); if (!i) return null; const { orgId: _o, ...out } = i; return { ...out }; },
      async revokeInvitation(id) {
        const i = repo.invitations.find((x) => x.id === id && x.orgId === org && x.status === 'pending');
        if (!i) return null;
        i.status = 'revoked'; i.version += 1; const { orgId: _o, ...out } = i; return { ...out };
      },

      async listSites() { return repo.sites.filter((x) => x.orgId === org).map(({ id, name }) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)); },
      async insertSite(name) {
        if (repo.sites.some((x) => x.orgId === org && x.name === name)) throw new AppError(409, 'conflict'); // same outcome as the PostgreSQL adapter (unique violation)
        const row = { id: randomUUID(), orgId: org, name };
        repo.sites.push(row); repo.siteNames[row.id] = name;
        return { id: row.id, name };
      },
      async getOrgName() { return repo.orgNames[org] ?? 'Organization'; },
      async getSiteName(id) { return repo.siteNames[id] ?? null; },
      async getUserNames(ids) { return Object.fromEntries(ids.map((id) => [id, repo.userNames[id] ?? `User ${id.slice(-4)}`])); },
      async listActionsByInspection(iid) { return repo.actions.filter((a) => a.orgId === org && a.inspectionId === iid).map((a) => ({ ...a })); },
      async listIssuesByInspection(iid) { return repo.issues.filter((a) => a.orgId === org && a.inspectionId === iid).map((a) => ({ ...a })); },

      async appendTimeline(events: TimelineEvent[]) {
        for (const e of events) repo.timeline.push({ ...e, orgId: org, id: ++repo.seq, at: repo.stamp() });
      },
      async listTimeline(entityType, entityId) {
        return repo.timeline.filter((t) => t.orgId === org && t.entityType === entityType && t.entityId === entityId).map(({ orgId: _o, ...t }) => t);
      },
    };
    return fn(tx);
  }
}
