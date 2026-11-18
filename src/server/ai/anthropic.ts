import { z } from 'zod';
import { getSetting } from '../db';
import { AiError, ENV_ANTHROPIC_ID, Job, listProviderModels, listProviders, structured, testProvider } from './gateway';

/** Compatibility layer: older call sites use these helpers; everything routes through the AI Gateway. */
export { AiError };

export function hasApiKey(): boolean {
  return !!process.env.ANTHROPIC_API_KEY?.trim();
}

export async function aiStatus() {
  const providers = await listProviders();
  return {
    hasKey: hasApiKey() || providers.some((p) => p.hasKey && p.enabled),
    consent: await getSetting<boolean>('aiConsent', false),
    settingModel: (await getSetting<string>('aiModel', '')) || null,
    envModel: process.env.ANTHROPIC_MODEL?.trim() || null,
    detectedModel: null as string | null,
    providers: providers.length,
  };
}

export async function listModels(): Promise<{ id: string; name: string }[]> {
  const first = (await listProviders()).find((p) => p.enabled && p.hasKey);
  if (!first) throw new AiError('No AI provider is configured.', 412);
  return (await listProviderModels(first.id)).map((id) => ({ id, name: id }));
}

export async function testConnection() {
  const providers = await listProviders();
  const p = providers.find((x) => x.id === ENV_ANTHROPIC_ID) ?? providers.find((x) => x.enabled && x.hasKey);
  if (!p) throw new AiError('No AI provider is configured.', 412);
  const model = (await getSetting<string>('aiModel', '')) || process.env.ANTHROPIC_MODEL?.trim() || p.models[0] || (await listProviderModels(p.id))[0];
  return testProvider(p.id, model);
}

const FEATURE_JOB: Record<string, Job> = { 'session-analysis': 'summary', 'project-analysis': 'analysis' };

export async function structuredCall<S extends z.ZodType>(feature: string, schema: S, system: string, user: string, maxTokens = 4000) {
  return structured(FEATURE_JOB[feature] ?? 'analysis', schema, system, user, { maxTokens, ctx: { origin: 'owner' } });
}
