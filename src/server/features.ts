import { getSetting, setSetting } from './db';

/**
 * Optional modules. The core product (capturing, searching and continuing every agent's work)
 * is always on. The AI organization (CEO, departments, workers running in sandboxes) is an
 * experimental add-on: off by default, its data is kept when it is switched off.
 */
export interface Features {
  aiOrg: boolean;
}

const DEFAULTS: Features = { aiOrg: false };

export async function getFeatures(): Promise<Features> {
  const f = await getSetting<Partial<Features>>('features', {});
  return { ...DEFAULTS, ...Object.fromEntries(Object.entries(f).filter(([, v]) => typeof v === 'boolean')) };
}

export async function setFeatures(patch: Partial<Features>): Promise<Features> {
  const next = { ...(await getFeatures()), ...Object.fromEntries(Object.entries(patch).filter(([k, v]) => k in DEFAULTS && typeof v === 'boolean')) };
  await setSetting('features', next);
  return next;
}

let cache: { at: number; value: boolean } | undefined;
/** Cached for a few seconds: the orchestrator asks on every tick. */
export async function aiOrgEnabled(): Promise<boolean> {
  if (cache && Date.now() - cache.at < 10_000) return cache.value;
  const value = (await getFeatures()).aiOrg;
  cache = { at: Date.now(), value };
  return value;
}
