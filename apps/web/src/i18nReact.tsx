import { createContext, useContext } from 'react';
import { translate, translateValidation } from '../../../packages/i18n/src/index.ts';
import type { Locale, MessageKey } from '../../../packages/i18n/src/index.ts';

export type T = (key: MessageKey, params?: Record<string, string | number>) => string;

export const LocaleContext = createContext<Locale>('ar');
export const useLocale = () => useContext(LocaleContext);
export function useT(): T {
  const locale = useLocale();
  return (key, params) => translate(locale, key, params);
}
export { translateValidation };
