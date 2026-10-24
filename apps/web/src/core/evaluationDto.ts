export type EvaluationDto = {
  answers: Record<string, unknown>;
  scores: { total: { pct: number | null } };
  flags: { questionId: string; severity: string }[];
};
