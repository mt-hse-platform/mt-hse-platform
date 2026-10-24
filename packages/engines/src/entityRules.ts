// Field rules for creating Issues and Actions, expressed for the shared Validation Engine.
import { ACTION_TYPES, ISSUE_TYPES, PRIORITIES } from './workflow.ts';
import type { FieldRule } from './validation.ts';

/** `today` (YYYY-MM-DD) so a due date can't be in the past when creating. */
export function issueCreateRules(today: string): Record<string, FieldRule> {
  return {
    title: { type: 'text', required: true, minLength: 3, maxLength: 200 },
    description: { type: 'long_text', maxLength: 5000 },
    type: { type: 'single_select', required: true, options: [...ISSUE_TYPES] },
    priority: { type: 'single_select', required: true, options: [...PRIORITIES] },
    dueDate: { type: 'date', minDate: today },
  };
}

export function actionCreateRules(today: string): Record<string, FieldRule> {
  return {
    title: { type: 'text', required: true, minLength: 3, maxLength: 200 },
    description: { type: 'long_text', maxLength: 5000 },
    type: { type: 'single_select', required: true, options: [...ACTION_TYPES] },
    priority: { type: 'single_select', required: true, options: [...PRIORITIES] },
    dueDate: { type: 'date', minDate: today },
  };
}
