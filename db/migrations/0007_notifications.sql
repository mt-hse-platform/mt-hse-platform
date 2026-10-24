-- MT-HSE-Platform — migration 0007: in-app notifications (assignments, comments, verification requests, overdue).
-- Each person sees ONLY their own notifications (row-level security by organization AND user).
BEGIN;

CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  user_id uuid NOT NULL REFERENCES users(id),
  type text NOT NULL CHECK (type IN ('action_assigned', 'issue_assigned', 'comment_added', 'action_pending_verification', 'action_overdue', 'issue_overdue')),
  entity_type text NOT NULL CHECK (entity_type IN ('action', 'issue', 'inspection')),
  entity_id uuid NOT NULL,
  actor_user_id uuid REFERENCES users(id),
  data jsonb NOT NULL DEFAULT '{}',
  dedupe_key text,                      -- makes automatic notifications (overdue) idempotent
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz
);
CREATE UNIQUE INDEX notifications_dedupe ON notifications (org_id, user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX notifications_user_idx ON notifications (org_id, user_id, created_at DESC);
CREATE INDEX notifications_unread_idx ON notifications (org_id, user_id) WHERE read_at IS NULL;

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
-- reading and marking as read: own rows only. Creating: anyone in the organization may notify a colleague.
CREATE POLICY notif_select ON notifications FOR SELECT USING (org_id = app_org_id() AND user_id = app_user_id());
CREATE POLICY notif_update ON notifications FOR UPDATE USING (org_id = app_org_id() AND user_id = app_user_id())
  WITH CHECK (org_id = app_org_id() AND user_id = app_user_id());
CREATE POLICY notif_insert ON notifications FOR INSERT WITH CHECK (org_id = app_org_id());

GRANT SELECT, INSERT ON notifications TO app_user;
GRANT UPDATE (read_at) ON notifications TO app_user;      -- the only thing a person may change: read / unread

-- Overdue sweep across all organizations (no organization context), safe to run repeatedly.
CREATE FUNCTION generate_overdue_notifications(p_today date) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n_actions integer; n_issues integer;
BEGIN
  INSERT INTO notifications (org_id, user_id, type, entity_type, entity_id, data, dedupe_key)
  SELECT a.org_id, a.assignee_id, 'action_overdue', 'action', a.id,
         jsonb_build_object('entityTitle', a.title, 'dueDate', to_char(a.due_date, 'YYYY-MM-DD')), 'overdue:' || a.id::text
  FROM actions a
  JOIN memberships m ON m.user_id = a.assignee_id AND m.org_id = a.org_id AND m.status = 'active'
  WHERE a.deleted_at IS NULL AND a.assignee_id IS NOT NULL AND a.due_date < p_today
    AND a.status IN ('todo', 'in_progress', 'pending_verification')
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS n_actions = ROW_COUNT;

  INSERT INTO notifications (org_id, user_id, type, entity_type, entity_id, data, dedupe_key)
  SELECT i.org_id, i.assignee_id, 'issue_overdue', 'issue', i.id,
         jsonb_build_object('entityTitle', i.title, 'dueDate', to_char(i.due_date, 'YYYY-MM-DD')), 'overdue:' || i.id::text
  FROM issues i
  JOIN memberships m ON m.user_id = i.assignee_id AND m.org_id = i.org_id AND m.status = 'active'
  WHERE i.deleted_at IS NULL AND i.assignee_id IS NOT NULL AND i.due_date < p_today
    AND i.status IN ('open', 'under_review', 'assigned', 'in_progress')
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS n_issues = ROW_COUNT;

  RETURN n_actions + n_issues;
END $$;
REVOKE ALL ON FUNCTION generate_overdue_notifications(date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION generate_overdue_notifications(date) TO app_user;

COMMIT;
