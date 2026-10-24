import { en } from './en.ts';
import type { MessageKey } from './en.ts';
import { ar } from './ar.ts';

export type { MessageKey };
export type Locale = 'ar' | 'en';
export type Direction = 'rtl' | 'ltr';

export const dictionaries: Record<Locale, Record<MessageKey, string>> = { en, ar };

export const directionOf = (locale: Locale): Direction => (locale === 'ar' ? 'rtl' : 'ltr');

export function translate(
  locale: Locale,
  key: MessageKey,
  params?: Record<string, string | number>,
): string {
  const template = dictionaries[locale][key] ?? dictionaries.en[key] ?? key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in params ? String(params[name]) : whole,
  );
}

/** Translate a validation error code produced by the validation engine. */
export function translateValidation(
  locale: Locale,
  error: { code: string; params?: Record<string, string | number> },
): string {
  const key = `validation.${error.code}` as MessageKey;
  return key in en ? translate(locale, key, error.params) : translate(locale, 'error.unknown');
}

/**
 * Maps any technical error (Firebase, HTTP, network...) to a safe message key.
 * Raw technical text is NEVER returned to the user; log it separately.
 */
export function userMessageKey(err: unknown): MessageKey {
  const code = extractCode(err);
  switch (code) {
    case 'permission-denied':
    case 'forbidden':
    case '403':
      return 'error.permission_denied';
    case 'auth/wrong-password':
    case 'auth/user-not-found':
    case 'auth/invalid-credential':
    case 'auth/invalid-email':
      return 'error.auth_invalid';
    case 'auth/id-token-expired':
    case 'auth/user-token-expired':
    case 'unauthenticated':
    case '401':
      return 'error.session_expired';
    case 'org_required':
      return 'error.org_required';
    case 'not_found': return 'error.not_found';
    case 'not_completed': return 'error.not_completed';
    case 'conflict': return 'error.conflict';
    case 'validation': return 'error.validation';
    case 'already_linked': return 'error.already_linked';
    case 'pdf_unavailable': return 'error.pdf_unavailable';
    case 'no_published_version': return 'error.no_published_version';
    case 'not_editable': return 'error.not_editable';
    case 'report_invalid': return 'error.report_invalid';
    case 'template_invalid': return 'error.template_invalid';
    case 'incomplete': return 'runner.missing';
    case 'email_not_verified': return 'error.email_not_verified';
    case 'already_member': return 'error.already_member';
    case 'already_invited': return 'error.already_invited';
    case 'cannot_modify_self': return 'error.cannot_modify_self';
    case 'last_admin': return 'error.last_admin';
    case 'auth/email-already-in-use': return 'error.email_in_use';
    case 'auth/weak-password': return 'login.passwordShort';
    case 'auth/too-many-requests': return 'error.too_many_requests';
    case 'auth/network-request-failed':
    case 'network':
    case 'unavailable':
      return 'error.network';
    default:
      return 'error.unknown';
  }
}

function extractCode(err: unknown): string {
  if (typeof err === 'object' && err !== null) {
    const o = err as { code?: unknown; status?: unknown; name?: unknown };
    if (typeof o.code === 'string') return o.code;
    if (typeof o.status === 'number') return String(o.status);
    if (o.name === 'TypeError') return 'network'; // fetch() failure
  }
  return 'unknown';
}
