// Administrators: invite people, change roles/sites, deactivate or reactivate accounts.
import { useState } from 'react';
import { endpoints } from '../platform.ts';
import { useT } from '../i18nReact.tsx';
import { Badge, ErrorNotice, LoadingBlock } from './common.tsx';
import { useLoad } from './hooks.ts';
import type { InvitationDto, MemberDto, RoleDto, SiteDto } from '../core/types.ts';

function SitePicker({ sites, value, onChange }: { sites: SiteDto[]; value: string[]; onChange: (v: string[]) => void }) {
  const t = useT();
  if (sites.length === 0) return <div className="muted">{t('users.noSites')}</div>;
  return (
    <div className="choice-row" role="group">
      {sites.map((s) => {
        const on = value.includes(s.id);
        return (
          <button key={s.id} type="button" role="checkbox" aria-checked={on} className={`choice ${on ? 'selected' : ''}`}
            onClick={() => onChange(on ? value.filter((x) => x !== s.id) : [...value, s.id])}>
            {on ? '✓ ' : ''}{s.name}
          </button>
        );
      })}
    </div>
  );
}

function InviteForm({ roles, sites, onCreated }: { roles: RoleDto[]; sites: SiteDto[]; onCreated: () => void }) {
  const t = useT();
  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('');
  const [roleId, setRoleId] = useState(roles.find((r) => r.key === 'inspector')?.id ?? roles[0]?.id ?? '');
  const [siteIds, setSiteIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState(false);

  async function send() {
    setBusy(true); setError(null); setDone(false);
    try {
      await endpoints.inviteUser({ email: email.trim(), fullName: fullName.trim(), roleId, siteIds });
      setEmail(''); setFullName(''); setSiteIds([]); setDone(true);
      onCreated();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card stack">
      <h2>{t('users.invite')}</h2>
      <p className="muted">{t('users.inviteHint')}</p>
      <label className="field"><span>{t('users.email')}</span>
        <input type="email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
      <label className="field"><span>{t('users.fullName')}</span>
        <input type="text" maxLength={200} value={fullName} onChange={(e) => setFullName(e.target.value)} /></label>
      <label className="field"><span>{t('users.role')}</span>
        <select value={roleId} onChange={(e) => setRoleId(e.target.value)}>
          {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select></label>
      <div><b>{t('users.sites')}</b><SitePicker sites={sites} value={siteIds} onChange={setSiteIds} /></div>
      {error ? <ErrorNotice error={error} /> : null}
      {done && <div className="notice notice-success">✓ {t('users.inviteCreated')}</div>}
      <button className="btn btn-primary" disabled={busy || !email.trim() || fullName.trim().length < 2 || !roleId} onClick={() => void send()}>
        {busy ? t('common.loading') : t('users.send')}
      </button>
    </div>
  );
}

function MemberCard({ member, roles, sites, onChanged }: { member: MemberDto; roles: RoleDto[]; sites: SiteDto[]; onChanged: () => void }) {
  const t = useT();
  const [roleId, setRoleId] = useState(member.roleId);
  const [siteIds, setSiteIds] = useState<string[]>(member.siteIds);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const dirty = roleId !== member.roleId || [...siteIds].sort().join() !== [...member.siteIds].sort().join();
  const locked = member.roleKey === 'super_admin';

  async function apply(body: { roleId?: string; status?: 'active' | 'inactive'; siteIds?: string[] }) {
    setBusy(true); setError(null);
    try { await endpoints.updateMember(member.membershipId, { version: member.version, ...body }); onChanged(); }
    catch (e) { setError(e); } finally { setBusy(false); }
  }

  return (
    <li className="card stack">
      <div className="row-between">
        <span className="list-main"><b><bdi>{member.fullName}</bdi></b><span className="muted"><bdi>{member.email}</bdi></span></span>
        <Badge tone={member.status === 'active' ? 'success' : 'neutral'}>{member.status === 'active' ? t('users.active') : t('users.inactive')}</Badge>
      </div>
      {!locked && (
        <>
          <label className="field"><span>{t('users.role')}</span>
            <select value={roleId} onChange={(e) => setRoleId(e.target.value)} disabled={busy}>
              {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              {!roles.some((r) => r.id === member.roleId) && <option value={member.roleId}>{member.roleName}</option>}
            </select></label>
          <div><b>{t('users.sites')}</b><SitePicker sites={sites} value={siteIds} onChange={setSiteIds} /></div>
          {error ? <ErrorNotice error={error} /> : null}
          <div className="choice-row">
            <button className="btn btn-primary" disabled={busy || !dirty} onClick={() => void apply({ roleId, siteIds })}>{t('users.save')}</button>
            {member.status === 'active'
              ? <button className="btn btn-danger" disabled={busy} onClick={() => void apply({ status: 'inactive' })}>{t('users.deactivate')}</button>
              : <button className="btn" disabled={busy} onClick={() => void apply({ status: 'active' })}>{t('users.reactivate')}</button>}
          </div>
        </>
      )}
    </li>
  );
}

function InvitationRow({ inv, onChanged }: { inv: InvitationDto; onChanged: () => void }) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function revoke() {
    setBusy(true); setError(null);
    try { await endpoints.revokeInvitation(inv.id); onChanged(); } catch (e) { setError(e); } finally { setBusy(false); }
  }
  return (
    <li className="card stack">
      <div className="row-between">
        <span className="list-main"><b><bdi>{inv.fullName}</bdi></b><span className="muted"><bdi>{inv.email}</bdi></span></span>
        <Badge tone="info">{inv.roleName}</Badge>
      </div>
      {error ? <ErrorNotice error={error} /> : null}
      <button className="btn" disabled={busy} onClick={() => void revoke()}>{t('users.revoke')}</button>
    </li>
  );
}

function SitesCard({ sites, onCreated }: { sites: SiteDto[]; onCreated: () => void }) {
  const t = useT();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function add() {
    setBusy(true); setError(null);
    try { await endpoints.createSite(name.trim()); setName(''); onCreated(); } catch (e) { setError(e); } finally { setBusy(false); }
  }

  return (
    <div className="card stack">
      <h2>{t('sites.title')}</h2>
      {sites.length === 0 ? <p className="muted">{t('sites.empty')}</p> : (
        <div className="choice-row">{sites.map((s) => <span key={s.id} className="chip chip-neutral"><bdi>{s.name}</bdi></span>)}</div>
      )}
      <label className="field"><span>{t('sites.name')}</span>
        <input type="text" maxLength={200} value={name} onChange={(e) => setName(e.target.value)} /></label>
      {error ? <ErrorNotice error={error} /> : null}
      <button className="btn" disabled={busy || name.trim().length < 2} onClick={() => void add()}>{busy ? t('common.loading') : t('sites.add')}</button>
    </div>
  );
}

export function UsersPage() {
  const t = useT();
  const data = useLoad(async () => {
    const [users, roles, sites] = await Promise.all([endpoints.listUsers(), endpoints.listRoles(), endpoints.listSites()]);
    return { users, roles: roles.items, sites: sites.items };
  }, []);

  if (data.loading && !data.data) return <LoadingBlock />;
  if (data.error || !data.data) return <ErrorNotice error={data.error} onRetry={data.reload} />;
  const { users, roles, sites } = data.data;

  return (
    <section className="stack">
      <h1>{t('users.title')}</h1>
      <SitesCard sites={sites} onCreated={data.reload} />
      <InviteForm key={sites.length} roles={roles} sites={sites} onCreated={data.reload} />
      {users.invitations.length > 0 && (
        <>
          <h2>{t('users.pending')}</h2>
          <ul className="list">{users.invitations.map((i) => <InvitationRow key={i.id} inv={i} onChanged={data.reload} />)}</ul>
        </>
      )}
      <h2>{t('users.members')}</h2>
      <ul className="list">
        {users.members.map((m) => <MemberCard key={`${m.membershipId}:${m.version}`} member={m} roles={roles} sites={sites} onChanged={data.reload} />)}
      </ul>
    </section>
  );
}
