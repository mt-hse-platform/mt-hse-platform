import type { Locale, Direction } from '../../../../packages/i18n/src/index.ts';
import { directionOf } from '../../../../packages/i18n/src/index.ts';

export type ThemePref = 'dark' | 'light' | 'system';
export type Preferences = { locale: Locale; theme: ThemePref };

export const DEFAULT_PREFERENCES: Preferences = { locale: 'ar', theme: 'dark' };
export const PREFS_KEY = 'mthse.prefs.v1';

/** Never throws: anything unexpected falls back to defaults field by field. */
export function parsePreferences(raw: string | null): Preferences {
  let obj: Record<string, unknown> = {};
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (parsed && typeof parsed === 'object') obj = parsed as Record<string, unknown>;
  } catch { /* ignore */ }
  return {
    locale: obj.locale === 'ar' || obj.locale === 'en' ? obj.locale : DEFAULT_PREFERENCES.locale,
    theme: obj.theme === 'dark' || obj.theme === 'light' || obj.theme === 'system' ? obj.theme : DEFAULT_PREFERENCES.theme,
  };
}

export function resolveTheme(pref: ThemePref, systemPrefersDark: boolean): 'dark' | 'light' {
  return pref === 'system' ? (systemPrefersDark ? 'dark' : 'light') : pref;
}

export function documentAttributes(prefs: Preferences, systemPrefersDark: boolean): { lang: Locale; dir: Direction; theme: 'dark' | 'light' } {
  return { lang: prefs.locale, dir: directionOf(prefs.locale), theme: resolveTheme(prefs.theme, systemPrefersDark) };
}
