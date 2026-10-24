import type { ListFilter } from '../../../packages/engines/src/permission.ts';
import type { ActionStatus, IssueStatus } from '../../../packages/engines/src/workflow.ts';
import type { LocalizedText, TemplateContent } from '../../../packages/engines/src/template/types.ts';
import type { TemplateStatus } from '../../../packages/engines/src/template/versioning.ts';
import type { MediaKind } from '../../../packages/engines/src/media/rules.ts';

export type SourceLink = {
  inspectionId: string | null;
  templateId: string | null;
  templateVersionId: string | null;
  questionId: string | null;
};

export type IssueRow = SourceLink & {
  id: string; orgId: string;
  title: string; description: string | null;
  type: string; priority: string; status: IssueStatus;
  reporterId: string; assigneeId: string | null;
  siteId: string | null; assetId: string | null; dueDate: string | null;
  createdAt: string; updatedAt: string; version: number;
};

export type ActionRow = SourceLink & {
  id: string; orgId: string;
  title: string; description: string | null;
  type: string; priority: string; status: ActionStatus;
  ownerId: string; assigneeId: string | null;
  siteId: string | null; assetId: string | null; dueDate: string | null;
  completedAt: string | null; issueId: string | null;
  createdAt: string; updatedAt: string; version: number;
};

export type CommentRow = {
  id: string; orgId: string; actionId: string; authorId: string; parentId: string | null; body: string; createdAt: string;
};

export type TimelineEvent = {
  entityType: 'issue' | 'action' | 'template' | 'inspection' | 'user' | 'invitation';
  entityId: string;
  event: string;
  field: string | null;
  actorUserId: string;
  oldValue: unknown;
  newValue: unknown;
};
export type TimelineRow = TimelineEvent & { id: number; at: string };

export type TemplateRow = {
  id: string; orgId: string;
  name: LocalizedText; description: LocalizedText | null; category: string | null;
  status: TemplateStatus; publishedVersionId: string | null;
  createdBy: string; createdAt: string; updatedAt: string; version: number;
};
export type TemplateVersionRow = {
  id: string; orgId: string; templateId: string; versionNo: number;
  status: 'draft' | 'published'; content: TemplateContent;
  fingerprint: string | null; publishedAt: string | null; publishedBy: string | null;
  createdBy: string; createdAt: string; updatedAt: string; version: number;
};
export type VersionSummary = Omit<TemplateVersionRow, 'content'>;
export type NewTemplate = Omit<TemplateRow, 'id' | 'createdAt' | 'updatedAt' | 'version'>;
export type NewVersion = Omit<TemplateVersionRow, 'id' | 'createdAt' | 'updatedAt' | 'version'>;
export type TemplateListQuery = { status?: string; onlyPublished: boolean; limit: number; cursor?: string };

export type InspectionStatus = 'in_progress' | 'completed' | 'cancelled' | 'archived';
export type InspectionRow = {
  id: string; orgId: string; templateId: string; templateVersionId: string; title: string | null;
  status: InspectionStatus; startedBy: string; siteId: string | null; assetId: string | null;
  startedAt: string; completedAt: string | null; cancelledAt: string | null;
  scoreEarned: number | null; scorePossible: number | null; scorePct: number | null; passed: boolean | null; flaggedRate: number | null;
  createdAt: string; updatedAt: string; version: number;
};
/** `id` is only given when the client created the inspection offline and chose its id (so a re-sent request is recognised). */
export type NewInspection = Pick<InspectionRow, 'orgId' | 'templateId' | 'templateVersionId' | 'title' | 'startedBy' | 'siteId' | 'assetId'> & { id?: string };
export type ResponseRow = { inspectionId: string; questionId: string; value: unknown; updatedBy: string; updatedAt: string; version: number };
export type FlagRow = {
  id: string; orgId: string; inspectionId: string; questionId: string; pageId: string; sectionId: string | null;
  severity: 'low' | 'medium' | 'high' | 'critical'; descriptions: unknown[]; status: 'open' | 'resolved';
  issueId: string | null; actionId: string | null; createdAt: string;
};
export type NewFlag = Pick<FlagRow, 'questionId' | 'pageId' | 'sectionId' | 'severity' | 'descriptions'>;
export type UpsertResult = { ok: true; row: ResponseRow } | { ok: false; current: ResponseRow | null };

