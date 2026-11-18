import type { Metadata } from 'next';
import { Geist_Mono, Inter, Tajawal } from 'next/font/google';
import { cookies } from 'next/headers';
import { LangProvider } from '@/components/dc/lang';
import { Shell } from '@/components/dc/shell';
import { dict, type Lang } from '@/lib/i18n';
import { ensureDb } from '@/server/db';
import { aiOrgEnabled } from '@/server/features';
import './globals.css';

const inter = Inter({ variable: '--font-inter', subsets: ['latin'] });
const tajawal = Tajawal({ variable: '--font-tajawal', subsets: ['arabic', 'latin'], weight: ['400', '500', '700'] });
const mono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'DevContinuity',
  description: 'One log for every AI coding agent: Claude Code, Codex, Antigravity, Cursor, Copilot, Cline, Gemini CLI and more',
};

export default async function RootLayout({ children }: LayoutProps<'/'>) {
  const lang: Lang = (await cookies()).get('dc_lang')?.value === 'ar' ? 'ar' : 'en';
  // The menu must render even when the database is not set up yet.
  const aiOrg = await ensureDb()
    .then(() => aiOrgEnabled())
    .catch(() => false);
  return (
    <html lang={lang} dir={lang === 'ar' ? 'rtl' : 'ltr'} className={`dark ${inter.variable} ${tajawal.variable} ${mono.variable} h-full`}>
      <body className="min-h-full">
        <LangProvider lang={lang}>
          <Shell t={dict(lang)} lang={lang} aiOrg={aiOrg}>
            {children}
          </Shell>
        </LangProvider>
      </body>
    </html>
  );
}
