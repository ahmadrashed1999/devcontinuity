import path from 'node:path';
import { AGENT_NAMES, agentName } from '../../lib/format';
import { getSetting } from '../db';
import { aiderAdapter } from './aider';
import { antigravityAdapter } from './antigravity';
import { chatgptAdapter, claudeAiAdapter } from './chat-exports';
import { claudeCodeAdapter } from './claude-code';
import { clineAdapter } from './cline';
import { codexAdapter } from './codex';
import { continueAdapter } from './continue';
import { copilotAdapter } from './copilot';
import { cursorAdapter } from './cursor';
import { genericAdapter } from './generic';
import { liveAdapter } from './live';
import { opencodeAdapter } from './opencode';
import { zedAdapter } from './zed';
import type { AgentAdapter, AgentId } from './types';

/** Adapter registry. Adding support for another agent means adding one module here. */
export const ADAPTERS: AgentAdapter[] = [claudeCodeAdapter, codexAdapter, opencodeAdapter, antigravityAdapter, clineAdapter, copilotAdapter, continueAdapter, cursorAdapter, aiderAdapter, zedAdapter, chatgptAdapter, claudeAiAdapter, liveAdapter, genericAdapter];

export function getAdapter(id: string): AgentAdapter {
  const a = ADAPTERS.find((x) => x.id === id);
  if (!a) throw new Error(`Unknown agent adapter: ${id}`);
  return a;
}

/**
 * Display names for every agent id a session can carry. Sessions store the agent that produced
 * them, which is not always an adapter id (live capture from Gemini CLI, Roo Code via the Cline adapter).
 */
export const AGENT_LABELS: Record<string, string> = { ...Object.fromEntries(ADAPTERS.map((a) => [a.id, a.label])), ...AGENT_NAMES };

export const agentLabel = agentName;

/** Data roots per agent: defaults plus any extra directories configured in Settings. */
export async function resolveRoots(agent: AgentId): Promise<string[]> {
  const adapter = getAdapter(agent);
  const custom = await getSetting<Record<string, string[]>>('agentRoots', {});
  const extra = (custom[agent] ?? []).filter((r) => typeof r === 'string' && r.trim()).map((r) => path.resolve(r.trim()));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of [...adapter.defaultRoots(), ...extra]) {
    const k = r.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      out.push(r);
    }
  }
  return out;
}

export * from './types';
