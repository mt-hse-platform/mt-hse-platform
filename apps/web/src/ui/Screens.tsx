import { useState } from 'react';
import type { FormEvent } from 'react';
import { useT } from '../i18nReact.tsx';
import type { MessageKey } from '../../../../packages/i18n/src/index.ts';

export function LoadingScreen() {
  const t = useT();
  return (
    <div className="center-screen" role="status" aria-live="polite">
      <div className="skeleton skeleton-logo" />
      <p className="muted">{t('common.loading')}</p>
    </div>
  );
}

export function ErrorState({ messageKey, onRetry }: { messageKey: MessageKey; onRetry: () => void }) {
  const t = useT();
  return (
    <div className="center-screen" role="alert">
      <div className="empty-icon" aria-hidden="true">!</div>
      <h2>{t('app.name')}</h2>
      <p>{t(messageKey)}</p>
      <button className="btn btn-primary" onClick={onRetry}>{t('common.retry')}</button>
    </div>
  );
}

type Mode = 'signin' | 'signup' | 'reset';

export function LoginScreen({
  onSignIn, onSignUp, onReset, errorKey,
}: {
  onSignIn: (email: string, password: string) => Promise<void>;
  onSignUp: (email: string, password: string) => Promise<void>;
  onReset: (email: string) => Promise<void>;
  errorKey: MessageKey | null;
}) {
  const t = useT();
  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<MessageKey | null>(null);
  const [info, setInfo] = useState<MessageKey | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setLocalError(null);
    setInfo(null);
    if (mode === 'signup' && password.length < 8) { setLocalError('login.passwordShort'); return; }
    setBusy(true);
    try {
      if (mode === 'signin') await onSignIn(email, password);
      else if (mode === 'signup') await onSignUp(email, password);
      else { await onReset(email); setInfo('login.resetSent'); }
    } finally {
      setBusy(false);
    }
  }

  const shown = localError ?? (mode === 'signin' || mode === 'signup' ? errorKey : null);
  const title: MessageKey = mode === 'signup' ? 'login.createAccount' : mode === 'reset' ? 'login.forgot' : 'login.title';
  const submitLabel: MessageKey = mode === 'signup' ? 'login.createAccount' : mode === 'reset' ? 'login.sendReset' : 'login.submit';

  return (
    <main className="center-screen">
      <form className="card login-card" onSubmit={submit}>
        <h1>{t('app.name')}</h1>
        <h2 className="muted">{t(title)}</h2>
        {mode === 'signup' && <p className="muted">{t('login.signUpNote')}</p>}
        <label className="field">
          <span>{t('login.email')}</span>
          <input type="email" autoComplete="username" inputMode="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        {mode !== 'reset' && (
          <label className="field">
            <span>{t('login.password')}</span>
            <input type="password" autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} required minLength={mode === 'signup' ? 8 : undefined}
              value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
        )}
        {shown && <p className="error-text" role="alert">⚠ {t(shown)}</p>}
        {info && <p className="muted" role="status">{t(info)}</p>}
        <button className="btn btn-primary btn-block" type="submit" disabled={busy}>
          {busy ? t('login.submitting') : t(submitLabel)}
        </button>
        <div className="stack">
          {mode !== 'signin' && <button type="button" className="link-btn" onClick={() => { setMode('signin'); setLocalError(null); setInfo(null); }}>{t('login.haveAccount')}</button>}
          {mode === 'signin' && <button type="button" className="link-btn" onClick={() => setMode('signup')}>{t('login.createAccount')}</button>}
          {mode === 'signin' && <button type="button" className="link-btn" onClick={() => setMode('reset')}>{t('login.forgot')}</button>}
        </div>
      </form>
    </main>
  );
}

export function VerifyEmailScreen({
  email, onResend, onContinue, onSignOut,
}: { email: string; onResend: () => Promise<void>; onContinue: () => Promise<boolean>; onSignOut: () => void }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<MessageKey | null>(null);

  async function resend() {
    setBusy(true);
    try { await onResend(); setMsg('verify.sent'); } catch { setMsg('error.unknown'); } finally { setBusy(false); }
  }
  async function cont() {
    setBusy(true);
    try { const ok = await onContinue(); if (!ok) setMsg('verify.stillNot'); } catch { setMsg('error.unknown'); } finally { setBusy(false); }
  }

  return (
    <main className="center-screen">
      <div className="card login-card stack">
        <h1>{t('verify.title')}</h1>
        <p>{t('verify.body', { email })}</p>
        {msg && <p className="muted" role="status">{t(msg)}</p>}
        <button className="btn btn-primary btn-block" disabled={busy} onClick={() => void cont()}>{t('verify.continue')}</button>
        <button className="btn btn-block" disabled={busy} onClick={() => void resend()}>{t('verify.resend')}</button>
        <button className="link-btn" onClick={onSignOut}>{t('settings.sign_out')}</button>
      </div>
    </main>
  );
}
