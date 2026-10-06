import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { en, type Dict } from './en';
import { ja } from './ja';

export type Lang = 'en' | 'ja';

const DICTS: Record<Lang, Dict> = { en, ja };
const STORAGE_KEY = 'pmbok.lang';

export function detectLang(navLang: string | undefined): Lang {
  return navLang && navLang.toLowerCase().startsWith('ja') ? 'ja' : 'en';
}

export function readStoredLang(): Lang | undefined {
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    return v === 'ja' || v === 'en' ? v : undefined;
  } catch {
    return undefined;
  }
}

function storeLang(lang: Lang): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // storage unavailable (private mode etc.) — ignore
  }
}

export function initialLang(): Lang {
  return readStoredLang() ?? detectLang(typeof navigator !== 'undefined' ? navigator.language : undefined);
}

interface I18nValue {
  lang: Lang;
  t: Dict;
  setLang: (lang: Lang) => void;
}

const I18nContext = createContext<I18nValue>({ lang: 'en', t: en, setLang: () => undefined });

export function I18nProvider({ children, lang: forced }: { children: ReactNode; lang?: Lang }) {
  const [lang, setLangState] = useState<Lang>(() => forced ?? initialLang());
  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    storeLang(l);
  }, []);
  const value = useMemo(() => {
    document.documentElement.lang = lang;
    return { lang, t: DICTS[lang], setLang };
  }, [lang, setLang]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  return useContext(I18nContext);
}
