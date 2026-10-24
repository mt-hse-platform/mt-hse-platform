// Photo / PDF attachments and the signature pad. Photos and PDFs are put in the offline upload queue (they are kept on
// the device and uploaded when there is a connection); the answer of the question is the list of uploaded file ids,
// saved through the normal autosave once the queue has delivered them. The signature still needs a connection.
import { useEffect, useRef, useState } from 'react';
import { endpoints, mediaObjectUrl, photoQueue, uploadMedia } from '../platform.ts';
import { useT } from '../i18nReact.tsx';
import { JPEG_QUALITY, MAX_PHOTO_EDGE, fitWithin, idsOf, uploadError, withId, withoutId } from '../core/media.ts';
import type { MediaMessage } from '../core/media.ts';
import { isLocalId } from '../core/photoQueue.ts';
import { AUDIO_BITS_PER_SECOND, MAX_RECORD_SECONDS, audioSlotsLeft, formatDuration, pickAudioMime, recordedBlob } from '../core/audio.ts';
import type { QueueItem } from '../core/photoQueue.ts';
import type { Question } from '../../../../packages/engines/src/template/types.ts';

/** Shrinks a camera photo to a JPEG that fits MAX_PHOTO_EDGE. */
async function compressImage(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const { width, height } = fitWithin(bitmap.width, bitmap.height, MAX_PHOTO_EDGE);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no canvas');
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  return new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('compress failed'))), 'image/jpeg', JPEG_QUALITY));
}

function Problem({ msg }: { msg: MediaMessage | null }) {
  const t = useT();
  return msg ? <div className="error-text" role="alert">⚠ {t(msg.key, msg.params)}</div> : null;
}

/** Files of this question that are still on the device. Re-renders whenever the queue changes. */
function useQueued(inspectionId: string, questionId: string): QueueItem[] {
  const [, force] = useState(0);
  useEffect(() => photoQueue.subscribe(() => force((n) => n + 1)), []);
  return photoQueue.forQuestion(inspectionId, questionId);
}

function QueuedThumb({ item, disabled }: { item: QueueItem; disabled: boolean }) {
  const t = useT();
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (item.kind === 'file') return;
    let alive = true;
    let made: string | null = null;
    photoQueue.getBlob(item.id).then((b) => {
      if (!b) return;
      made = URL.createObjectURL(b);
      if (alive) setUrl(made); else URL.revokeObjectURL(made);
    }, () => undefined);
    return () => { alive = false; if (made) URL.revokeObjectURL(made); };
  }, [item.id]);
  return (
    <div className="thumb thumb-queued">
      {item.kind === 'photo' && url ? <img src={url} alt="" /> : item.kind === 'audio' && url ? <audio controls src={url} /> : <span className="thumb-file">{item.kind === 'file' ? 'PDF' : '…'}</span>}
      {item.failed
        ? <div className="error-text" role="alert">⚠ {t(item.failed.key, item.failed.params)}</div>
        : <span className="muted">⏳ {t('media.queueWaiting')}</span>}
      <div className="choice-row">
        {item.failed && <button type="button" className="link-btn" disabled={disabled} onClick={() => void photoQueue.retry(item.id)}>{t('media.retry')}</button>}
        <button type="button" className="link-btn" disabled={disabled} onClick={() => void photoQueue.discard(item.id)}>{t('media.remove')}</button>
      </div>
    </div>
  );
}

