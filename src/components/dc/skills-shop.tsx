'use client';

import { useEffect, useMemo, useState } from 'react';
import { BadgeCheck, BarChart3, BookOpen, Brain, Bug, Check, Cloud, Copy, Database, ExternalLink, FileText, FlaskConical, GitPullRequest, Globe, ListChecks, MessageSquareCode, MousePointerClick, Palette, ScrollText, Search, Shield, Smartphone, Sparkles, Star, Terminal, TrendingUp, X, type LucideIcon } from 'lucide-react';
import { api } from '@/lib/api';
import { AGENT_HEX } from '@/lib/format';
import { CATALOG, CATEGORIES, KIND_LABELS, SHOP_AGENTS, SHOP_AGENT_LABELS, SHOP_SORTS, SKILL_KINDS, STARS_CHECKED, categoryCounts, filterCatalog, installSteps, isPopular, itemAgents, kindCounts, type CatalogItem, type CategoryId, type ShopAgent, type ShopSort, type SkillKind } from '@/lib/skills-catalog';
import { cn } from '@/lib/utils';
import { useT } from './lang';

const ICONS: Record<string, LucideIcon> = { brain: Brain, book: BookOpen, globe: Globe, git: GitPullRequest, palette: Palette, database: Database, bug: Bug, list: ListChecks, sparkles: Sparkles, shield: Shield, file: FileText, review: MessageSquareCode, flask: FlaskConical, search: Search, cloud: Cloud, chart: BarChart3, phone: Smartphone, scroll: ScrollText };

// Slash commands, $skills, flags, ~/paths, file names and URLs inside Arabic sentences.
const LTR_TOKEN = /((?:^|(?<=[\s(و]))(?:[/$~@][^\s،,()]+|--?[a-zA-Z][\w-]*(?:=[^\s،,()]+)?|https?:\/\/[^\s،,()]+|\.?[\w-]+(?:\/[\w.-]+)*\.(?:md|mdc|json|jsonc|toml|ya?ml|local|txt|csv|parquet|docx|pdf)))/g;

/** Keeps commands and paths left-to-right inside Arabic text, so "/ponytail-review" does not turn into "ponytail-review/". */
function Bidi({ text, lang }: { text: string; lang: string }) {
  if (lang !== 'ar') return <>{text}</>;
  const parts = text.replace(/‎/g, '').split(LTR_TOKEN);
  return <>{parts.map((p, i) => (i % 2 ? <bdi key={i} dir="ltr">{p}</bdi> : p))}</>;
}

const fmtStars = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));

