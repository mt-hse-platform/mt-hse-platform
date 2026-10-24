// Voice-note helpers (no browser objects here, so they can be tested). The recording itself lives in ui/MediaControls.tsx.
import { MEDIA_RULES } from '../../../../packages/engines/src/media/rules.ts';

export const MAX_RECORD_SECONDS = 300;      // a field note, not a meeting: 5 minutes is about 1.2 MB at this bitrate
export const AUDIO_BITS_PER_SECOND = 32_000;

/** Best first. Every entry is a type the server accepts (its real bytes are checked on upload). */
const PREFERRED = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/ogg'];

/** The recording format this browser can produce (Chrome/Firefox/Android: webm or ogg; Safari/iPhone: mp4). */
export function pickAudioMime(isSupported: (mime: string) => boolean): string | null {
  for (const m of PREFERRED) {
    let ok = false;
    try { ok = isSupported(m); } catch { ok = false; }
    if (ok) return m;
  }
  return null;
}

/** m:ss for the recording timer; anything that is not a sane number shows 0:00. */
export function formatDuration(totalSeconds: number): string {
  const s = Number.isFinite(totalSeconds) && totalSeconds > 0 ? Math.floor(totalSeconds) : 0;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** How many more voice notes this question accepts (the server refuses more). */
export function audioSlotsLeft(existing: number): number {
  return Math.max(0, MEDIA_RULES.audio.maxPerQuestion - Math.max(0, existing));
}

/** Joins the recorded pieces. null when nothing was captured or the result would be refused for its size. */
export function recordedBlob(chunks: Blob[], recorderMime: string, fallbackMime: string): Blob | null {
  const size = chunks.reduce((n, c) => n + c.size, 0);
  if (size === 0 || size > MEDIA_RULES.audio.maxBytes) return null;
  return new Blob(chunks, { type: recorderMime || fallbackMime });
}