/** UNTESTED (needs a microphone and a browser): records a voice note and hands the finished file to the caller. */
function AudioRecorder({ disabled, full, onRecorded, onProblem }: {
  disabled: boolean; full: boolean; onRecorded: (blob: Blob) => Promise<void>; onProblem: (m: MediaMessage | null) => void;
}) {
  const t = useT();
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const live = useRef<{ recorder: MediaRecorder; stream: MediaStream; chunks: Blob[]; timer: ReturnType<typeof setInterval> | null; discard: boolean } | null>(null);

  async function start() {
    onProblem(null);
    const mime = typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia
      ? null : pickAudioMime((m) => MediaRecorder.isTypeSupported(m));
    if (!mime) { onProblem({ key: 'media.micUnsupported' }); return; }
    let stream: MediaStream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch { onProblem({ key: 'media.micDenied' }); return; }
    const recorder = new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: AUDIO_BITS_PER_SECOND });
    const state = { recorder, stream, chunks: [] as Blob[], timer: null as ReturnType<typeof setInterval> | null, discard: false };
    recorder.ondataavailable = (e) => { if (e.data.size > 0) state.chunks.push(e.data); };
    recorder.onstop = () => {
      if (state.timer) clearInterval(state.timer);
      stream.getTracks().forEach((tr) => tr.stop());            // releases the microphone (the browser's recording indicator goes off)
      live.current = null;
      setRecording(false);
      if (state.discard) return;
      const blob = recordedBlob(state.chunks, recorder.mimeType, mime);
      if (blob) void onRecorded(blob); else onProblem({ key: 'media.recordEmpty' });
    };
    recorder.start(1000);                                       // pieces arrive every second, not only at the end
    let elapsed = 0;
    state.timer = setInterval(() => {
      elapsed += 1;
      setSeconds(elapsed);
      if (elapsed >= MAX_RECORD_SECONDS && recorder.state !== 'inactive') recorder.stop();
    }, 1000);
    live.current = state;
    setSeconds(0);
    setRecording(true);
  }

  function stop() { const r = live.current; if (r && r.recorder.state !== 'inactive') r.recorder.stop(); }

  // leaving the screen while recording throws the recording away and frees the microphone
  useEffect(() => () => {
    const r = live.current;
    if (r) { r.discard = true; if (r.recorder.state !== 'inactive') r.recorder.stop(); }
  }, []);

  return (
    <div className="stack">
      {recording
        ? <button type="button" className="btn btn-danger" onClick={stop}>■ {t('media.stopRecording', { time: formatDuration(seconds) })}</button>
        : <button type="button" className={`btn ${disabled ? 'btn-disabled' : ''}`} disabled={disabled} onClick={() => void start()}>🎤 {t('media.record')}</button>}
      {full && !recording && <span className="muted">{t('media.audioFull', { n: audioSlotsLeft(0) })}</span>}
    </div>
  );
}

