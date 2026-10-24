// Typed calls to the API (paths and bodies in one place).
import type { createApiClient } from './apiClient.ts';
import type {
  CommentDto, DashboardDto, FlagDto, InspectionDto, InvitationDto, MemberDto, Page, PersonDto, RoleDto, SiteDto, TemplateDto, TemplateIssueDto,
  TimelineDto, VersionSummaryDto, WorkItemDto, WorkKind,
} from './types.ts';
import type { TemplateContent } from '../../../../packages/engines/src/template/types.ts';
import type { EvaluationDto } from './evaluationDto.ts';
import type { NotificationDto } from './notifications.ts';

type Client = ReturnType<typeof createApiClient>;
const q = (params: Record<string, string | number | undefined>) => {
  const s = Object.entries(params).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&');
  return s ? `?${s}` : '';
};

export function createEndpoints(c: Client) {
  return {
    listSites: () => c.request<{ items: SiteDto[] }>('/sites'),
    createSite: (name: string) => c.request<{ site: SiteDto }>('/sites', { method: 'POST', body: { name } }),

    dashboard: () => c.request<DashboardDto>('/dashboard'),
    listPeople: () => c.request<{ items: PersonDto[] }>('/people'),

    // actions and issues share one set of calls: kind 'action' -> /actions, 'issue' -> /issues
    listWork: (kind: WorkKind, p: { status?: string; mine?: boolean; overdue?: boolean; cursor?: string; limit?: number } = {}) =>
      c.request<Page<WorkItemDto>>(`/${kind}s${q({ status: p.status, mine: p.mine ? 1 : undefined, overdue: p.overdue ? 1 : undefined, cursor: p.cursor, limit: p.limit })}`),
    getWork: (kind: WorkKind, id: string) => c.request<WorkItemDto>(`/${kind}s/${id}`),
    createWork: (kind: WorkKind, body: Record<string, unknown>) => c.request<WorkItemDto>(`/${kind}s`, { method: 'POST', body }),
    patchWork: (kind: WorkKind, id: string, body: Record<string, unknown>) => c.request<WorkItemDto>(`/${kind}s/${id}`, { method: 'PATCH', body }),
    workTimeline: (kind: WorkKind, id: string) => c.request<{ items: TimelineDto[] }>(`/${kind}s/${id}/timeline`),
    listComments: (actionId: string) => c.request<{ items: CommentDto[] }>(`/actions/${actionId}/comments`),
    addComment: (actionId: string, body: string) => c.request<CommentDto>(`/actions/${actionId}/comments`, { method: 'POST', body: { body } }),

    deleteMedia: (id: string) => c.request<{ ok: boolean }>(`/media/${id}`, { method: 'DELETE' }),
    addSignature: (inspectionId: string, body: { mediaId: string; signerName: string; signerRole?: string }) =>
      c.request<{ signature: { id: string } }>(`/inspections/${inspectionId}/signatures`, { method: 'POST', body }),

    listNotifications: (p: { unread?: boolean; cursor?: string; limit?: number } = {}) =>
      c.request<Page<NotificationDto>>(`/notifications${q({ unread: p.unread ? 1 : undefined, cursor: p.cursor, limit: p.limit })}`),
    unreadCount: () => c.request<{ count: number }>('/notifications/unread-count'),
    markRead: (body: { ids?: string[]; all?: boolean }) => c.request<{ changed: number; unread: number }>('/notifications/read', { method: 'POST', body }),

    listRoles: () => c.request<{ items: RoleDto[] }>('/roles'),
    listUsers: () => c.request<{ members: MemberDto[]; invitations: InvitationDto[] }>('/users'),
    inviteUser: (body: { email: string; fullName: string; roleId: string; siteIds: string[] }) =>
      c.request<{ invitation: InvitationDto }>('/users/invitations', { method: 'POST', body }),
    revokeInvitation: (id: string) => c.request<{ invitation: InvitationDto }>(`/users/invitations/${id}/revoke`, { method: 'POST' }),
    updateMember: (membershipId: string, body: { version: number; roleId?: string; status?: 'active' | 'inactive'; siteIds?: string[] }) =>
      c.request<{ member: MemberDto }>(`/users/${membershipId}`, { method: 'PATCH', body }),

    listTemplates: (p: { status?: string; cursor?: string; limit?: number } = {}) => c.request<Page<TemplateDto>>(`/templates${q(p)}`),
    getTemplate: (id: string) => c.request<{ template: TemplateDto; versions: VersionSummaryDto[] }>(`/templates/${id}`),
    getVersion: (templateId: string, versionId: string) =>
      c.request<{ version: { id: string; versionNo: number; status: string; content: TemplateContent } }>(`/templates/${templateId}/versions/${versionId}`),
    importTemplate: (body: { name: { ar?: string; en?: string }; content: unknown }) =>
      c.request<{ template: TemplateDto; draftVersionId: string; draftVersion: number }>('/templates', { method: 'POST', body }),
    validateTemplate: (id: string) => c.request<{ valid: boolean; issues: TemplateIssueDto[] }>(`/templates/${id}/validate`, { method: 'POST' }),
    publishTemplate: (id: string, version: number) => c.request<{ template: TemplateDto }>(`/templates/${id}/publish`, { method: 'POST', body: { version } }),

    listInspections: (p: { status?: string; cursor?: string; limit?: number } = {}) => c.request<Page<InspectionDto>>(`/inspections${q(p)}`),
    startInspection: (body: { id?: string; templateId: string; templateVersionId?: string; siteId?: string; title?: string }) => c.request<{ inspection: InspectionDto }>('/inspections', { method: 'POST', body }),
    getInspection: (id: string) => c.request<{
      inspection: InspectionDto;
      responses: Record<string, { value: unknown; version: number }>;
      evaluation: EvaluationDto; errors: Record<string, { code: string }[]>; progress: { answered: number; total: number; requiredMissing: number };
    }>(`/inspections/${id}`),
    completeInspection: (id: string) => c.request<{ inspection: InspectionDto; flags: FlagDto[] }>(`/inspections/${id}/complete`, { method: 'POST' }),
    cancelInspection: (id: string) => c.request<{ inspection: InspectionDto }>(`/inspections/${id}/cancel`, { method: 'POST' }),
    listFlags: (id: string) => c.request<{ items: FlagDto[] }>(`/inspections/${id}/flags`),
    fromFlag: (inspectionId: string, flagId: string, kind: 'action' | 'issue', body: Record<string, unknown> = {}) =>
      c.request<{ flag: FlagDto }>(`/inspections/${inspectionId}/flags/${flagId}/${kind}`, { method: 'POST', body }),
  };
}
export type Endpoints = ReturnType<typeof createEndpoints>;
