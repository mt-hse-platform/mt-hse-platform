// UNTESTED in the authoring sandbox (needs pg + PostgreSQL with migrations 0001/0002).
// Exercised by apps/api/src/e2e.itest.ts in CI. Every call runs in a transaction with the RLS context set.
import pg from 'pg';
import { AppError } from './ports.ts';
import type {
  ActionRow, CommentRow, CountKind, FlagRow, InspectionRow, InvitationRow, IssueRow, ListQuery, MediaRow, MemberRow, NotificationRow, SignatureRow, StatusCounts, NewAction, NewFlag, NewInspection, NewInvitation, NewIssue, NewTemplate, NewVersion, RoleRow,
  ResponseRow, TemplateListQuery, TemplateRow, UpsertResult,
  TemplateVersionRow, TimelineEvent, TimelineRow, VersionSummary, WorkRepo, WorkTx,
} from './workTypes.ts';

const TS = (col: string) => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const SOURCE_COLS = `inspection_id AS "inspectionId", template_id AS "templateId", template_version_id AS "templateVersionId", question_id AS "questionId"`;
const ISSUE_COLS = `id, org_id AS "orgId", title, description, type, priority, status, reporter_id AS "reporterId", assignee_id AS "assigneeId",
  site_id AS "siteId", asset_id AS "assetId", to_char(due_date, 'YYYY-MM-DD') AS "dueDate", ${SOURCE_COLS},
  ${TS('created_at')} AS "createdAt", ${TS('updated_at')} AS "updatedAt", version`;
const ACTION_COLS = `id, org_id AS "orgId", title, description, type, priority, status, owner_id AS "ownerId", assignee_id AS "assigneeId",
  site_id AS "siteId", asset_id AS "assetId", to_char(due_date, 'YYYY-MM-DD') AS "dueDate", ${TS('completed_at')} AS "completedAt",
  issue_id AS "issueId", ${SOURCE_COLS}, ${TS('created_at')} AS "createdAt", ${TS('updated_at')} AS "updatedAt", version`;
const COMMENT_COLS = `id, org_id AS "orgId", action_id AS "actionId", author_id AS "authorId", parent_id AS "parentId", body, ${TS('created_at')} AS "createdAt"`;

const TEMPLATE_COLS = `id, org_id AS "orgId", name, description, category, status, published_version_id AS "publishedVersionId",
  created_by AS "createdBy", ${TS('created_at')} AS "createdAt", ${TS('updated_at')} AS "updatedAt", version`;
const VERSION_SUMMARY_COLS = `id, org_id AS "orgId", template_id AS "templateId", version_no AS "versionNo", status, fingerprint,
  ${TS('published_at')} AS "publishedAt", published_by AS "publishedBy", created_by AS "createdBy",
  ${TS('created_at')} AS "createdAt", ${TS('updated_at')} AS "updatedAt", version`;
const VERSION_COLS = `${VERSION_SUMMARY_COLS}, content`;
const TEMPLATE_PATCH: Record<string, [string, string]> = {
  name: ['name', '::jsonb'], description: ['description', '::jsonb'], category: ['category', ''], status: ['status', ''],
  publishedVersionId: ['published_version_id', '::uuid'],
};

const INSPECTION_COLS = `id, org_id AS "orgId", template_id AS "templateId", template_version_id AS "templateVersionId", title, status,
  started_by AS "startedBy", site_id AS "siteId", asset_id AS "assetId", ${TS('started_at')} AS "startedAt",
  ${TS('completed_at')} AS "completedAt", ${TS('cancelled_at')} AS "cancelledAt",
  score_earned::float8 AS "scoreEarned", score_possible::float8 AS "scorePossible", score_pct::float8 AS "scorePct",
  passed, flagged_rate::float8 AS "flaggedRate", ${TS('created_at')} AS "createdAt", ${TS('updated_at')} AS "updatedAt", version`;
const RESPONSE_COLS = `inspection_id AS "inspectionId", question_id AS "questionId", value, updated_by AS "updatedBy", ${TS('updated_at')} AS "updatedAt", version`;
const FLAG_COLS = `id, org_id AS "orgId", inspection_id AS "inspectionId", question_id AS "questionId", page_id AS "pageId", section_id AS "sectionId",
  severity, descriptions, status, issue_id AS "issueId", action_id AS "actionId", ${TS('created_at')} AS "createdAt"`;
