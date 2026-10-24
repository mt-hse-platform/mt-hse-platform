// Client-side helpers for attachments: photo sizing, answer <-> media ids, upload address and readable errors.
import { ApiError, NetworkError } from './apiClient.ts';
import type { MessageKey } from '../../../../packages/i18n/src/index.ts';
import { userMessageKey } from '../../../../packages/i18n/src/index.ts';

export const MAX_PHOTO_EDGE = 1600;   // phone photos are 4000+ px: shrinking keeps uploads fast and reports light
export const JPEG_QUALITY = 0.8;

/** Fits the image inside a maxEdge x maxEdge box, keeping the proportions, never enlarging. */
export function fitWithin(width: number, height: number, maxEdge: number): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxEdge || longest <= 0) return { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) };
  const k = maxEdge / longest;
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) };
}

/** The answer of a photo/file question is a list of media ids. Anything else is treated as "no files". */
export function idsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string' && x !== '') : [];
}
export const withId = (value: unknown, id: string): string[] => [...new Set([...idsOf(value), id])];
/** Returns null when nothing is left, so the answer becomes "not answered". */
export function withoutId(value: unknown, id: string): string[] | null {
  const rest = idsOf(value).filter((x) => x !== id);
  return rest.length ? rest : null;
}

export type UploadParams = {
  ownerType: 'inspection' | 'issue' | 'action';
  ownerId: string;
  kind: 'photo' | 'audio' | 'file' | 'signature';
  questionId?: string;
  caption?: string;
  takenAt?: string;
  lat?: number;
  lng?: number;
};

export function uploadPath(p: UploadParams): string {
  const q = new URLSearchParams({ ownerType: p.ownerType, ownerId: p.ownerId, kind: p.kind });
  if (p.questionId) q.set('questionId', p.questionId);
  if (p.caption) q.set('caption', p.caption);
  if (p.takenAt) q.set('takenAt', p.takenAt);
  if (p.lat !== undefined) q.set('lat', String(p.lat));
  if (p.lng !== undefined) q.set('lng', String(p.lng));
  return `/media?${q.toString()}`;
}

export type MediaMessage = { key: MessageKey; params?: Record<string, number | string> };

/** Turns an upload failure into a message the person can act on. */
export function uploadError(err: unknown): MediaMessage {
  if (err instanceof NetworkError) return { key: 'media.needsConnection' };
  if (err instanceof ApiError) {
    if (err.status === 413) return { key: 'validation.file_too_large', params: { maxMb: 15 } };
    const first = (err.details as { file?: { code?: string; params?: Record<string, number | string> }[] } | undefined)?.file?.[0];
    if (err.code === 'validation' && first?.code) {
      const key = `validation.${first.code}` as MessageKey;
      if (['validation.file_type', 'validation.file_too_large', 'validation.too_many_selections', 'validation.required'].includes(key)) return { key, params: first.params };
    }
  }
  return { key: userMessageKey(err) };
}