export function AttachmentControl({ q, kind, value, disabled, inspectionId, onChange }: {
  q: Question; kind: 'photo' | 'file' | 'audio'; value: unknown; disabled: boolean; inspectionId: string; onChange: (v: unknown) => void;
}) {
  const t = useT();
  const ids = idsOf(value).filter((id) => !isLocalId(id));   // uploaded files; waiting ones are shown from the queue
  const queued = useQueued(inspectionId, q.id);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<MediaMessage | null>(null);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const urlsRef = useRef<Record<string, string>>({});
  urlsRef.current = urls;

  useEffect(() => {
    if (kind === 'file') return;
    let alive = true;
    for (const id of ids) {
      if (id in urlsRef.current) continue;
      mediaObjectUrl(id).then(
        (u) => { if (alive) setUrls((prev) => ({ ...prev, [id]: u })); else URL.revokeObjectURL(u); },
        () => undefined,
      );
    }
    return () => { alive = false; };
  }, [ids.join(',')]);
  useEffect(() => () => { for (const u of Object.values(urlsRef.current)) URL.revokeObjectURL(u); }, []);

  async function pick(files: FileList | null) {
    if (!files || files.length === 0) return;
    setProblem(null);
    setBusy(true);                                            // only while shrinking/saving on the device: no connection needed
    try {
      for (const file of Array.from(files)) {
        const blob = kind === 'photo' ? await compressImage(file) : file;
        await photoQueue.enqueue({ inspectionId, questionId: q.id, kind, blob, takenAt: new Date().toISOString() });
      }
    } catch (e) {
      setProblem(uploadError(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setProblem(null);
    if (!navigator.onLine) { setProblem({ key: 'media.needsConnection' }); return; }   // deleting an uploaded file needs the server
    try { await endpoints.deleteMedia(id); onChange(withoutId(value, id)); } catch (e) { setProblem(uploadError(e)); }
  }

  return (
    <div className="stack">
      <div className="thumbs">
        {ids.map((id) => (
          <div key={id} className="thumb">
            {kind === 'photo' && urls[id] ? <img src={urls[id]} alt="" /> : kind === 'audio' && urls[id] ? <audio controls src={urls[id]} /> : <span className="thumb-file">{kind === 'file' ? 'PDF' : '…'}</span>}
            <button type="button" className="link-btn" disabled={disabled || busy} onClick={() => void remove(id)}>{t('media.remove')}</button>
          </div>
        ))}
        {queued.map((item) => <QueuedThumb key={item.id} item={item} disabled={disabled} />)}
      </div>
      {kind === 'audio' ? (
        <AudioRecorder disabled={disabled || busy || audioSlotsLeft(ids.length + queued.length) === 0} full={audioSlotsLeft(ids.length + queued.length) === 0}
          onProblem={setProblem}
          onRecorded={async (blob) => { try { await photoQueue.enqueue({ inspectionId, questionId: q.id, kind: 'audio', blob, takenAt: new Date().toISOString() }); } catch (e) { setProblem(uploadError(e)); } }} />
      ) : (
      <label className={`btn ${disabled || busy ? 'btn-disabled' : ''}`}>
        {busy ? t('media.uploading') : t(kind === 'photo' ? 'media.addPhoto' : 'media.addFile')}
        <input className="visually-hidden" type="file" multiple disabled={disabled || busy}
          accept={kind === 'photo' ? 'image/*' : 'application/pdf'} capture={kind === 'photo' ? 'environment' : undefined}
          onChange={(e) => { void pick(e.target.files); e.target.value = ''; }} />
      </label>
      )}
      <Problem msg={problem} />
    </div>
  );
}

export function SignatureControl({ q, value, disabled, inspectionId, signerName, onChange }: {
  q: Question; value: unknown; disabled: boolean; inspectionId: string; signerName: string; onChange: (v: unknown) => void;
}) {
  const t = useT();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawing = useRef(false);
  const strokes = useRef(0);
  const [name, setName] = useState(signerName);
  const [role, setRole] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<MediaMessage | null>(null);
  const [signedUrl, setSignedUrl] = useState<string | null>(null);
  const signedId = typeof value === 'string' && value !== '' ? value : null;

  useEffect(() => {
    if (!signedId) { setSignedUrl(null); return; }
    let url: string | null = null;
    let alive = true;
    mediaObjectUrl(signedId).then((u) => { url = u; if (alive) setSignedUrl(u); else URL.revokeObjectURL(u); }, () => undefined);
    return () => { alive = false; if (url) URL.revokeObjectURL(url); };
  }, [signedId]);

  const point = (e: { clientX: number; clientY: number }) => {
    const c = canvasRef.current!;
    const r = c.getBoundingClientRect();
    return { x: (e.clientX - r.left) * (c.width / r.width), y: (e.clientY - r.top) * (c.height / r.height) };
  };
  function start(e: { clientX: number; clientY: number; pointerId: number; preventDefault: () => void }) {
    const c = canvasRef.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx || disabled) return;
    e.preventDefault();
    c.setPointerCapture(e.pointerId);
    drawing.current = true;
    strokes.current++;
    const p = point(e);
    ctx.lineWidth = 3; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#000';
    ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x + 0.1, p.y + 0.1); ctx.stroke();
  }
  function move(e: { clientX: number; clientY: number }) {
    const ctx = canvasRef.current?.getContext('2d');
    if (!drawing.current || !ctx) return;
    const p = point(e);
    ctx.lineTo(p.x, p.y); ctx.stroke();
  }
  const stop = () => { drawing.current = false; };
  function clear() {
    const c = canvasRef.current;
    c?.getContext('2d')?.clearRect(0, 0, c.width, c.height);
    strokes.current = 0;
    setProblem(null);
  }

  async function save() {
    const c = canvasRef.current;
    if (!c) return;
    setProblem(null);
    if (strokes.current === 0) { setProblem({ key: 'sign.empty' }); return; }
    if (!navigator.onLine) { setProblem({ key: 'media.needsConnection' }); return; }
    setBusy(true);
    try {
      const blob = await new Promise<Blob>((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('png failed'))), 'image/png'));
      const media = await uploadMedia({ ownerType: 'inspection', ownerId: inspectionId, kind: 'signature', questionId: q.id }, blob);
      await endpoints.addSignature(inspectionId, { mediaId: media.id, signerName: name.trim(), signerRole: role.trim() || undefined });
      onChange(media.id);
    } catch (e) {
      setProblem(uploadError(e));
    } finally {
      setBusy(false);
    }
  }

  if (signedId) {
    return (
      <div className="stack">
        <div className="notice notice-success">✓ {t('sign.done')}</div>
        {signedUrl && <img className="sig-preview" src={signedUrl} alt={t('sign.title')} />}
      </div>
    );
  }

  return (
    <div className="stack">
      <p className="muted">{t('sign.draw')}</p>
      <canvas ref={canvasRef} className="sig-canvas" width={600} height={200}
        onPointerDown={start} onPointerMove={move} onPointerUp={stop} onPointerCancel={stop} />
      <label className="field"><span>{t('sign.name')}</span>
        <input type="text" maxLength={200} value={name} disabled={disabled || busy} onChange={(e) => setName(e.target.value)} /></label>
      <label className="field"><span>{t('sign.role')}</span>
        <input type="text" maxLength={100} value={role} disabled={disabled || busy} onChange={(e) => setRole(e.target.value)} /></label>
      <Problem msg={problem} />
      <div className="choice-row">
        <button type="button" className="btn btn-primary" disabled={disabled || busy || name.trim().length < 2} onClick={() => void save()}>{busy ? t('media.uploading') : t('sign.save')}</button>
        <button type="button" className="btn" disabled={disabled || busy} onClick={clear}>{t('sign.clear')}</button>
      </div>
    </div>
  );
}
