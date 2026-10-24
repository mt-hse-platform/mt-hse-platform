import { useCallback, useEffect, useState } from 'react';
import { endpoints, platform } from './platform.ts';
import { LocaleContext } from './i18nReact.tsx';
import { PREFS_KEY, documentAttributes, parsePreferences } from './core/preferences.ts';
import type { Preferences } from './core/preferences.ts';
import type { BootResult } from './core/bootstrap.ts';
import { translate, userMessageKey } from '../../../packages/i18n/src/index.ts';
import type { MessageKey } from '../../../packages/i18n/src/index.ts';
import { ErrorState, LoadingScreen, LoginScreen, VerifyEmailScreen } from './ui/Screens.tsx';
import { UsersPage } from './ui/UsersPage.tsx';
import { NotificationsPage } from './ui/NotificationsPage.tsx';
import { NewWorkPage, WorkDetailPage, WorkListPage } from './ui/WorkPages.tsx';
import { Shell } from './ui/Shell.tsx';
import { HomePage, SettingsPage } from './ui/Pages.tsx';
import { InspectionsPage, NewInspectionPage } from './ui/InspectionsPages.tsx';
import { InspectionPage } from './ui/Runner.tsx';
import { TemplatesPage } from './ui/TemplatesPage.tsx';
import { ReportPage } from './ui/ReportPage.tsx';
import { usePolledNumber, useRoute } from './ui/hooks.ts';
import { ErrorState as NotFound } from './ui/Screens.tsx';
import type { Grant } from '../../../packages/shared/src/permissions.ts';
import { canCreate } from './core/work.ts';
import type { SessionLike } from './core/work.ts';

const loadUnread = async (): Promise<number> => (await endpoints.unreadCount()).count;

function loadPrefs(): Preferences {
  try { return parsePreferences(localStorage.getItem(PREFS_KEY)); } catch { return parsePreferences(null); }
}

