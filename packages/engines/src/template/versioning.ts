import type { TemplateContent } from './types.ts';
import { validateTemplate } from './validate.ts';
import type { TemplateIssue } from './validate.ts';

export type TemplateStatus = 'draft' | 'published' | 'archived';
export type VersionStatus = 'draft' | 'published';

export type TemplateVersion = {
  id: string;
  templateId: string;
  versionNo: number;
  status: VersionStatus;
  content: TemplateContent;
  fingerprint: string | null;
  publishedAt: string | null;
  publishedBy: string | null;
};

export const TEMPLATE_STATUS_TRANSITIONS: Record<TemplateStatus, readonly TemplateStatus[]> = {
  draft: ['published'],          // needs a published version (checked by the caller)
  published: ['archived'],
  archived: ['published'],       // restore
};

export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`;
}

function cyrb53(str: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed; let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507); h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507); h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** Content fingerprint (change detector, not a cryptographic signature). Independent of key order. */
export const fingerprintOf = (content: TemplateContent): string => {
  const s = stableStringify(content);
  return `${cyrb53(s).toString(16)}-${s.length.toString(16)}`;
};

export const isEditable = (v: TemplateVersion): boolean => v.status === 'draft';

export type PublishResult = { ok: true; version: TemplateVersion } | { ok: false; issues: TemplateIssue[] };

export function publishVersion(v: TemplateVersion, by: { userId: string; now: string }): PublishResult {
  if (v.status !== 'draft') return { ok: false, issues: [{ code: 'not_draft', path: '' }] };
  const issues = validateTemplate(v.content);
  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    version: { ...v, status: 'published', fingerprint: fingerprintOf(v.content), publishedAt: by.now, publishedBy: by.userId },
  };
}

/** A published version must still match the fingerprint taken at publish time. */
export function verifyIntegrity(v: TemplateVersion): boolean {
  return v.status !== 'published' || (v.fingerprint !== null && v.fingerprint === fingerprintOf(v.content));
}

/** Editing a published template = new draft (deep copy). The published version and its inspections stay untouched. */
export function createDraftFromPublished(v: TemplateVersion, newId: string): TemplateVersion {
  if (v.status !== 'published') throw new Error('Only a published version can be the base of a new draft');
  return {
    id: newId, templateId: v.templateId, versionNo: v.versionNo + 1, status: 'draft',
    content: JSON.parse(JSON.stringify(v.content)) as TemplateContent,
    fingerprint: null, publishedAt: null, publishedBy: null,
  };
}
