import type { Answers, LocalizedText, TemplateContent } from '../template/types.ts';
import type { Flag, ScoreResult } from '../template/scoring.ts';
import type { TemplateState } from '../template/conditions.ts';

export type ReportLink = { id: string; title: string; status: string; priority: string; assigneeName: string | null; dueDate: string | null; questionId: string | null };

export type ReportSignature = { name: string; role?: string; signedAt: string; imageDataUri?: string };
export type ReportPhoto = { dataUri: string; caption: string | null };

export type ReportInput = {
  orgName: string;
  inspection: {
    id: string; title: string | null; status: string; startedAt: string; completedAt: string | null;
    siteName: string | null; startedByName: string;
    scorePct: number | null; scoreEarned: number | null; scorePossible: number | null; passed: boolean | null; flaggedRate: number | null;
  };
  template: { name: LocalizedText; versionNo: number; content: TemplateContent };
  answers: Answers;
  evaluation: { state: TemplateState; scores: ScoreResult; flags: Flag[] };
  /** flags as stored when the inspection was completed, with the issue/action created from each */
  flags: { questionId: string; severity: 'low' | 'medium' | 'high' | 'critical'; issueId: string | null; actionId: string | null }[];
  actions: ReportLink[];
  issues: ReportLink[];
  signatures: ReportSignature[];
  /** photos per question: how many the answer references (`expected`) and the ones that could be loaded */
  media?: Record<string, { expected: number; photos: ReportPhoto[] }>;
  confidential: boolean;
  timeZone?: string; // default Africa/Cairo
};

export type Severity = 'low' | 'medium' | 'high' | 'critical';

export type QuestionRow = { no: number; id: string; title: string; answer: string; unanswered: boolean; scoreText: string | null; severity: Severity | null; photos: ReportPhoto[] };

export type ReportModel = {
  locale: 'ar' | 'en';
  dir: 'rtl' | 'ltr';
  title: string;
  confidential: boolean;
  cover: { orgName: string; title: string; templateName: string; version: number; siteName: string | null; date: string; reportNo: string };
  meta: { label: string; value: string }[];
  summary: {
    pct: number | null; earned: number | null; possible: number | null; result: 'passed' | 'failed' | 'notScored';
    flaggedCount: number; flaggedRate: number | null; actionsCount: number; issuesCount: number;
  };
  pages: { id: string; title: string; blocks: { sectionTitle: string | null; rows: QuestionRow[] }[] }[];
  flagged: { no: number; title: string; answer: string; severity: Severity; links: { kind: 'action' | 'issue'; title: string }[] }[];
  actions: (ReportLink & { statusText: string; priorityText: string })[];
  issues: (ReportLink & { statusText: string; priorityText: string })[];
  signatures: { name: string; role: string | null; signedAt: string; imageDataUri: string | null }[];
};
