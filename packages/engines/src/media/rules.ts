// What may be uploaded: allowed kinds, size limits, and content sniffing (the file's real bytes decide, never the
// name or the header the client sent).
export type MediaKind = 'photo' | 'audio' | 'file' | 'signature';
export const MEDIA_KINDS: readonly MediaKind[] = ['photo', 'audio', 'file', 'signature'];

export const MEDIA_RULES: Record<MediaKind, { mimes: readonly string[]; maxBytes: number; maxPerQuestion: number }> = {
  photo: { mimes: ['image/jpeg', 'image/png', 'image/webp'], maxBytes: 8 * 1024 * 1024, maxPerQuestion: 20 },
  signature: { mimes: ['image/png'], maxBytes: 1024 * 1024, maxPerQuestion: 5 },
  audio: { mimes: ['audio/mpeg', 'audio/mp4', 'audio/webm', 'audio/ogg'], maxBytes: 15 * 1024 * 1024, maxPerQuestion: 5 },
  file: { mimes: ['application/pdf'], maxBytes: 15 * 1024 * 1024, maxPerQuestion: 10 },
};

export const MAX_UPLOAD_BYTES = Math.max(...Object.values(MEDIA_RULES).map((r) => r.maxBytes));

const startsWith = (b: Uint8Array, sig: number[], offset = 0) => sig.every((x, i) => b[offset + i] === x);
const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.slice(from, to));

/** Detects the real type from the first bytes. Returns null when the content is not an allowed type. */
export function sniffMime(b: Uint8Array): string | null {
  if (b.length < 12) return null;
  if (startsWith(b, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP') return 'image/webp';
  if (ascii(b, 0, 5) === '%PDF-') return 'application/pdf';
  if (ascii(b, 4, 8) === 'ftyp') return 'audio/mp4'; // m4a / mp4 container
  if (ascii(b, 0, 3) === 'ID3' || (b[0] === 0xff && (b[1]! & 0xe0) === 0xe0)) return 'audio/mpeg';
  if (ascii(b, 0, 4) === 'OggS') return 'audio/ogg';
  if (startsWith(b, [0x1a, 0x45, 0xdf, 0xa3])) return 'audio/webm';
  return null;
}

export type UploadCheck =
  | { ok: true; mime: string }
  | { ok: false; code: 'invalid_kind' | 'empty' | 'too_large' | 'unsupported_type' | 'type_mismatch' };

export function checkUpload(kind: string, declaredMime: string, bytes: Uint8Array): UploadCheck {
  const rule = (MEDIA_RULES as Record<string, (typeof MEDIA_RULES)[MediaKind]>)[kind];
  if (!rule) return { ok: false, code: 'invalid_kind' };
  if (bytes.length === 0) return { ok: false, code: 'empty' };
  if (bytes.length > rule.maxBytes) return { ok: false, code: 'too_large' };
  const real = sniffMime(bytes);
  if (!real || !rule.mimes.includes(real)) return { ok: false, code: 'unsupported_type' };
  const declared = declaredMime.split(';')[0]!.trim().toLowerCase();
  if (declared !== real) return { ok: false, code: 'type_mismatch' };
  return { ok: true, mime: real };
}

export const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf',
  'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/ogg': 'ogg', 'audio/webm': 'webm',
};