const INSPECTION_PATCH: Record<string, [string, string]> = {
  status: ['status', ''], completedAt: ['completed_at', '::timestamptz'], cancelledAt: ['cancelled_at', '::timestamptz'],
  scoreEarned: ['score_earned', ''], scorePossible: ['score_possible', ''], scorePct: ['score_pct', ''], passed: ['passed', ''], flaggedRate: ['flagged_rate', ''],
};

const MEMBER_COLS = `m.id AS "membershipId", m.user_id AS "userId", u.full_name AS "fullName", u.email, m.role_id AS "roleId", r.key AS "roleKey", r.name AS "roleName",
  m.status, COALESCE((SELECT array_agg(ms.site_id ORDER BY ms.site_id) FROM membership_sites ms WHERE ms.membership_id = m.id), '{}') AS "siteIds",
  m.version, ${TS('m.created_at')} AS "createdAt"`;
const MEMBER_FROM = `FROM memberships m JOIN users u ON u.id = m.user_id JOIN roles r ON r.id = m.role_id AND r.org_id = m.org_id`;
const INVITATION_COLS = `i.id, i.email, i.full_name AS "fullName", i.role_id AS "roleId",
  (SELECT r.name FROM roles r WHERE r.id = i.role_id AND r.org_id = i.org_id) AS "roleName", i.site_ids AS "siteIds", i.status,
  i.invited_by AS "invitedBy", ${TS('i.created_at')} AS "createdAt", ${TS('i.expires_at')} AS "expiresAt", i.version`;

const MEDIA_COLS = `id, org_id AS "orgId", owner_type AS "ownerType", owner_id AS "ownerId", question_id AS "questionId", kind, mime_type AS "mimeType",
  size_bytes AS "sizeBytes", sha256, storage_key AS "storageKey", caption, ${TS('taken_at')} AS "takenAt", lat, lng, uploaded_by AS "uploadedBy", ${TS('created_at')} AS "createdAt"`;
const SIGNATURE_COLS = `id, inspection_id AS "inspectionId", media_id AS "mediaId", signer_name AS "signerName", signer_role AS "signerRole", signed_by AS "signedBy", ${TS('signed_at')} AS "signedAt"`;

const NOTIFICATION_COLS = `id, type, entity_type AS "entityType", entity_id AS "entityId", actor_user_id AS "actorUserId", data, ${TS('created_at')} AS "createdAt", ${TS('read_at')} AS "readAt"`;

// camelCase patch key -> [column, SQL cast]. Only these keys can ever reach an UPDATE statement.
const ISSUE_PATCH: Record<string, [string, string]> = {
  title: ['title', ''], description: ['description', ''], type: ['type', ''], priority: ['priority', ''], status: ['status', ''],
  assigneeId: ['assignee_id', '::uuid'], siteId: ['site_id', '::uuid'], assetId: ['asset_id', '::uuid'], dueDate: ['due_date', '::date'],
};
const ACTION_PATCH: Record<string, [string, string]> = { ...ISSUE_PATCH, completedAt: ['completed_at', '::timestamptz'] };

function translate(err: unknown): never {
  const code = (err as { code?: string } | null)?.code;
  if (code === '23503') throw new AppError(422, 'validation', { reference: [{ code: 'invalid_reference' }] });
  if (code === '23505') throw new AppError(409, 'conflict');
  if (code === '55000') throw new AppError(422, 'not_editable');
  if (code === '23514') throw new AppError(422, 'validation', { value: [{ code: 'invalid_type' }] });
  throw err;
}

export class PgWorkRepo implements WorkRepo {
  private pool: pg.Pool;
  constructor(pool: pg.Pool) { this.pool = pool; }

  /** Runs the overdue sweep for every organization (a SECURITY DEFINER function, no organization context needed). */
  async sweepOverdue(today: string): Promise<number> {
    const { rows } = await this.pool.query('SELECT generate_overdue_notifications($1::date) AS n', [today]);
    return Number(rows[0]?.n ?? 0);
  }

