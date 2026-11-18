import { cookies } from 'next/headers';
import { dict } from './i18n';

export async function getT() {
  const lang: 'en' | 'ar' = (await cookies()).get('dc_lang')?.value === 'ar' ? 'ar' : 'en';
  return { t: dict(lang), lang };
}