export default function App() {
  const [prefs, setPrefs] = useState<Preferences>(loadPrefs);
  const [boot, setBoot] = useState<BootResult | null>(null);
  const [loginError, setLoginError] = useState<MessageKey | null>(null);
  const { route, path, navigate } = useRoute();
  const signedIn = boot?.status === 'ready';
  const unread = usePolledNumber(loadUnread, 60_000, signedIn);

  // Language/direction/theme on <html>: real RTL, not only CSS.
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const a = documentAttributes(prefs, mq.matches);
      const el = document.documentElement;
      el.lang = a.lang; el.dir = a.dir; el.dataset.theme = a.theme;
    };
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [prefs]);

  const changePrefs = (p: Preferences) => {
    setPrefs(p);
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* storage may be unavailable */ }
  };

  const runBoot = useCallback(async () => {
    setBoot(null);
    setBoot(await platform.boot());
  }, []);
  useEffect(() => { void runBoot(); }, [runBoot]);
  useEffect(() => { if (boot?.status === 'ready') { platform.startPhotoQueue(); platform.startOfflineServices(); } }, [boot]);

  async function signUp(email: string, password: string) {
    setLoginError(null);
    try {
      await platform.signUp(email, password);
      await runBoot();
    } catch (err) {
      setLoginError(userMessageKey(err));
    }
  }

  async function signIn(email: string, password: string) {
    setLoginError(null);
    try {
      await platform.signIn(email, password);
      await runBoot();
    } catch (err) {
      setLoginError(userMessageKey(err));
    }
  }

  let screen;
  if (!boot) screen = <LoadingScreen />;
  else if (boot.status === 'signed_out') {
    screen = (
      <LoginScreen onSignIn={signIn} onSignUp={signUp} onReset={(email) => platform.resetPassword(email)}
        errorKey={boot.reason === 'forbidden' ? 'error.permission_denied' : loginError} />
    );
  } else if (boot.status === 'email_unverified') {
    screen = (
      <VerifyEmailScreen email={platform.currentEmail()} onResend={() => platform.resendVerification()}
        onSignOut={async () => { await platform.signOut(); await runBoot(); }}
        onContinue={async () => { await platform.refreshVerification(); const r = await platform.boot(); setBoot(r); return r.status !== 'email_unverified'; }} />
    );
  }
  else if (boot.status === 'org_required') screen = <ErrorState messageKey="error.org_required" onRetry={runBoot} />;
  else if (boot.status === 'error') screen = <ErrorState messageKey={userMessageKey({ code: boot.code })} onRetry={runBoot} />;
  else {
    const { session, offline } = boot;
    const has = (g: Grant[], p: Grant['permission']) => g.some((x) => x.permission === p);
    const me: SessionLike = { userId: session.user.id, orgId: session.orgId, grants: session.grants, siteIds: session.siteIds, name: session.user.fullName };
    let page;
    switch (route.name) {
      case 'settings':
        page = <SettingsPage prefs={prefs} onChange={changePrefs} onSignOut={async () => {
          const waiting = platform.pendingUploads();
          if (waiting > 0 && !window.confirm(translate(prefs.locale, 'media.signOutWarn', { n: waiting }))) return;
          await platform.signOut(); navigate('/'); await runBoot();
        }} />;
        break;
      case 'inspections':
        page = <InspectionsPage canStart={has(session.grants, 'inspection.create')} onOpen={(id) => navigate(`/inspections/${id}`)} onStart={() => navigate('/inspections/new')} />;
        break;
      case 'inspection_new':
        page = <NewInspectionPage userId={session.user.id} onStarted={(id) => navigate(`/inspections/${id}`)} />;
        break;
      case 'inspection':
        page = <InspectionPage key={route.id} id={route.id} signerName={session.user.fullName} onReport={(id) => navigate(`/inspections/${id}/report`)} onBack={() => navigate('/inspections')} />;
        break;
      case 'inspection_report':
        page = <ReportPage id={route.id} onBack={() => navigate(`/inspections/${route.id}`)} />;
        break;
      case 'users':
        page = <UsersPage />;
        break;
      case 'notifications':
        page = <NotificationsPage onOpen={navigate} onChanged={unread.refresh} />;
        break;
      case 'templates':
        page = <TemplatesPage canImport={has(session.grants, 'template.create')} canPublish={has(session.grants, 'template.publish')} />;
        break;
      case 'not_found':
        page = <NotFound messageKey="error.not_found" onRetry={() => navigate('/')} />;
        break;
      case 'actions':
      case 'issues': {
        const kind = route.name === 'actions' ? 'action' : 'issue';
        page = (
          <WorkListPage key={kind} kind={kind} filter={route.filter} canCreateNew={canCreate(kind, me)}
            onOpen={(id) => navigate(`/${kind}s/${id}`)} onNew={() => navigate(`/${kind}s/new`)}
            onFilter={(f) => navigate(f ? `/${kind}s?filter=${f}` : `/${kind}s`)} />
        );
        break;
      }
      case 'action':
      case 'issue': {
        const kind = route.name;
        page = <WorkDetailPage key={route.id} kind={kind} id={route.id} session={me} onBack={() => navigate(`/${kind}s`)} onOpenInspection={(i) => navigate(`/inspections/${i}`)} />;
        break;
      }
      case 'action_new':
        page = <NewWorkPage kind="action" presetType={null} session={me} onCreated={(id) => navigate(`/actions/${id}`)} />;
        break;
      case 'issue_new':
        page = <NewWorkPage kind="issue" presetType={route.type} session={me} onCreated={(id) => navigate(`/issues/${id}`)} />;
        break;
      default:
        page = <HomePage session={session} offline={offline} onNavigate={navigate} />;
    }
    screen = <Shell session={session} offline={offline} current={path} unread={unread.value} onNavigate={navigate}>{page}</Shell>;
  }

  return <LocaleContext.Provider value={prefs.locale}>{screen}</LocaleContext.Provider>;
}
