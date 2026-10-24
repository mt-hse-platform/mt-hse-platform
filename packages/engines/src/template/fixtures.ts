// Example template used by tests and documentation: daily safety inspection of a concrete batching plant (bilingual).
import type { TemplateContent } from './types.ts';

export const batchingPlantTemplate = (): TemplateContent => ({
  passThresholdPct: 80,
  pages: [
    {
      id: 'p_general',
      title: { ar: 'عام', en: 'General' },
      items: [
        {
          kind: 'section', id: 's_ppe', title: { ar: 'معدات الوقاية', en: 'PPE' },
          items: [
            {
              kind: 'question', id: 'q_helmet', title: { ar: 'هل الجميع يرتدي الخوذة؟', en: 'Is everyone wearing a helmet?' },
              responseType: 'yes_no_na', required: true, category: 'ppe', scoring: {},
              flagRules: [{ when: { answerIn: ['no'] }, severity: 'high', description: { en: 'Helmet missing' } }],
            },
            {
              kind: 'question', id: 'q_vest', title: { ar: 'هل الجميع يرتدي السترة العاكسة؟', en: 'Is everyone wearing a vest?' },
              responseType: 'yes_no_na', category: 'ppe', scoring: { weight: 2 },
              flagRules: [{ when: { answerIn: ['no'] }, severity: 'medium' }],
            },
            {
              kind: 'question', id: 'q_ppe_type', title: { en: 'Work type' }, responseType: 'multiple_choice',
              options: [{ value: 'general', label: { en: 'General' } }, { value: 'welding', label: { en: 'Welding' } }],
            },
            {
              kind: 'question', id: 'q_welding_screen', title: { en: 'Welding screens in place?' }, responseType: 'yes_no', category: 'ppe',
              scoring: {}, visibleWhen: { questionId: 'q_ppe_type', op: 'eq', value: 'welding' },
              flagRules: [{ when: { answerIn: ['no'] }, severity: 'critical' }],
            },
          ],
        },
      ],
    },
    {
      id: 'p_equipment',
      title: { ar: 'المعدات', en: 'Equipment' },
      items: [
        {
          kind: 'question', id: 'q_fire_ext', title: { en: 'Fire extinguisher inspected?' }, responseType: 'pass_fail_na',
          category: 'fire', scoring: {}, flagRules: [{ when: { answerIn: ['fail'] }, severity: 'critical' }],
        },
        {
          kind: 'question', id: 'q_condition', title: { en: 'Mixer condition' }, responseType: 'good_fair_poor_na',
          scoring: {}, flagRules: [{ when: { scoreBelowPct: 50 }, severity: 'medium' }],
        },
        { kind: 'question', id: 'q_rating', title: { en: 'Housekeeping rating' }, responseType: 'rating', ratingMax: 5, scoring: {} },
        {
          kind: 'question', id: 'q_pressure', title: { en: 'Air pressure (bar)' }, responseType: 'decimal', min: 0, max: 12,
          flagRules: [{ when: { numberGt: 8 }, severity: 'high' }],
        },
        { kind: 'question', id: 'q_hours', title: { en: 'Run hours' }, responseType: 'number', min: 0 },
        { kind: 'question', id: 'q_cost', title: { en: 'Cost per hour' }, responseType: 'decimal', min: 0 },
        { kind: 'question', id: 'q_total', title: { en: 'Total cost' }, responseType: 'formula', formula: '{q_hours} * {q_cost}' },
        {
          kind: 'question', id: 'q_notes', title: { en: 'Describe the problem' }, responseType: 'long_text',
          requiredWhen: { questionId: 'q_condition', op: 'eq', value: 'poor' },
        },
      ],
    },
    {
      id: 'p_emergency',
      title: { en: 'Emergency' },
      visibleWhen: { questionId: 'q_pressure', op: 'gt', value: 8 },
      items: [
        { kind: 'question', id: 'q_emergency_plan', title: { en: 'Emergency plan activated?' }, responseType: 'yes_no', required: true },
      ],
    },
  ],
});