  async transaction<T>(ctx: { orgId: string; userId: string }, fn: (tx: WorkTx) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.org_id', $1, true), set_config('app.user_id', $2, true)", [ctx.orgId, ctx.userId]);
      const result = await fn(makeTx(client));
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}

function buildUpdate(table: string, cols: string, map: Record<string, [string, string]>, id: string, patch: Record<string, unknown>, expected: number) {
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [key, value] of Object.entries(patch)) {
    const m = map[key];
    if (!m) throw new Error(`Field not updatable: ${key}`);
    params.push(value ?? null);
    sets.push(`${m[0]} = $${params.length}${m[1]}`);
  }
  sets.push('version = version + 1', 'updated_at = now()');
  params.push(id, expected);
  return { text: `UPDATE ${table} SET ${sets.join(', ')} WHERE id = $${params.length - 1} AND version = $${params.length} RETURNING ${cols}`, params };
}

function listSql(table: string, cols: string, ownerCol: string, openStatuses: string[], q: ListQuery) {
  const [at, id] = q.cursor ? q.cursor.split('|') : [null, null];
  return {
    text: `SELECT ${cols} FROM ${table}
      WHERE deleted_at IS NULL
        AND ($1::text IS NULL OR status = $1)
        AND ($2::boolean OR site_id = ANY($3::uuid[]) OR ${ownerCol} = $4::uuid OR assignee_id = $5::uuid)
        AND ($6::timestamptz IS NULL OR (created_at, id) < ($6::timestamptz, $7::uuid))
        AND ($9::uuid IS NULL OR assignee_id = $9::uuid)
        AND ($10::date IS NULL OR (due_date < $10::date AND status = ANY($11::text[])))
      ORDER BY created_at DESC, id DESC LIMIT $8`,
    params: [q.status ?? null, q.filter.orgWide, q.filter.siteIds, q.filter.ownerId ?? null, q.filter.assigneeId ?? null, at ?? null, id ?? null, q.limit,
      q.assigneeOnly ?? null, q.overdueBefore ?? null, openStatuses],
  };
}

