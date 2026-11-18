'use client';

import { createContext, useContext, type ReactNode } from 'react';
import { DICT, dict, type Dict, type Lang } from '@/lib/i18n';

const LangContext = createContext<{ t: Dict; lang: Lang }>({ t: DICT.en, lang: 'en' });

/** Gives client components the current UI language (set from the dc_lang cookie in the root layout). */
export function LangProvider({ lang, children }: { lang: Lang; children: ReactNode }) {
  return <LangContext.Provider value={{ t: dict(lang), lang }}>{children}</LangContext.Provider>;
}

export function useT() {
  return useContext(LangContext);
}