export type RoleRow = { id: string; key: string | null; name: string };
export type MemberRow = {
  membershipId: string; userId: string; fullName: string; email: string;
  roleId: string; roleKey: string | null; roleName: string; status: 'active' | 'inactive';
  siteIds: string[]; version: number; createdAt: string;
};
export type InvitationRow = {
  id: string; email: string; fullName: string; roleId: string; roleName: string; siteIds: string[];
  status: 'pending' | 'accepted' | 'revoked'; invitedBy: string; createdAt: string; expiresAt: string; version: number;
};
export type NewInvitation = { email: string; fullName: string; roleId: string; siteIds: string[]; invitedBy: string };

export type MediaOwner = 'inspection' | 'issue' | 'action';
export type MediaRow = {
  id: string; orgId: string; ownerType: MediaOwner; ownerId: string; questionId: string | null; kind: MediaKind;
  mimeType: string; sizeBytes: number; sha256: string; storageKey: string; caption: string | null; takenAt: string | null;
  lat: number | null; lng: number | null; uploadedBy: string; createdAt: string;
};
export type NewMedia = Omit<MediaRow, 'createdAt'>;
export type SignatureRow = { id: string; inspectionId: string; mediaId: string; signerName: string; signerRole: string | null; signedBy: string; signedAt: string };
export type NewSignature = { inspectionId: string; mediaId: string; signerName: string; signerRole: string | null; signedBy: string };

export type NotificationType = 'action_assigned' | 'issue_assigned' | 'comment_added' | 'action_pending_verification' | 'action_overdue' | 'issue_overdue';
export type NotificationRow = {
  id: string; type: NotificationType; entityType: 'action' | 'issue' | 'inspection'; entityId: string;
  actorUserId: string | null; data: Record<string, unknown>; createdAt: string; readAt: string | null;
};
export type NewNotification = {
  userId: string; type: NotificationType; entityType: 'action' | 'issue' | 'inspection'; entityId: string;
  actorUserId: string | null; data: Record<string, unknown>; dedupeKey?: string;
};

export type NewIssue = Omit<IssueRow, 'id' | 'createdAt' | 'updatedAt' | 'version'>;
export type NewAction = Omit<ActionRow, 'id' | 'createdAt' | 'updatedAt' | 'version'>;
export type ListQuery = {
  filter: ListFilter; status?: string; limit: number; cursor?: string;
  /** only items assigned to this user */
  assigneeOnly?: string;
  /** only items still open whose due date is before this date (YYYY-MM-DD) */
  overdueBefore?: string;
};

export type CountKind = 'issues' | 'actions' | 'inspections';
export type StatusCounts = { byStatus: Record<string, number>; overdue: number; mine: number };

/** All methods run inside one transaction with the organization context (RLS) already set. */
export interface WorkTx {
  isActiveMember(userId: string): Promise<boolean>;

  insertIssue(row: NewIssue): Promise<IssueRow>;
  getIssue(id: string): Promise<IssueRow | null>;
  /** Returns null when `expectedVersion` no longer matches (concurrent edit). */
  updateIssue(id: string, patch: Partial<IssueRow>, expectedVersion: number): Promise<IssueRow | null>;
  listIssues(q: ListQuery): Promise<IssueRow[]>;

  insertAction(row: NewAction): Promise<ActionRow>;
  getAction(id: string): Promise<ActionRow | null>;
  updateAction(id: string, patch: Partial<ActionRow>, expectedVersion: number): Promise<ActionRow | null>;
  listActions(q: ListQuery): Promise<ActionRow[]>;

  insertComment(row: Omit<CommentRow, 'id' | 'createdAt'>): Promise<CommentRow>;
  getComment(id: string): Promise<CommentRow | null>;
  listComments(actionId: string): Promise<CommentRow[]>;

  insertTemplate(row: NewTemplate): Promise<TemplateRow>;
  getTemplate(id: string): Promise<TemplateRow | null>;
  updateTemplate(id: string, patch: Partial<TemplateRow>, expectedVersion: number): Promise<TemplateRow | null>;
  listTemplates(q: TemplateListQuery): Promise<TemplateRow[]>;
  insertVersion(row: NewVersion): Promise<TemplateVersionRow>;
  getVersion(id: string): Promise<TemplateVersionRow | null>;
  getDraftVersion(templateId: string): Promise<TemplateVersionRow | null>;
  getLatestPublishedVersion(templateId: string): Promise<TemplateVersionRow | null>;
  listVersionSummaries(templateId: string): Promise<VersionSummary[]>;
  /** null when the draft changed meanwhile or is no longer a draft */
  updateDraftContent(id: string, content: TemplateContent, expectedVersion: number): Promise<TemplateVersionRow | null>;
  markVersionPublished(id: string, p: { fingerprint: string; publishedAt: string; publishedBy: string }, expectedVersion: number): Promise<TemplateVersionRow | null>;

