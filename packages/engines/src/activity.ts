// Activity/audit diffing and automatic linking of Issues/Actions to the place they were raised from.

export type ChangeEvent = {
  event: 'status_changed' | 'assigned' | 'priority_changed' | 'due_date_changed' | 'updated';
  field: string;
  oldValue: unknown;
  newValue: unknown;
};

const EVENT_BY_FIELD: Record<string, ChangeEvent['event']> = {
  status: 'status_changed',
  assigneeId: 'assigned',
  priority: 'priority_changed',
  dueDate: 'due_date_changed',
};

export const TRACKED_FIELDS = ['status', 'assigneeId', 'priority', 'dueDate', 'title', 'description', 'siteId', 'assetId', 'type'] as const;

const norm = (v: unknown) => (v === undefined ? null : v);

/** One event per changed tracked field, carrying old and new values (feeds timeline and audit log). */
export function diffEntity(
  before: Record<string, unknown>, after: Record<string, unknown>, fields: readonly string[] = TRACKED_FIELDS,
): ChangeEvent[] {
  const events: ChangeEvent[] = [];
  for (const field of fields) {
    const o = norm(before[field]);
    const n = norm(after[field]);
    if (JSON.stringify(o) !== JSON.stringify(n)) {
      events.push({ event: EVENT_BY_FIELD[field] ?? 'updated', field, oldValue: o, newValue: n });
    }
  }
  return events;
}

export type InspectionSource = {
  inspectionId: string;
  templateId: string;
  templateVersionId: string;
  siteId?: string | null;
  assetId?: string | null;
};

export type DraftFromQuestion = {
  title: string;
  siteId: string | null;
  assetId: string | null;
  createdBy: string;
  source: { inspectionId: string; templateId: string; templateVersionId: string; questionId: string };
};

/** Pre-fills an Issue/Action raised from an inspection question, so the user never re-types the context. */
export function draftFromQuestion(
  inspection: InspectionSource, question: { questionId: string; title: string }, actorId: string,
): DraftFromQuestion {
  return {
    title: question.title.trim().slice(0, 200),
    siteId: inspection.siteId ?? null,
    assetId: inspection.assetId ?? null,
    createdBy: actorId,
    source: {
      inspectionId: inspection.inspectionId,
      templateId: inspection.templateId,
      templateVersionId: inspection.templateVersionId,
      questionId: question.questionId,
    },
  };
}
