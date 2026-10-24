import { useT } from '../i18nReact.tsx';
import { endpoints } from '../platform.ts';
import { ErrorNotice, LoadingBlock } from './common.tsx';
import { useLoad } from './hooks.ts';
import { dashboardCards } from '../core/work.ts';
import { ResumeCard } from './ResumeCard.tsx';
import type { Session } from '../core/session.ts';
import type { Preferences, ThemePref } from '../core/preferences.ts';

export function HomePage({ session, offline, onNavigate }: { session: Session; offline: boolean; onNavigate: (path: string) => void }) {
  const t = useT();
  const dash = useLoad(() => endpoints.dashboard(), []);
  const cards = dash.data ? dashboardCards(dash.data) : [];
  return (
    <section className="stack">
      <div className="card">
        <h1>{t('home.welcome', { name: session.user.fullName })}</h1>
        <p className="muted">{session.user.email}</p>
        <p>{offline ? '⚠ ' + t('conn.offline_session') : '✓ ' + t('conn.online')}</p>
      </div>
      <ResumeCard userId={session.user.id} onOpen={(id) => onNavigate(`/inspections/${id}`)} />
      <h2>{t('dash.title')}</h2>
      {dash.error ? <ErrorNotice error={dash.error} onRetry={dash.reload} /> : null}
      {dash.loading && !dash.data && <LoadingBlock />}
      <div className="kpi-grid">
        {cards.map((c) => (
          <button key={c.id} className={`kpi kpi-${c.tone}`} onClick={() => onNavigate(c.target)}>
            <span className="kpi-value"><bdi>{c.value}</bdi></span>
            <span className="kpi-label">{t(c.labelKey)}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

export function SettingsPage({
  prefs, onChange, onSignOut,
}: { prefs: Preferences; onChange: (p: Preferences) => void; onSignOut: () => void }) {
  const t = useT();
  return (
    <section className="stack">
      <h1>{t('settings.title')}</h1>
      <div className="card stack">
        <label className="field">
          <span>{t('settings.language')}</span>
          <select value={prefs.locale} onChange={(e) => onChange({ ...prefs, locale: e.target.value as Preferences['locale'] })}>
            <option value="ar">العربية</option>
            <option value="en">English</option>
          </select>
        </label>
        <label className="field">
          <span>{t('settings.theme')}</span>
          <select value={prefs.theme} onChange={(e) => onChange({ ...prefs, theme: e.target.value as ThemePref })}>
            <option value="dark">{t('settings.theme_dark')}</option>
            <option value="light">{t('settings.theme_light')}</option>
            <option value="system">{t('settings.theme_system')}</option>
          </select>
        </label>
      </div>
      <button className="btn btn-danger" onClick={onSignOut}>{t('settings.sign_out')}</button>
    </section>
  );
}
