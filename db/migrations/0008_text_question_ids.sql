-- MT-HSE-Platform — migration 0008: question ids are TEXT (e.g. 'q_helmet'), not uuid.
-- Migration 0002 declared issues.question_id and actions.question_id as uuid, but template question ids are short
-- text ids (inspection_responses, inspection_flags and media already use text). Creating an action or issue from a
-- flagged inspection item failed with "invalid input syntax for type uuid". Same format rule as inspection_responses.
BEGIN;

ALTER TABLE issues  ALTER COLUMN question_id TYPE text USING question_id::text;
ALTER TABLE actions ALTER COLUMN question_id TYPE text USING question_id::text;

ALTER TABLE issues  ADD CONSTRAINT issues_question_id_format
  CHECK (question_id IS NULL OR question_id ~ '^[A-Za-z0-9_-]{1,64}$');
ALTER TABLE actions ADD CONSTRAINT actions_question_id_format
  CHECK (question_id IS NULL OR question_id ~ '^[A-Za-z0-9_-]{1,64}$');

COMMIT;
