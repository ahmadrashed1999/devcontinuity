import { notFound } from 'next/navigation';
import { ensureDb } from '@/server/db';
import { aiOrgEnabled } from '@/server/features';

/**
 * Pages of the optional AI organization module (/owner, /org, /activity). They exist only while the
 * module is switched on in Settings → Features; otherwise they are a 404. Its data is kept either way.
 */
export default async function OrgModuleLayout({ children }: LayoutProps<'/'>) {
  await ensureDb();
  if (!(await aiOrgEnabled())) notFound();
  return children;
}
