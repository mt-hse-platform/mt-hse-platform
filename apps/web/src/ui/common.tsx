import type { ReactNode } from 'react';
import { useT } from '../i18nReact.tsx';
import { userMessageKey } from '../../../../packages/i18n/src/index.ts';
import { formatDateTime } from '../../../../packages/engines/src/report/model.ts';

export function EmptyState({ title, description, action }: { title: string; description: string; action?: ReactNode }) {
  return (
    <div className="empty-state">
      <div className="empty-icon" aria-hidden="true">○</div>
      <h2>{title}</h2>
      <p className="muted">{description}</p>
      {action}
    </div>
  );
}

export function ErrorNotice({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const t = useT();
  return (
    <div className="notice notice-danger" role="alert">
      <span>⚠ {t(userMessageKey(error))}</span>
      {onRetry && <button className="btn" onClick={onRetry}>{t('common.retry')}</button>}
    </div>
  );
}

export function LoadingBlock() {
  return <div className="skeleton skeleton-block" role="status" aria-busy="true" />;
}

export type Tone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';
export function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`chip chip-${tone}`}>{children}</span>;
}

export const fmtDateTime = (iso: string | null): string => (iso ? formatDateTime(iso) : '—');
