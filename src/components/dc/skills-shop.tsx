'use client';

import { useEffect, useMemo, useState } from 'react';
import { BadgeCheck, BookOpen, Brain, Bug, Check, Copy, Database, ExternalLink, FileText, GitPullRequest, Globe, ListChecks, Palette, Search, Shield, Sparkles, Star, Terminal, X, type LucideIcon } from 'lucide-react';
import { api } from '@/lib/api';
import { AGENT_HEX } from '@/lib/format';
import { CATALOG, CATEGORIES, KIND_LABELS, SHOP_AGENTS, SHOP_AGENT_LABELS, categoryCounts, filterCatalog, installSteps, itemAgents, type CatalogItem, type CategoryId, type ShopAgent } from '@/lib/skills-catalog';
import { cn } from '@/lib/utils';
import { useT } from './lang';

const ICONS: Record<string, LucideIcon> = { brain: Brain, book: BookOpen, globe: Globe, git: GitPullRequest, palette: Palette, database: Database, bug: Bug, list: ListChecks, sparkles: Sparkles, shield: Shield, file: FileText };

function CopyBox({ text, label }: { text: string; label?: string }) {
  const { t } = useT();
  const [done, setDone] = useState(false);
  return (
    <div className="relative rounded-lg border border-border bg-black/40">
      {label && <div className="border-b border-border/60 px-3 py-1.5 font-mono text-[11px] text-slate-400" dir="ltr">{label}</div>}
      <pre className="overflow-x-auto whitespace-pre-wrap break-all p-3 pe-20 font-mono text-xs leading-relaxed text-slate-200" dir="ltr">{text}</pre>
      <button
        onClick={async () => {
          await navigator.clipboard.writeText(text).catch(() => undefined);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        }}
        className="absolute end-2 top-2 inline-flex h-7 items-center gap-1 rounded-md border border-border bg-card px-2 text-[11px] text-slate-200 hover:bg-secondary"
      >
        {done ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
        {done ? t.skillsCopied : t.skillsCopy}
      </button>
    </div>
  );
}

function Detail({ item, agent, installed, onClose }: { item: CatalogItem; agent: ShopAgent | null; installed: boolean; onClose: () => void }) {
  const { t, lang } = useT();
  const agents = itemAgents(item);
  const [tab, setTab] = useState<ShopAgent>(agent && agents.includes(agent) ? agent : agents[0]);
  const steps = installSteps(item, tab) ?? [];
  const Icon = ICONS[CATEGORIES[item.category].icon] ?? Sparkles;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center sm:items-center" role="dialog" aria-modal="true" aria-label={item.name}>
      <button className="absolute inset-0 bg-black/70 backdrop-blur-sm" aria-label={t.close} onClick={onClose} />
      <div className="relative flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden rounded-t-2xl border border-border bg-card shadow-2xl sm:rounded-2xl">
        <div className="flex items-start gap-3 border-b border-border p-4">
          <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary/15 text-primary"><Icon className="size-5" /></div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold text-white">{item.name}</h2>
              <span className="rounded-md bg-secondary px-1.5 py-0.5 text-[10px] text-slate-300">{KIND_LABELS[item.kind][lang]}</span>
              {item.official ? <span className="inline-flex items-center gap-1 text-[11px] text-success"><BadgeCheck className="size-3.5" />{t.skillsOfficial}</span> : <span className="text-[11px] text-slate-400">{t.skillsCommunity}</span>}
              {installed && <span className="rounded-md bg-success/15 px-1.5 py-0.5 text-[10px] text-success">{t.skillsInstalled}</span>}
            </div>
            <div className="text-xs text-muted-foreground">{item.publisher} · {CATEGORIES[item.category][lang]}</div>
          </div>
          <button onClick={onClose} className="grid size-8 shrink-0 place-items-center rounded-lg text-slate-400 hover:bg-secondary" aria-label={t.close}><X className="size-4" /></button>
        </div>
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
          <p className="text-sm text-slate-200">{item.summary[lang]}</p>
          <section>
            <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-slate-400">{t.skillsBenefits}</h3>
            <ul className="space-y-1">{item.benefits[lang].map((b) => <li key={b} className="flex gap-2 text-sm text-slate-300"><Check className="mt-0.5 size-4 shrink-0 text-success" />{b}</li>)}</ul>
          </section>
          <section>
            <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-slate-400">{t.skillsInstall}</h3>
            <div className="dc-scroll mb-2 flex gap-1 border-b border-border">
              {agents.map((a) => (
                <button key={a} onClick={() => setTab(a)} className={cn('-mb-px shrink-0 whitespace-nowrap border-b-2 px-2.5 py-1.5 text-xs', tab === a ? 'border-primary text-white' : 'border-transparent text-muted-foreground hover:text-slate-200')}>
                  {SHOP_AGENT_LABELS[a]}
                </button>
              ))}
            </div>
            {item.requires && <p className="mb-2 text-xs text-warning">{t.skillsRequires}: {item.requires[lang]}</p>}
            <ol className="space-y-2">
              {steps.map((s, i) => (
                <li key={i} className="space-y-1">
                  <div className="flex items-center gap-1.5 text-xs text-slate-400">
                    {s.how === 'command' ? <Terminal className="size-3.5" /> : <FileText className="size-3.5" />}
                    {s.how === 'command' ? t.skillsRun : `${t.skillsAddTo} ${s.target}`}
                  </div>
                  <CopyBox text={s.text} />
                  {s.note && <p className="text-[11px] text-muted-foreground">{s.note[lang]}</p>}
                </li>
              ))}
            </ol>
            {item.mcp && <p className="mt-2 text-[11px] text-muted-foreground">{t.skillsMergeHint}</p>}
          </section>
          <section>
            <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-slate-400">{t.skillsHowToUse}</h3>
            <ul className="list-disc space-y-1 ps-5 text-sm text-slate-300">{item.usage[lang].map((u) => <li key={u}>{u}</li>)}</ul>
            {item.examples.length > 0 && (
              <div className="mt-2 space-y-1.5">
                <div className="text-xs text-slate-400">{t.skillsExamples}</div>
                {item.examples.map((e) => <CopyBox key={e} text={e} />)}
              </div>
            )}
          </section>
          <p className="rounded-lg border border-warning/30 bg-warning/5 p-2.5 text-xs text-amber-100">{t.skillsSafety}</p>
          <a href={item.url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline" dir="ltr"><ExternalLink className="size-4" />{item.url.replace(/^https?:\/\//, '')}</a>
        </div>
      </div>
    </div>
  );
}

/**
 * Agent Skills Shop: the most useful MCP servers, skills, plugins, rules and extensions per agent,
 * by category, with benefits, install steps for each agent and how to use them. Copy-only: nothing is
 * installed or downloaded from this page.
 */
export function SkillsShop() {
  const { t, lang } = useT();
  const [agent, setAgent] = useState<ShopAgent | null>(null);
  const [category, setCategory] = useState<CategoryId | null>(null);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<CatalogItem | null>(null);
  const [installedNames, setInstalledNames] = useState<string[]>([]);
  useEffect(() => {
    // Which MCP servers are already configured in any agent (read-only inventory); absent in the demo.
    api<{ servers: { name: string }[] }>('mcp').then((r) => setInstalledNames(r.servers.map((s) => s.name.toLowerCase()))).catch(() => undefined);
  }, []);
  const items = useMemo(() => filterCatalog(CATALOG, { agent, category, q }), [agent, category, q]);
  const counts = useMemo(() => categoryCounts(CATALOG, agent), [agent]);
  const isInstalled = (i: CatalogItem) => i.kind === 'mcp' && installedNames.some((n) => n.includes(i.id) || i.id.includes(n));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-1.5">
        <button onClick={() => setAgent(null)} className={cn('rounded-lg border px-2.5 py-1 text-xs', !agent ? 'border-primary bg-primary/20 text-white' : 'border-border text-slate-300 hover:bg-secondary')}>{t.skillsAllAgents}</button>
        {SHOP_AGENTS.map((a) => (
          <button key={a} onClick={() => setAgent(a)} className={cn('inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs', agent === a ? 'border-primary bg-primary/20 text-white' : 'border-border text-slate-300 hover:bg-secondary')}>
            <span className="size-2 rounded-full" style={{ background: AGENT_HEX[a] ?? '#cbd5e1' }} />
            {SHOP_AGENT_LABELS[a]}
          </button>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-[230px_1fr]">
        <aside className="space-y-3">
          <div className="relative">
            <Search className="pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-slate-500" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t.skillsSearch} aria-label={t.skillsSearch} className="h-9 w-full rounded-lg border border-border bg-card ps-8 pe-2 text-sm outline-none focus:border-primary/60" />
          </div>
          <nav className="flex gap-1 overflow-x-auto lg:flex-col lg:overflow-visible" aria-label={t.skillsCategories}>
            <button onClick={() => setCategory(null)} className={cn('flex shrink-0 items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-sm', !category ? 'bg-primary/15 text-white' : 'text-slate-400 hover:bg-secondary/60')}>
              {t.skillsAllCategories}<span className="text-xs tabular-nums text-slate-500">{Object.values(counts).reduce((a, b) => a + b, 0)}</span>
            </button>
            {(Object.keys(CATEGORIES) as CategoryId[]).filter((c) => counts[c] > 0).map((c) => {
              const Icon = ICONS[CATEGORIES[c].icon] ?? Sparkles;
              return (
                <button key={c} onClick={() => setCategory(c)} className={cn('flex shrink-0 items-center gap-2 rounded-lg px-2.5 py-1.5 text-start text-sm', category === c ? 'bg-primary/15 text-white' : 'text-slate-400 hover:bg-secondary/60')}>
                  <Icon className="size-4 shrink-0" />
                  <span className="flex-1 whitespace-nowrap">{CATEGORIES[c][lang]}</span>
                  <span className="text-xs tabular-nums text-slate-500">{counts[c]}</span>
                </button>
              );
            })}
          </nav>
        </aside>

        <div>
          {items.length === 0 && <div className="rounded-xl border border-border bg-card p-6 text-sm text-muted-foreground">{t.skillsNone}</div>}
          <div className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-3">
            {items.map((i) => {
              const Icon = ICONS[CATEGORIES[i.category].icon] ?? Sparkles;
              const top = !!agent && i.topFor?.includes(agent);
              return (
                <button key={i.id} onClick={() => setOpen(i)} className={cn('group flex flex-col rounded-xl border bg-card p-4 text-start transition-colors hover:border-primary/50', top ? 'border-primary/40' : 'border-border')}>
                  <div className="flex items-start gap-2.5">
                    <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-secondary text-cyan"><Icon className="size-4" /></div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-semibold text-white">{i.name}</span>
                        {i.official && <BadgeCheck className="size-4 text-success" aria-label={t.skillsOfficial} />}
                      </div>
                      <div className="text-[11px] text-muted-foreground">{KIND_LABELS[i.kind][lang]} · {i.publisher}</div>
                    </div>
                    {isInstalled(i) && <span className="rounded-md bg-success/15 px-1.5 py-0.5 text-[10px] text-success">{t.skillsInstalled}</span>}
                  </div>
                  {top && <div className="mt-2 inline-flex w-fit items-center gap-1 rounded-md bg-primary/15 px-1.5 py-0.5 text-[11px] text-indigo-200"><Star className="size-3" />{t.skillsTopPick.replace('{agent}', SHOP_AGENT_LABELS[agent!])}</div>}
                  <p className="mt-2 line-clamp-3 text-sm text-slate-300">{i.summary[lang]}</p>
                  <ul className="mt-2 space-y-0.5">{i.benefits[lang].slice(0, 2).map((b) => <li key={b} className="flex gap-1.5 text-xs text-slate-400"><Check className="mt-0.5 size-3 shrink-0 text-success" />{b}</li>)}</ul>
                  <div className="mt-auto flex flex-wrap items-center gap-1 pt-3">
                    {itemAgents(i).slice(0, 6).map((a) => <span key={a} className="size-2 rounded-full" title={SHOP_AGENT_LABELS[a]} style={{ background: AGENT_HEX[a] ?? '#cbd5e1' }} />)}
                    <span className="text-[11px] text-slate-500">{itemAgents(i).length === SHOP_AGENTS.length ? t.skillsEveryAgent : itemAgents(i).map((a) => SHOP_AGENT_LABELS[a].split(' ')[0]).slice(0, 3).join(', ')}</span>
                    <span className="ms-auto text-xs font-medium text-primary group-hover:underline">{t.skillsDetails}</span>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </div>
      {open && <Detail item={open} agent={agent} installed={isInstalled(open)} onClose={() => setOpen(null)} />}
    </div>
  );
}
