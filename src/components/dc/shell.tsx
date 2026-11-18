'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { Sparkles, Activity, Archive, ArrowRightLeft, BookMarked, Bot, BookOpen, Building2, CalendarClock, Clock, Crown, DatabaseBackup, DollarSign, FileDiff, FolderKanban, GitBranch, Inbox, LayoutDashboard, ListChecks, MessageSquareText, MessagesSquare, Search, Settings, ShieldCheck, Upload, Languages, ClipboardCheck, Send, Menu, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Dict, Lang } from '@/lib/i18n';
import { KillSwitch, NotificationBell } from './common';

type NavGroup = { group: keyof Dict; items: { href: string; key: keyof Dict; icon: typeof LayoutDashboard; exact?: boolean }[] };

/** Core product: every agent's work, captured, searchable and continuable. */
const CORE_NAV: NavGroup[] = [
  { group: 'overviewGroup', items: [
    { href: '/', key: 'dashboard', icon: LayoutDashboard, exact: true },
    { href: '/agents', key: 'agents', icon: Bot },
    { href: '/search', key: 'search', icon: Search },
    { href: '/wrapped', key: 'wrapped', icon: Sparkles },
  ] },
  { group: 'historyGroup', items: [
    { href: '/projects', key: 'projects', icon: FolderKanban },
    { href: '/sessions', key: 'sessions', icon: MessagesSquare },
    { href: '/timeline', key: 'timeline', icon: Clock },
    { href: '/tasks', key: 'tasks', icon: ListChecks },
    { href: '/ask', key: 'ask', icon: MessageSquareText },
  ] },
  { group: 'codeGroup', items: [
    { href: '/changes', key: 'changes', icon: FileDiff },
    { href: '/worktrees', key: 'worktrees', icon: GitBranch },
    { href: '/verify', key: 'verify', icon: ShieldCheck },
  ] },
  { group: 'continueGroup', items: [
    { href: '/handoff', key: 'handoff', icon: ArrowRightLeft },
    { href: '/prompts', key: 'prompts', icon: BookMarked },
    { href: '/knowledge', key: 'knowledge', icon: BookOpen },
  ] },
  { group: 'dataGroup', items: [
    { href: '/import', key: 'import', icon: Upload },
    { href: '/costs', key: 'costs', icon: DollarSign },
    { href: '/schedules', key: 'schedules', icon: CalendarClock },
    { href: '/backups', key: 'backups', icon: DatabaseBackup },
    { href: '/settings', key: 'settings', icon: Settings },
  ] },
];

/** Optional AI organization module (Settings → Features). */
const ORG_NAV: NavGroup = { group: 'aiOrg', items: [
  { href: '/owner', key: 'owner', icon: Crown, exact: true },
  { href: '/owner/decisions', key: 'decisions', icon: Inbox },
  { href: '/owner/reviews', key: 'reviews', icon: ClipboardCheck },
  { href: '/owner/orders', key: 'orders', icon: Send },
  { href: '/org', key: 'org', icon: Building2 },
  { href: '/activity', key: 'activity', icon: Activity },
] };