function CopyBox({ text, label }: { text: string; label?: string }) {
  const { t } = useT();
  const [done, setDone] = useState(false);
  return (
    // Commands are left-to-right: the whole box is LTR so the copy button and the text padding stay on the same side in Arabic too.
    <div className="relative rounded-lg border border-border bg-black/40" dir="ltr">
      {label && <div className="border-b border-border/60 px-3 py-1.5 font-mono text-[11px] text-slate-400">{label}</div>}
      <pre className="overflow-x-auto whitespace-pre-wrap break-words p-3 pe-20 text-start font-mono text-xs leading-relaxed text-slate-200">{text}</pre>
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

function Stars({ n, className }: { n: number; className?: string }) {
  const { t } = useT();
  return (
    <span className={cn('inline-flex items-center gap-0.5 text-[11px] tabular-nums text-amber-200/90', className)} title={t.skillsStarsNote.replace('{date}', STARS_CHECKED)}>
      <Star className="size-3 fill-current" />
      <bdi dir="ltr">{fmtStars(n)}</bdi>
    </span>
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
              {item.stars !== undefined && <Stars n={item.stars} />}
              {installed && <span className="rounded-md bg-success/15 px-1.5 py-0.5 text-[10px] text-success">{t.skillsInstalled}</span>}
            </div>
            <div className="text-xs text-muted-foreground">{item.publisher} · {CATEGORIES[item.category][lang]}</div>
          </div>
          <button onClick={onClose} className="grid size-8 shrink-0 place-items-center rounded-lg text-slate-400 hover:bg-secondary" aria-label={t.close}><X className="size-4" /></button>
        </div>
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
          <p className="text-sm text-slate-200"><Bidi text={item.summary[lang]} lang={lang} /></p>
          <section>
            <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-slate-400">{t.skillsBenefits}</h3>
            <ul className="space-y-1">{item.benefits[lang].map((b) => <li key={b} className="flex gap-2 text-sm text-slate-300"><Check className="mt-0.5 size-4 shrink-0 text-success" /><span><Bidi text={b} lang={lang} /></span></li>)}</ul>
          </section>
          <section>
            <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-slate-400">{t.skillsInstall}</h3>
            <div className="dc-scroll mb-2 flex gap-1 border-b border-border" role="tablist">
              {agents.map((a) => (
                <button key={a} role="tab" aria-selected={tab === a} onClick={() => setTab(a)} className={cn('-mb-px shrink-0 whitespace-nowrap border-b-2 px-2.5 py-1.5 text-xs', tab === a ? 'border-primary text-white' : 'border-transparent text-muted-foreground hover:text-slate-200')}>
                  {SHOP_AGENT_LABELS[a]}
                </button>
              ))}
            </div>
            {item.requires && <p className="mb-2 text-xs text-warning">{t.skillsRequires}: <Bidi text={item.requires[lang]} lang={lang} /></p>}
            <ol className="space-y-2">
              {steps.map((s, i) => (
                <li key={i} className="space-y-1">
                  <div className="flex items-center gap-1.5 text-xs text-slate-400">
                    {s.how === 'command' ? <Terminal className="size-3.5" /> : s.how === 'ui' ? <MousePointerClick className="size-3.5" /> : <FileText className="size-3.5" />}
                    {s.how === 'command' ? t.skillsRun : s.how === 'ui' ? t.skillsInApp : <>{t.skillsAddTo} <bdi dir="ltr" className="font-mono">{s.target}</bdi></>}
                  </div>
                  <CopyBox text={s.text} />
                  {s.note && <p className="text-[11px] text-muted-foreground"><Bidi text={s.note[lang]} lang={lang} /></p>}
                </li>
              ))}
            </ol>
            {item.mcp && <p className="mt-2 text-[11px] text-muted-foreground">{t.skillsMergeHint}</p>}
          </section>
          <section>
            <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-slate-400">{t.skillsHowToUse}</h3>
            <ul className="list-disc space-y-1 ps-5 text-sm text-slate-300">{item.usage[lang].map((u) => <li key={u}><Bidi text={u} lang={lang} /></li>)}</ul>
            {item.examples.length > 0 && (
              <div className="mt-2 space-y-1.5">
                <div className="text-xs text-slate-400">{t.skillsExamples}</div>
                {item.examples.map((e) => <CopyBox key={e} text={e} />)}
              </div>
            )}
          </section>
          <p className="rounded-lg border border-warning/30 bg-warning/5 p-2.5 text-xs text-amber-100">{t.skillsSafety}</p>
          <a href={item.url} target="_blank" rel="noreferrer noopener" className="inline-flex max-w-full items-center gap-1.5 break-all text-sm text-primary hover:underline" dir="ltr"><ExternalLink className="size-4 shrink-0" />{item.url.replace(/^https?:\/\//, '')}</a>
        </div>
      </div>
    </div>
  );
}

const chip = (on: boolean) => cn('inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border px-2.5 py-1 text-xs', on ? 'border-primary bg-primary/20 text-white' : 'border-border text-slate-300 hover:bg-secondary');

/**
 * Agent Skills Shop: the most useful MCP servers, skills, plugins, rules and extensions per agent,
 * by category, with benefits, install steps for each agent and how to use them. Copy-only: nothing is
 * installed or downloaded from this page.
 */
export function SkillsShop() {
  const { t, lang } = useT();
  const [agent, setAgent] = useState<ShopAgent | null>(null);
  const [category, setCategory] = useState<CategoryId | null>(null);
  const [kind, setKind] = useState<SkillKind | null>(null);
  const [officialOnly, setOfficialOnly] = useState(false);
  const [sort, setSort] = useState<ShopSort>('recommended');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<CatalogItem | null>(null);
  const [installedNames, setInstalledNames] = useState<string[]>([]);
  useEffect(() => {
    // Which MCP servers are already configured in any agent (read-only inventory); absent in the demo.
    api<{ servers: { name: string }[] }>('mcp').then((r) => setInstalledNames(r.servers.map((s) => s.name.toLowerCase()))).catch(() => undefined);
  }, []);
  const items = useMemo(() => filterCatalog(CATALOG, { agent, category, kind, officialOnly, q, sort }), [agent, category, kind, officialOnly, q, sort]);
  const total = useMemo(() => filterCatalog(CATALOG, { agent }).length, [agent]);
  const counts = useMemo(() => categoryCounts(CATALOG, agent, { kind, officialOnly }), [agent, kind, officialOnly]);
  const kinds = useMemo(() => kindCounts(CATALOG, { agent, category, officialOnly }), [agent, category, officialOnly]);
  const isInstalled = (i: CatalogItem) => i.kind === 'mcp' && installedNames.some((n) => n.includes(i.id) || i.id.includes(n));
  const filtered = !!(category || kind || officialOnly || q.trim());
  const sortLabel: Record<ShopSort, string> = { recommended: t.skillsSortRecommended, stars: t.skillsSortStars, name: t.skillsSortName };

  return (
    <div className="space-y-4">
      <div className="dc-scroll -mx-1 flex gap-1.5 px-1 pb-1 sm:flex-wrap">
        <button onClick={() => setAgent(null)} className={chip(!agent)}>{t.skillsAllAgents}</button>
        {SHOP_AGENTS.map((a) => (
          <button key={a} onClick={() => setAgent(a)} className={chip(agent === a)}>
            <span className="size-2 rounded-full" style={{ background: AGENT_HEX[a] ?? '#cbd5e1' }} />
            {SHOP_AGENT_LABELS[a]}
          </button>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-[240px_minmax(0,1fr)]">
        <aside className="min-w-0 space-y-3">
          <div className="relative">
            <Search className="pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-slate-500" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t.skillsSearch} aria-label={t.skillsSearch} className="h-9 w-full rounded-lg border border-border bg-card ps-8 pe-2 text-sm outline-none focus:border-primary/60" />
          </div>
          <nav className="dc-scroll flex gap-1 lg:flex-col" aria-label={t.skillsCategories}>
            <button onClick={() => setCategory(null)} className={cn('flex shrink-0 items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-sm', !category ? 'bg-primary/15 text-white' : 'text-slate-400 hover:bg-secondary/60')}>
              {t.skillsAllCategories}<span className="text-xs tabular-nums text-slate-500">{Object.values(counts).reduce((a, b) => a + b, 0)}</span>
            </button>
            {(Object.keys(CATEGORIES) as CategoryId[]).filter((c) => counts[c] > 0 || category === c).map((c) => {
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

        <div className="min-w-0 space-y-3">
          <div className="space-y-2 rounded-xl border border-border bg-card/60 p-2.5">
            <div className="dc-scroll flex gap-1.5 sm:flex-wrap" role="group" aria-label={t.skillsKinds}>
              <button onClick={() => setKind(null)} className={chip(!kind)}>{t.skillsAllKinds}</button>
              {SKILL_KINDS.filter((k) => kinds[k] || kind === k).map((k) => (
                <button key={k} onClick={() => setKind(kind === k ? null : k)} className={chip(kind === k)} aria-pressed={kind === k}>
                  {KIND_LABELS[k][lang]}<span className="tabular-nums text-slate-500">{kinds[k] ?? 0}</span>
                </button>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs text-slate-300">
                <input type="checkbox" checked={officialOnly} onChange={(e) => setOfficialOnly(e.target.checked)} className="accent-indigo-500" />
                <BadgeCheck className="size-3.5 text-success" />{t.skillsOfficialOnly}
              </label>
              <label className="inline-flex items-center gap-1.5 text-xs text-slate-400">
                {t.skillsSort}
                <select value={sort} onChange={(e) => setSort(e.target.value as ShopSort)} className="h-7 rounded-md border border-border bg-background px-1.5 text-xs text-slate-200">
                  {SHOP_SORTS.map((s) => <option key={s} value={s}>{sortLabel[s]}</option>)}
                </select>
              </label>
              {filtered && <button onClick={() => { setCategory(null); setKind(null); setOfficialOnly(false); setQ(''); }} className="text-xs text-primary hover:underline">{t.skillsClearFilters}</button>}
              <span className="ms-auto text-xs tabular-nums text-muted-foreground" aria-live="polite">{t.skillsResults.replace('{n}', String(items.length)).replace('{total}', String(total))}</span>
            </div>
          </div>

          {items.length === 0 && <div className="rounded-xl border border-border bg-card p-6 text-sm text-muted-foreground">{t.skillsNone}</div>}
          <div className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-3">
            {items.map((i) => {
              const Icon = ICONS[CATEGORIES[i.category].icon] ?? Sparkles;
              const top = !!agent && i.topFor?.includes(agent);
              const ag = itemAgents(i);
              return (
                <button key={i.id} onClick={() => setOpen(i)} className={cn('group flex min-w-0 flex-col rounded-xl border bg-card p-4 text-start transition-colors hover:border-primary/50', top ? 'border-primary/40' : 'border-border')}>
                  <div className="flex items-start gap-2.5">
                    <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-secondary text-cyan"><Icon className="size-4" /></div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-semibold text-white">{i.name}</span>
                        {i.official && <BadgeCheck className="size-4 shrink-0 text-success" aria-label={t.skillsOfficial} />}
                      </div>
                      <div className="truncate text-[11px] text-muted-foreground">{KIND_LABELS[i.kind][lang]} · {i.publisher}</div>
                    </div>
                    {isInstalled(i) && <span className="rounded-md bg-success/15 px-1.5 py-0.5 text-[10px] text-success">{t.skillsInstalled}</span>}
                  </div>
                  {(top || isPopular(i)) && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {top && <span className="inline-flex w-fit items-center gap-1 rounded-md bg-primary/15 px-1.5 py-0.5 text-[11px] text-indigo-200"><Star className="size-3" />{t.skillsTopPick.replace('{agent}', SHOP_AGENT_LABELS[agent!])}</span>}
                      {isPopular(i) && <span className="inline-flex w-fit items-center gap-1 rounded-md bg-amber-400/10 px-1.5 py-0.5 text-[11px] text-amber-200"><TrendingUp className="size-3" />{t.skillsPopular}</span>}
                    </div>
                  )}
                  <p className="mt-2 line-clamp-3 text-sm text-slate-300"><Bidi text={i.summary[lang]} lang={lang} /></p>
                  <ul className="mt-2 space-y-0.5">{i.benefits[lang].slice(0, 2).map((b) => <li key={b} className="flex gap-1.5 text-xs text-slate-400"><Check className="mt-0.5 size-3 shrink-0 text-success" /><span><Bidi text={b} lang={lang} /></span></li>)}</ul>
                  <div className="mt-auto flex flex-wrap items-center gap-1 pt-3">
                    {ag.slice(0, 6).map((a) => <span key={a} className="size-2 rounded-full" title={SHOP_AGENT_LABELS[a]} style={{ background: AGENT_HEX[a] ?? '#cbd5e1' }} />)}
                    <span className="text-[11px] text-slate-500">{ag.length === SHOP_AGENTS.length ? t.skillsEveryAgent : ag.map((a) => SHOP_AGENT_LABELS[a].split(' ')[0]).slice(0, 3).join(', ') + (ag.length > 3 ? ` +${ag.length - 3}` : '')}</span>
                    {i.stars !== undefined && <Stars n={i.stars} className="ms-2" />}
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