  /** null when the given id is already taken (by any organisation: the caller must not learn which). */
  insertInspection(row: NewInspection): Promise<InspectionRow | null>;
  /** `lock` serializes completion against concurrent autosaves (SELECT ... FOR UPDATE / FOR SHARE). */
  getInspection(id: string, lock?: 'update' | 'share'): Promise<InspectionRow | null>;
  updateInspection(id: string, patch: Partial<InspectionRow>, expectedVersion: number): Promise<InspectionRow | null>;
  listInspections(q: ListQuery): Promise<InspectionRow[]>;
  listResponses(inspectionId: string): Promise<ResponseRow[]>;
  /** expectedVersion 0 = the answer must not exist yet. Returns the current row on conflict. */
  upsertResponse(inspectionId: string, questionId: string, value: unknown, userId: string, expectedVersion: number): Promise<UpsertResult>;
  insertFlags(inspectionId: string, flags: NewFlag[]): Promise<FlagRow[]>;
  listFlags(inspectionId: string): Promise<FlagRow[]>;
  getFlag(id: string): Promise<FlagRow | null>;
  /** Links the flag to the issue/action created from it. null when it was already linked. */
  linkFlag(id: string, link: { issueId: string } | { actionId: string }): Promise<FlagRow | null>;

  /** counts by status (+ overdue and 'assigned to / started by me') over the rows the filter allows */
  statusCounts(kind: CountKind, filter: ListFilter, today: string, userId: string): Promise<StatusCounts>;

  insertNotifications(rows: NewNotification[]): Promise<void>;
  /** the CURRENT user's notifications, newest first */
  listNotifications(q: { unreadOnly: boolean; limit: number; cursor?: string }): Promise<NotificationRow[]>;
  countUnread(): Promise<number>;
  /** marks the current user's own notifications as read; returns how many changed */
  markNotificationsRead(ids: string[] | 'all'): Promise<number>;

  insertMedia(row: NewMedia): Promise<MediaRow>;
  getMedia(id: string): Promise<MediaRow | null>;
  getMediaMany(ids: string[]): Promise<MediaRow[]>;
  listMedia(ownerType: MediaOwner, ownerId: string, questionId?: string): Promise<MediaRow[]>;
  countMedia(ownerType: MediaOwner, ownerId: string, questionId: string | null, kind: MediaKind): Promise<number>;
  softDeleteMedia(id: string): Promise<boolean>;
  insertSignature(row: NewSignature): Promise<SignatureRow>;
  listSignatures(inspectionId: string): Promise<SignatureRow[]>;

  listRoles(): Promise<RoleRow[]>;
  getRole(id: string): Promise<RoleRow | null>;
  listMembers(): Promise<MemberRow[]>;
  getMember(membershipId: string): Promise<MemberRow | null>;
  /** false when the membership changed meanwhile (version mismatch) */
  updateMember(membershipId: string, patch: { roleId?: string; status?: 'active' | 'inactive' }, expectedVersion: number): Promise<boolean>;
  setMemberSites(membershipId: string, siteIds: string[]): Promise<void>;
  countActiveAdmins(excludeMembershipId?: string): Promise<number>;
  emailInUse(email: string): Promise<'member' | 'invited' | null>;
  insertInvitation(row: NewInvitation): Promise<InvitationRow>;
  listPendingInvitations(): Promise<InvitationRow[]>;
  getInvitation(id: string): Promise<InvitationRow | null>;
  revokeInvitation(id: string): Promise<InvitationRow | null>;

  listSites(): Promise<{ id: string; name: string }[]>;
  insertSite(name: string): Promise<{ id: string; name: string }>;
  getOrgName(): Promise<string>;
  getSiteName(id: string): Promise<string | null>;
  getUserNames(ids: string[]): Promise<Record<string, string>>;
  listActionsByInspection(inspectionId: string): Promise<ActionRow[]>;
  listIssuesByInspection(inspectionId: string): Promise<IssueRow[]>;

  appendTimeline(events: TimelineEvent[]): Promise<void>;
  listTimeline(entityType: 'issue' | 'action' | 'template' | 'inspection' | 'user' | 'invitation', entityId: string): Promise<TimelineRow[]>;
}

export interface WorkRepo {
  transaction<T>(ctx: { orgId: string; userId: string }, fn: (tx: WorkTx) => Promise<T>): Promise<T>;
  /** creates 'overdue' notifications for all organizations (once per item); returns how many were created */
  sweepOverdue(today: string): Promise<number>;
}

export type Clock = { now(): Date; today(): string };
