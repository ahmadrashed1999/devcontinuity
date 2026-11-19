/**
 * Agent Skills Shop: a curated, offline catalog of useful skills, MCP servers, plugins, rules and
 * extensions for AI coding agents. Nothing is downloaded or installed from here; every entry says what
 * it gives you, how to install it in each agent and how to use it. Every entry was checked against its
 * own repository or official docs (install commands, package names, requirements).
 *
 * One file per group of categories keeps the data readable; this index joins them and holds the
 * filtering used by the /skills page and the tests.
 */
import { CONTEXT } from './context';
import { INFRA } from './infra';
import { QUALITY } from './quality';
import { RULES } from './rules';
import { CATEGORIES, POPULAR_STARS, worksWith, type CatalogItem, type CategoryId, type ShopAgent, type SkillKind } from './types';
import { WEB } from './web';
import { WORK } from './work';
import { WORKFLOW } from './workflow';

export * from './types';

/** Curated order (the "recommended" sort without an agent): DevContinuity, then skills packs, review, web, memory, infra, work, rules. */
export const CATALOG: CatalogItem[] = (() => {
  const all = [...CONTEXT, ...WORKFLOW, ...QUALITY, ...WEB, ...INFRA, ...WORK, ...RULES];
  const order = ['devcontinuity', ...WORKFLOW.map((i) => i.id)];
  const rank = (i: CatalogItem) => (order.includes(i.id) ? order.indexOf(i.id) : order.length);
  return all.map((i, k) => ({ i, k })).sort((a, b) => rank(a.i) - rank(b.i) || a.k - b.k).map((x) => x.i);
})();

export const SHOP_SORTS = ['recommended', 'stars', 'name'] as const;
export type ShopSort = (typeof SHOP_SORTS)[number];

export interface ShopFilter {
  agent?: ShopAgent | null;
  category?: CategoryId | null;
  kind?: SkillKind | null;
  officialOnly?: boolean;
  q?: string;
  sort?: ShopSort;
}

export function isPopular(i: CatalogItem): boolean {
  return (i.stars ?? 0) >= POPULAR_STARS;
}

function matchesText(i: CatalogItem, q: string): boolean {
  return [i.id, i.name, i.publisher, i.summary.en, i.summary.ar, CATEGORIES[i.category].en, CATEGORIES[i.category].ar, ...i.benefits.en, ...i.benefits.ar].some((s) => s.toLowerCase().includes(q));
}

/**
 * Items matching the filter. "recommended" keeps the agent's top picks first, then official items,
 * then the curated order; "stars" sorts by GitHub stars; "name" alphabetically.
 */
export function filterCatalog(items: CatalogItem[], f: ShopFilter): CatalogItem[] {
  const q = f.q?.trim().toLowerCase();
  const out = items.filter((i) => (!f.agent || worksWith(i, f.agent)) && (!f.category || i.category === f.category) && (!f.kind || i.kind === f.kind) && (!f.officialOnly || i.official) && (!q || matchesText(i, q)));
  const sort = f.sort ?? 'recommended';
  if (sort === 'name') return [...out].sort((a, b) => a.name.localeCompare(b.name));
  if (sort === 'stars') return [...out].sort((a, b) => (b.stars ?? -1) - (a.stars ?? -1));
  if (!f.agent) return out;
  const top = (i: CatalogItem) => (i.topFor?.includes(f.agent!) ? 0 : 1);
  return [...out].sort((a, b) => top(a) - top(b));
}

/** How many items each category has for the agent (and kind / official filters), ignoring the category filter. */
export function categoryCounts(items: CatalogItem[], agent?: ShopAgent | null, extra: Pick<ShopFilter, 'kind' | 'officialOnly'> = {}): Record<CategoryId, number> {
  const c = Object.fromEntries(Object.keys(CATEGORIES).map((k) => [k, 0])) as Record<CategoryId, number>;
  for (const i of filterCatalog(items, { agent, ...extra })) c[i.category]++;
  return c;
}

/** How many items of each kind there are for the agent and category. */
export function kindCounts(items: CatalogItem[], f: Pick<ShopFilter, 'agent' | 'category' | 'officialOnly'> = {}): Partial<Record<SkillKind, number>> {
  const c: Partial<Record<SkillKind, number>> = {};
  for (const i of filterCatalog(items, f)) c[i.kind] = (c[i.kind] ?? 0) + 1;
  return c;
}