function makeTx(c: pg.PoolClient): WorkTx {
  const one = async <R>(text: string, params: unknown[]): Promise<R | null> => {
    try { return ((await c.query(text, params)).rows[0] as R | undefined) ?? null; } catch (e) { return translate(e); }
  };
  const many = async <R>(text: string, params: unknown[]): Promise<R[]> => {
    try { return (await c.query(text, params)).rows as R[]; } catch (e) { return translate(e); }
  };

  return {
    async isActiveMember(userId) {
      const r = await one('SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.user_id = $1 AND m.status = $2 AND u.active', [userId, 'active']);
      return r !== null;
    },

    async insertIssue(r: NewIssue) {
      return (await one<IssueRow>(
        `INSERT INTO issues (org_id, title, description, type, priority, status, reporter_id, assignee_id, site_id, asset_id, due_date,
           inspection_id, template_id, template_version_id, question_id)
         VALUES (app_org_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::date, $11, $12, $13, $14) RETURNING ${ISSUE_COLS}`,
        [r.title, r.description, r.type, r.priority, r.status, r.reporterId, r.assigneeId, r.siteId, r.assetId, r.dueDate,
         r.inspectionId, r.templateId, r.templateVersionId, r.questionId],
      ))!;
    },
    getIssue: (id) => one<IssueRow>(`SELECT ${ISSUE_COLS} FROM issues WHERE id = $1 AND deleted_at IS NULL`, [id]),
    async updateIssue(id, patch, expected) {
      const q = buildUpdate('issues', ISSUE_COLS, ISSUE_PATCH, id, patch, expected);
      return one<IssueRow>(q.text, q.params);
    },
    listIssues(q) { const s = listSql('issues', ISSUE_COLS, 'reporter_id', ['open', 'under_review', 'assigned', 'in_progress'], q); return many<IssueRow>(s.text, s.params); },

    async insertAction(r: NewAction) {
      return (await one<ActionRow>(
        `INSERT INTO actions (org_id, title, description, type, priority, status, owner_id, assignee_id, site_id, asset_id, due_date,
           completed_at, issue_id, inspection_id, template_id, template_version_id, question_id)
         VALUES (app_org_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::date, $11::timestamptz, $12, $13, $14, $15, $16) RETURNING ${ACTION_COLS}`,
        [r.title, r.description, r.type, r.priority, r.status, r.ownerId, r.assigneeId, r.siteId, r.assetId, r.dueDate,
         r.completedAt, r.issueId, r.inspectionId, r.templateId, r.templateVersionId, r.questionId],
      ))!;
    },
    getAction: (id) => one<ActionRow>(`SELECT ${ACTION_COLS} FROM actions WHERE id = $1 AND deleted_at IS NULL`, [id]),
    async updateAction(id, patch, expected) {
      const q = buildUpdate('actions', ACTION_COLS, ACTION_PATCH, id, patch, expected);
      return one<ActionRow>(q.text, q.params);
    },
    listActions(q) { const s = listSql('actions', ACTION_COLS, 'owner_id', ['todo', 'in_progress', 'pending_verification'], q); return many<ActionRow>(s.text, s.params); },

    async insertComment(r) {
      return (await one<CommentRow>(
        `INSERT INTO action_comments (org_id, action_id, author_id, parent_id, body) VALUES (app_org_id(), $1, $2, $3, $4) RETURNING ${COMMENT_COLS}`,
        [r.actionId, r.authorId, r.parentId, r.body],
      ))!;
    },
    getComment: (id) => one<CommentRow>(`SELECT ${COMMENT_COLS} FROM action_comments WHERE id = $1`, [id]),
    listComments: (actionId) => many<CommentRow>(`SELECT ${COMMENT_COLS} FROM action_comments WHERE action_id = $1 ORDER BY created_at, id`, [actionId]),

    async insertTemplate(r: NewTemplate) {
      return (await one<TemplateRow>(
        `INSERT INTO templates (org_id, name, description, category, status, published_version_id, created_by)
         VALUES (app_org_id(), $1::jsonb, $2::jsonb, $3, $4, $5, $6) RETURNING ${TEMPLATE_COLS}`,
        [JSON.stringify(r.name), r.description ? JSON.stringify(r.description) : null, r.category, r.status, r.publishedVersionId, r.createdBy],
      ))!;
    },
    getTemplate: (id) => one<TemplateRow>(`SELECT ${TEMPLATE_COLS} FROM templates WHERE id = $1 AND deleted_at IS NULL`, [id]),
    async updateTemplate(id, patch, expected) {
      const p: Record<string, unknown> = { ...patch };
      for (const k of ['name', 'description']) if (k in p) p[k] = p[k] === null ? null : JSON.stringify(p[k]);
      const q = buildUpdate('templates', TEMPLATE_COLS, TEMPLATE_PATCH, id, p, expected);
      return one<TemplateRow>(q.text, q.params);
    },
    listTemplates(q: TemplateListQuery) {
      const [at, cid] = q.cursor ? q.cursor.split('|') : [null, null];
      return many<TemplateRow>(
        `SELECT ${TEMPLATE_COLS} FROM templates
         WHERE deleted_at IS NULL
           AND ($1::text IS NULL OR status = $1)
           AND (NOT $2::boolean OR (status = 'published' AND published_version_id IS NOT NULL))
           AND ($3::timestamptz IS NULL OR (created_at, id) < ($3::timestamptz, $4::uuid))
         ORDER BY created_at DESC, id DESC LIMIT $5`,
        [q.status ?? null, q.onlyPublished, at ?? null, cid ?? null, q.limit],
      );
    },
    async insertVersion(r: NewVersion) {
      return (await one<TemplateVersionRow>(
        `INSERT INTO template_versions (org_id, template_id, version_no, status, content, fingerprint, published_at, published_by, created_by)
         VALUES (app_org_id(), $1, $2, $3, $4::jsonb, $5, $6::timestamptz, $7, $8) RETURNING ${VERSION_COLS}`,
        [r.templateId, r.versionNo, r.status, JSON.stringify(r.content), r.fingerprint, r.publishedAt, r.publishedBy, r.createdBy],
      ))!;
    },
    getVersion: (id) => one<TemplateVersionRow>(`SELECT ${VERSION_COLS} FROM template_versions WHERE id = $1`, [id]),
    getDraftVersion: (tid) => one<TemplateVersionRow>(`SELECT ${VERSION_COLS} FROM template_versions WHERE template_id = $1 AND status = 'draft'`, [tid]),
    getLatestPublishedVersion: (tid) => one<TemplateVersionRow>(
      `SELECT ${VERSION_COLS} FROM template_versions WHERE template_id = $1 AND status = 'published' ORDER BY version_no DESC LIMIT 1`, [tid]),
    listVersionSummaries: (tid) => many<VersionSummary>(`SELECT ${VERSION_SUMMARY_COLS} FROM template_versions WHERE template_id = $1 ORDER BY version_no DESC`, [tid]),
    updateDraftContent: (id, content, expected) => one<TemplateVersionRow>(
      `UPDATE template_versions SET content = $1::jsonb, version = version + 1, updated_at = now()
       WHERE id = $2 AND version = $3 AND status = 'draft' RETURNING ${VERSION_COLS}`,
      [JSON.stringify(content), id, expected]),
    markVersionPublished: (id, p, expected) => one<TemplateVersionRow>(
      `UPDATE template_versions SET status = 'published', fingerprint = $1, published_at = $2::timestamptz, published_by = $3,
         version = version + 1, updated_at = now()
       WHERE id = $4 AND version = $5 AND status = 'draft' RETURNING ${VERSION_COLS}`,
      [p.fingerprint, p.publishedAt, p.publishedBy, id, expected]),

    async insertInspection(r: NewInspection) {
      // ON CONFLICT also covers an id used by another organisation (invisible to this session): no row comes back
      return one<InspectionRow>(
        `INSERT INTO inspections (id, org_id, template_id, template_version_id, title, started_by, site_id, asset_id)
         VALUES (COALESCE($7::uuid, gen_random_uuid()), app_org_id(), $1, $2, $3, $4, $5, $6)
         ON CONFLICT (id) DO NOTHING RETURNING ${INSPECTION_COLS}`,
        [r.templateId, r.templateVersionId, r.title, r.startedBy, r.siteId, r.assetId, r.id ?? null],
      );
    },
    getInspection: (id, lock) => one<InspectionRow>(
      `SELECT ${INSPECTION_COLS} FROM inspections WHERE id = $1 AND deleted_at IS NULL${lock === 'update' ? ' FOR UPDATE' : lock === 'share' ? ' FOR SHARE' : ''}`, [id]),
    async updateInspection(id, patch, expected) {
      const q = buildUpdate('inspections', INSPECTION_COLS, INSPECTION_PATCH, id, patch, expected);
      return one<InspectionRow>(q.text, q.params);
    },
    listInspections(q) {
      const [at, cid] = q.cursor ? q.cursor.split('|') : [null, null];
      return many<InspectionRow>(
        `SELECT ${INSPECTION_COLS} FROM inspections
         WHERE deleted_at IS NULL
           AND ($1::text IS NULL OR status = $1)
           AND ($2::boolean OR site_id = ANY($3::uuid[]) OR started_by = $4::uuid)
           AND ($5::timestamptz IS NULL OR (created_at, id) < ($5::timestamptz, $6::uuid))
         ORDER BY created_at DESC, id DESC LIMIT $7`,
        [q.status ?? null, q.filter.orgWide, q.filter.siteIds, q.filter.ownerId ?? null, at ?? null, cid ?? null, q.limit],
      );
    },
    listResponses: (iid) => many<ResponseRow>(`SELECT ${RESPONSE_COLS} FROM inspection_responses WHERE inspection_id = $1 ORDER BY question_id`, [iid]),
    async upsertResponse(iid, qid, value, userId, expected): Promise<UpsertResult> {
      const json = value === undefined || value === null ? null : JSON.stringify(value);
      let row: ResponseRow | null;
      if (expected === 0) {
        row = await one<ResponseRow>(
          `INSERT INTO inspection_responses (org_id, inspection_id, question_id, value, updated_by)
           VALUES (app_org_id(), $1, $2, $3::jsonb, $4) ON CONFLICT (inspection_id, question_id) DO NOTHING RETURNING ${RESPONSE_COLS}`,
          [iid, qid, json, userId]);
      } else {
        row = await one<ResponseRow>(
          `UPDATE inspection_responses SET value = $3::jsonb, updated_by = $4, updated_at = now(), version = version + 1
           WHERE inspection_id = $1 AND question_id = $2 AND version = $5 RETURNING ${RESPONSE_COLS}`,
          [iid, qid, json, userId, expected]);
      }
      if (row) return { ok: true, row };
      const current = await one<ResponseRow>(`SELECT ${RESPONSE_COLS} FROM inspection_responses WHERE inspection_id = $1 AND question_id = $2`, [iid, qid]);
      return { ok: false, current };
    },
    async insertFlags(iid, flags: NewFlag[]) {
      const out: FlagRow[] = [];
      for (const f of flags) {
        out.push((await one<FlagRow>(
          `INSERT INTO inspection_flags (org_id, inspection_id, question_id, page_id, section_id, severity, descriptions)
           VALUES (app_org_id(), $1, $2, $3, $4, $5, $6::jsonb) RETURNING ${FLAG_COLS}`,
          [iid, f.questionId, f.pageId, f.sectionId, f.severity, JSON.stringify(f.descriptions)]))!);
      }
      return out;
    },
    getFlag: (id) => one<FlagRow>(`SELECT ${FLAG_COLS} FROM inspection_flags WHERE id = $1`, [id]),
    linkFlag: (id, link) => 'issueId' in link
      ? one<FlagRow>(`UPDATE inspection_flags SET issue_id = $2 WHERE id = $1 AND issue_id IS NULL RETURNING ${FLAG_COLS}`, [id, link.issueId])
      : one<FlagRow>(`UPDATE inspection_flags SET action_id = $2 WHERE id = $1 AND action_id IS NULL RETURNING ${FLAG_COLS}`, [id, link.actionId]),
    listFlags: (iid) => many<FlagRow>(`SELECT ${FLAG_COLS} FROM inspection_flags WHERE inspection_id = $1 ORDER BY created_at, question_id`, [iid]),

    async statusCounts(kind: CountKind, f, today, userId): Promise<StatusCounts> {
      const open = kind === 'issues' ? ['open', 'under_review', 'assigned', 'in_progress'] : kind === 'actions' ? ['todo', 'in_progress', 'pending_verification'] : ['in_progress'];
      const sql = kind === 'inspections'
        ? `SELECT status, count(*)::int AS n, 0 AS overdue, count(*) FILTER (WHERE started_by = $3::uuid AND status = ANY($2::text[]))::int AS mine
           FROM inspections WHERE deleted_at IS NULL AND ($4::boolean OR site_id = ANY($5::uuid[]) OR started_by = $6::uuid) AND $1::date IS NOT NULL GROUP BY status`
        : `SELECT status, count(*)::int AS n,
             count(*) FILTER (WHERE due_date < $1::date AND status = ANY($2::text[]))::int AS overdue,
             count(*) FILTER (WHERE assignee_id = $3::uuid AND status = ANY($2::text[]))::int AS mine
           FROM ${kind} WHERE deleted_at IS NULL AND ($4::boolean OR site_id = ANY($5::uuid[]) OR ${kind === 'issues' ? 'reporter_id' : 'owner_id'} = $6::uuid OR assignee_id = $7::uuid) GROUP BY status`;
      const params: unknown[] = [today, open, userId, f.orgWide, f.siteIds, f.ownerId ?? null];
      if (kind !== 'inspections') params.push(f.assigneeId ?? null);
      const rows = await many<{ status: string; n: number; overdue: number; mine: number }>(sql, params);
      const out: StatusCounts = { byStatus: {}, overdue: 0, mine: 0 };
      for (const r of rows) { out.byStatus[r.status] = Number(r.n); out.overdue += Number(r.overdue); out.mine += Number(r.mine); }
      return out;
    },

    async insertNotifications(rows) {
      // no RETURNING: a notification for someone else is (by design) not readable by the sender
      for (const r of rows) {
        await one(
          `INSERT INTO notifications (org_id, user_id, type, entity_type, entity_id, actor_user_id, data, dedupe_key)
           VALUES (app_org_id(), $1, $2, $3, $4, $5, $6::jsonb, $7) ON CONFLICT DO NOTHING`,
          [r.userId, r.type, r.entityType, r.entityId, r.actorUserId, JSON.stringify(r.data), r.dedupeKey ?? null]);
      }
    },
    listNotifications(q) {
      const [at, cid] = q.cursor ? q.cursor.split('|') : [null, null];
      return many<NotificationRow>(
        `SELECT ${NOTIFICATION_COLS} FROM notifications
         WHERE user_id = app_user_id() AND ($1::boolean IS FALSE OR read_at IS NULL)
           AND ($2::timestamptz IS NULL OR (created_at, id) < ($2::timestamptz, $3::uuid))
         ORDER BY created_at DESC, id DESC LIMIT $4`,
        [q.unreadOnly, at ?? null, cid ?? null, q.limit]);
    },
    async countUnread() { return (await one<{ n: number }>('SELECT count(*)::int AS n FROM notifications WHERE user_id = app_user_id() AND read_at IS NULL', []))?.n ?? 0; },
    async markNotificationsRead(ids) {
      const rows = await many<{ id: string }>(
        `UPDATE notifications SET read_at = now() WHERE user_id = app_user_id() AND read_at IS NULL AND ($1::boolean OR id = ANY($2::uuid[])) RETURNING id`,
        [ids === 'all', ids === 'all' ? [] : ids]);
      return rows.length;
    },

    async insertMedia(r) {
      return (await one<MediaRow>(
        `INSERT INTO media (id, org_id, owner_type, owner_id, question_id, kind, mime_type, size_bytes, sha256, storage_key, caption, taken_at, lat, lng, uploaded_by)
         VALUES ($1, app_org_id(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::timestamptz, $12, $13, $14) RETURNING ${MEDIA_COLS}`,
        [r.id, r.ownerType, r.ownerId, r.questionId, r.kind, r.mimeType, r.sizeBytes, r.sha256, r.storageKey, r.caption, r.takenAt, r.lat, r.lng, r.uploadedBy]))!;
    },
    getMedia: (id) => one<MediaRow>(`SELECT ${MEDIA_COLS} FROM media WHERE id = $1 AND deleted_at IS NULL`, [id]),
    getMediaMany: (ids) => many<MediaRow>(`SELECT ${MEDIA_COLS} FROM media WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`, [ids]),
    listMedia: (ownerType, ownerId, questionId) => many<MediaRow>(
      `SELECT ${MEDIA_COLS} FROM media WHERE owner_type = $1 AND owner_id = $2 AND deleted_at IS NULL AND ($3::text IS NULL OR question_id = $3) ORDER BY created_at, id`,
      [ownerType, ownerId, questionId ?? null]),
    async countMedia(ownerType, ownerId, questionId, kind) {
      const r = await one<{ n: number }>(
        `SELECT count(*)::int AS n FROM media WHERE owner_type = $1 AND owner_id = $2 AND question_id IS NOT DISTINCT FROM $3 AND kind = $4 AND deleted_at IS NULL`,
        [ownerType, ownerId, questionId, kind]);
      return r?.n ?? 0;
    },
    async softDeleteMedia(id) { return (await one('UPDATE media SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING id', [id])) !== null; },
    async insertSignature(r) {
      return (await one<SignatureRow>(
        `INSERT INTO inspection_signatures (org_id, inspection_id, media_id, signer_name, signer_role, signed_by) VALUES (app_org_id(), $1, $2, $3, $4, $5) RETURNING ${SIGNATURE_COLS}`,
        [r.inspectionId, r.mediaId, r.signerName, r.signerRole, r.signedBy]))!;
    },
    listSignatures: (iid) => many<SignatureRow>(`SELECT ${SIGNATURE_COLS} FROM inspection_signatures WHERE inspection_id = $1 ORDER BY signed_at, id`, [iid]),

    listRoles: () => many<RoleRow>('SELECT id, key, name FROM roles ORDER BY name', []),
    getRole: (id) => one<RoleRow>('SELECT id, key, name FROM roles WHERE id = $1', [id]),
    listMembers: () => many<MemberRow>(`SELECT ${MEMBER_COLS} ${MEMBER_FROM} ORDER BY u.full_name, m.id`, []),
    getMember: (id) => one<MemberRow>(`SELECT ${MEMBER_COLS} ${MEMBER_FROM} WHERE m.id = $1`, [id]),
    async updateMember(id, patch, expected) {
      const r = await one<{ id: string }>(
        `UPDATE memberships SET role_id = COALESCE($2::uuid, role_id), status = COALESCE($3, status), updated_at = now(), version = version + 1
         WHERE id = $1 AND version = $4 RETURNING id`, [id, patch.roleId ?? null, patch.status ?? null, expected]);
      return r !== null;
    },
    async setMemberSites(id, siteIds) {
      await one('DELETE FROM membership_sites WHERE membership_id = $1', [id]);
      for (const siteId of siteIds) await one('INSERT INTO membership_sites (org_id, membership_id, site_id) VALUES (app_org_id(), $1, $2)', [id, siteId]);
    },
    async countActiveAdmins(exclude) {
      const r = await one<{ n: number }>(
        `SELECT count(*)::int AS n FROM memberships m JOIN roles r ON r.id = m.role_id AND r.org_id = m.org_id
         WHERE m.status = 'active' AND r.key = ANY (ARRAY['org_admin', 'super_admin']) AND ($1::uuid IS NULL OR m.id <> $1::uuid)`, [exclude ?? null]);
      return r?.n ?? 0;
    },
    async emailInUse(email) {
      if (await one('SELECT 1 FROM users u JOIN memberships m ON m.user_id = u.id WHERE u.email = $1', [email])) return 'member';
      if (await one("SELECT 1 FROM invitations WHERE email = $1 AND status = 'pending'", [email])) return 'invited';
      return null;
    },
    async insertInvitation(r: NewInvitation) {
      return (await one<InvitationRow>(
        `INSERT INTO invitations AS i (org_id, email, full_name, role_id, site_ids, invited_by) VALUES (app_org_id(), $1, $2, $3, $4::uuid[], $5)
         RETURNING ${INVITATION_COLS}`, [r.email, r.fullName, r.roleId, r.siteIds, r.invitedBy]))!;
    },
    listPendingInvitations: () => many<InvitationRow>(`SELECT ${INVITATION_COLS} FROM invitations i WHERE i.status = 'pending' ORDER BY i.created_at DESC, i.id`, []),
    getInvitation: (id) => one<InvitationRow>(`SELECT ${INVITATION_COLS} FROM invitations i WHERE i.id = $1`, [id]),
    revokeInvitation: (id) => one<InvitationRow>(
      `UPDATE invitations AS i SET status = 'revoked', updated_at = now(), version = i.version + 1 WHERE i.id = $1 AND i.status = 'pending' RETURNING ${INVITATION_COLS}`, [id]),

    listSites: () => many<{ id: string; name: string }>('SELECT id, name FROM sites WHERE deleted_at IS NULL ORDER BY name', []),
    async insertSite(name) { return (await one<{ id: string; name: string }>('INSERT INTO sites (org_id, name) VALUES (app_org_id(), $1) RETURNING id, name', [name]))!; },
    async getOrgName() { return (await one<{ name: string }>('SELECT name FROM organizations WHERE id = app_org_id()', []))?.name ?? ''; },
    async getSiteName(id) { return (await one<{ name: string }>('SELECT name FROM sites WHERE id = $1', [id]))?.name ?? null; },
    async getUserNames(ids) {
      const rows = await many<{ id: string; full_name: string }>('SELECT id, full_name FROM users WHERE id = ANY($1::uuid[])', [ids]);
      return Object.fromEntries(rows.map((r) => [r.id, r.full_name]));
    },
    listActionsByInspection: (iid) => many<ActionRow>(`SELECT ${ACTION_COLS} FROM actions WHERE inspection_id = $1 AND deleted_at IS NULL ORDER BY created_at, id`, [iid]),
    listIssuesByInspection: (iid) => many<IssueRow>(`SELECT ${ISSUE_COLS} FROM issues WHERE inspection_id = $1 AND deleted_at IS NULL ORDER BY created_at, id`, [iid]),

    async appendTimeline(events: TimelineEvent[]) {
      for (const e of events) {
        await one(
          `INSERT INTO timeline_events (org_id, entity_type, entity_id, event, field, actor_user_id, old_value, new_value)
           VALUES (app_org_id(), $1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)`,
          [e.entityType, e.entityId, e.event, e.field, e.actorUserId,
           e.oldValue === null || e.oldValue === undefined ? null : JSON.stringify(e.oldValue),
           e.newValue === null || e.newValue === undefined ? null : JSON.stringify(e.newValue)],
        );
      }
    },
    async listTimeline(entityType, entityId) {
      const rows = await many<TimelineRow>(
        `SELECT id, entity_type AS "entityType", entity_id AS "entityId", event, field, actor_user_id AS "actorUserId",
                old_value AS "oldValue", new_value AS "newValue", ${TS('at')} AS "at"
         FROM timeline_events WHERE entity_type = $1 AND entity_id = $2 ORDER BY id`,
        [entityType, entityId],
      );
      return rows.map((r) => ({ ...r, id: Number(r.id) }));
    },
  };
}
