// Shapes of the API responses used by the screens (kept small on purpose).
import type { LocalizedText } from '../../../../packages/engines/src/template/types.ts';

export type TemplateStatus = 'draft' | 'published' | 'archived';
export type TemplateDto = {
  id: string; name: LocalizedText; description: LocalizedText | null; category: string | null;
  status: TemplateStatus; publishedVersionId: string | null; version: number;
};
export type VersionSummaryDto = { id: string; versionNo: number; status: 'draft' | 'published'; version: number };

export type InspectionStatus = 'in_progress' | 'completed' | 'cancelled' | 'archived';
export type InspectionDto = {
  id: string; templateId: string; templateVersionId: string; title: string | null; status: InspectionStatus;
  startedBy: string; siteId: string | null; startedAt: string; completedAt: string | null;
  scorePct: number | null; passed: boolean | null; flaggedRate: number | null; version: number;
};
export type FlagDto = {
  id: string; questionId: string; pageId: string; sectionId: string | null; severity: 'low' | 'medium' | 'high' | 'critical';
  descriptions: LocalizedText[]; status: 'open' | 'resolved'; issueId: string | null; actionId: string | null;
};
export type SiteDto = { id: string; name: string };
export type Page<T> = { items: T[]; nextCursor: string | null };
export type TemplateIssueDto = { code: string; path: string; detail?: string };

export type RoleDto = { id: string; key: string | null; name: string };
export type MemberDto = {
  membershipId: string; userId: string; fullName: string; email: string; roleId: string; roleKey: string | null; roleName: string;
  status: 'active' | 'inactive'; siteIds: string[]; version: number;
};
export type InvitationDto = { id: string; email: string; fullName: string; roleId: string; roleName: string; siteIds: string[]; expiresAt: string };

export type WorkKind = 'action' | 'issue';
export type WorkItemDto = {
  id: string; title: string; description: string | null; type: string; priority: string; status: string;
  assigneeId: string | null; siteId: string | null; dueDate: string | null; version: number;
  inspectionId: string | null; questionId: string | null; createdAt: string;
  ownerId?: string; reporterId?: string; issueId?: string | null; completedAt?: string | null;
  overdue?: boolean; effectiveStatus?: string;
};
export type CommentDto = { id: string; authorId: string; parentId: string | null; body: string; createdAt: string };
export type TimelineDto = { id: number; event: string; field: string | null; actorUserId: string; oldValue: unknown; newValue: unknown; at: string };
export type PersonDto = { userId: string; fullName: string };
export type Counts = { byStatus: Record<string, number>; overdue: number; mine: number };
export type DashboardDto = { issues: Counts | null; actions: Counts | null; inspections: Counts | null; today: string };

export type MediaDto = { id: string; kind: 'photo' | 'audio' | 'file' | 'signature'; mimeType: string; sizeBytes: number; caption: string | null };