export function Shell({ t, lang, aiOrg, demo = false, children }: { t: Dict; lang: Lang; aiOrg: boolean; demo?: boolean; children: ReactNode }) {
  const NAV = aiOrg ? [...CORE_NAV, ORG_NAV] : CORE_NAV;
  const pathname = usePathname();
  const router = useRouter();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  // Lock page scroll while the mobile menu is open.
  useEffect(() => {
    document.body.style.overflow = open ? 'hidden' : '';
    return () => {
      document.body.style.overflow = '';
    };
  }, [open]);
  const setLang = (l: Lang) => {
    document.cookie = `dc_lang=${l}; path=/; max-age=31536000; samesite=strict`;
    router.refresh();
  };
  const isActive = (href: string, exact?: boolean) => (exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`));

  const brand = (
    <Link href={aiOrg ? '/owner' : '/'} className="flex min-w-0 items-center gap-2.5">
      <div className="grid size-8 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-primary to-cyan text-white">
        <Archive className="size-4" />
      </div>
      <div className="min-w-0">
        <div className="text-sm font-semibold text-white">DevContinuity</div>
        <div className="truncate text-[10px] leading-tight text-muted-foreground">{t.appTagline}</div>
      </div>
    </Link>
  );

  const nav = (
    <nav className="flex-1 overflow-y-auto px-3 pb-4" aria-label={t.menu}>
      {NAV.map((g) => (
        <div key={g.group} className="mb-3">
          <div className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">{t[g.group]}</div>
          {g.items.map((it) => {
            const active = isActive(it.href, it.exact);
            const Icon = it.icon;
            return (
              <Link key={it.href} href={it.href} onClick={() => setOpen(false)} aria-current={active ? 'page' : undefined} className={cn('flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition-colors lg:py-1.5', active ? 'bg-primary/15 text-white' : 'text-slate-400 hover:bg-secondary/60 hover:text-slate-200')}>
                <Icon className={cn('size-4 shrink-0', active ? 'text-primary' : '')} />
                {t[it.key]}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-e border-border bg-[#0d1220] lg:flex">
        <div className="px-5 py-4">{brand}</div>
        {nav}
        <div className="border-t border-border p-3 text-[10px] text-slate-500">Local-first · originals never modified</div>
      </aside>

      {/* Mobile menu */}
      {open && (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label={t.menu}>
          <button className="absolute inset-0 bg-black/60 backdrop-blur-sm" aria-label={t.close} onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 start-0 flex w-72 max-w-[85vw] flex-col border-e border-border bg-[#0d1220] shadow-2xl">
            <div className="flex items-center justify-between gap-2 px-4 py-3">
              {brand}
              <button onClick={() => setOpen(false)} className="grid size-9 shrink-0 place-items-center rounded-lg text-slate-300 hover:bg-secondary" aria-label={t.close}>
                <X className="size-5" />
              </button>
            </div>
            {nav}
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        {demo && (
          <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-0.5 bg-gradient-to-r from-amber-500/90 to-orange-500/90 px-3 py-1.5 text-center text-xs font-medium text-black" role="note">
            <span className="rounded bg-black/80 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-amber-300">{t.demoBadge}</span>
            <span>{t.demoRibbon}</span>
            <code className="rounded bg-black/15 px-1.5 py-0.5 font-mono" dir="ltr">npx devcontinuity</code>
          </div>
        )}
        <header className="sticky top-0 z-20 flex items-center gap-2 border-b border-border bg-background/85 px-3 py-2.5 backdrop-blur sm:px-4 lg:px-8">
          <button onClick={() => setOpen(true)} className="grid size-9 shrink-0 place-items-center rounded-lg border border-border text-slate-300 hover:bg-secondary lg:hidden" aria-label={t.menu}>
            <Menu className="size-5" />
          </button>
          <form
            className="relative min-w-0 max-w-xl flex-1"
            role="search"
            onSubmit={(e) => {
              e.preventDefault();
              if (q.trim()) router.push(`/search?q=${encodeURIComponent(q.trim())}`);
            }}
          >
            <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-slate-500" />
            <input value={q} onChange={(e) => setQ(e.target.value)} type="search" placeholder={t.searchPlaceholder} aria-label={t.search} className="h-9 w-full rounded-lg border border-border bg-card ps-9 pe-3 text-sm text-slate-200 outline-none placeholder:text-slate-500 focus:border-primary/60" />
          </form>
          <Link href="/handoff" className="hidden h-9 shrink-0 items-center gap-2 rounded-lg bg-gradient-to-r from-primary to-cyan px-3.5 text-sm font-semibold text-white shadow-lg shadow-primary/20 transition-opacity hover:opacity-90 xl:inline-flex">
            <ArrowRightLeft className="size-4" />
            {t.continueCta}
          </Link>
          <NotificationBell />
          {aiOrg && <KillSwitch />}
          <button onClick={() => setLang(lang === 'en' ? 'ar' : 'en')} className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-border px-2.5 text-sm text-slate-300 hover:bg-secondary" title={lang === 'en' ? 'العربية' : 'English'} aria-label={lang === 'en' ? 'العربية' : 'English'}>
            <Languages className="size-4" />
            <span className="hidden sm:inline">{lang === 'en' ? 'العربية' : 'English'}</span>
            <span className="sm:hidden">{lang === 'en' ? 'ع' : 'EN'}</span>
          </button>
        </header>
        <main className="mx-auto w-full max-w-[1400px] flex-1 px-3 py-5 sm:px-4 sm:py-6 lg:px-8">{children}</main>
      </div>
    </div>
  );
}
