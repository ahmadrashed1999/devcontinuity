import { describe, expect, it } from 'vitest';
import { CATALOG, CATEGORIES, SHOP_AGENTS, categoryCounts, filterCatalog, installSteps, itemAgents, mcpInstall } from '../src/lib/skills-catalog';

describe('Agent Skills Shop catalog', () => {
  it('has complete English and Arabic text and at least one way to install every item', () => {
    const ids = new Set<string>();
    for (const i of CATALOG) {
      expect(ids.has(i.id), `duplicate id ${i.id}`).toBe(false);
      ids.add(i.id);
      expect(i.summary.en && i.summary.ar, i.id).toBeTruthy();
      expect(i.benefits.ar.length, `${i.id} benefits`).toBe(i.benefits.en.length);
      expect(i.usage.ar.length, `${i.id} usage`).toBe(i.usage.en.length);
      expect(i.url).toMatch(/^https:\/\//);
      const agents = itemAgents(i);
      expect(agents.length, `${i.id} agents`).toBeGreaterThan(0);
      for (const a of agents) expect(installSteps(i, a)?.length, `${i.id} on ${a}`).toBeGreaterThan(0);
      if (i.requires) expect(i.requires.ar).toBeTruthy();
    }
  });

  it('uses every category and gives every agent at least three items', () => {
    const counts = categoryCounts(CATALOG);
    for (const c of Object.keys(CATEGORIES) as (keyof typeof CATEGORIES)[]) expect(counts[c], c).toBeGreaterThan(0);
    for (const a of SHOP_AGENTS) expect(filterCatalog(CATALOG, { agent: a }).length, a).toBeGreaterThanOrEqual(3);
  });

  it('renders one MCP definition into each agent\'s own config format', () => {
    const local = { command: 'npx', args: ['-y', '@upstash/context7-mcp'] };
    expect(mcpInstall('context7', local, 'claude-code')[0].text).toBe('claude mcp add --scope user context7 -- npx -y @upstash/context7-mcp');
    expect(mcpInstall('context7', local, 'codex')[0].text).toBe('[mcp_servers.context7]\ncommand = "npx"\nargs = ["-y","@upstash/context7-mcp"]');
    expect(JSON.parse(mcpInstall('context7', local, 'cursor')[0].text)).toEqual({ mcpServers: { context7: { command: 'npx', args: ['-y', '@upstash/context7-mcp'] } } });
    expect(JSON.parse(mcpInstall('context7', local, 'copilot')[0].text).servers.context7.type).toBe('stdio');
    expect(JSON.parse(mcpInstall('context7', local, 'opencode')[0].text).mcp.context7).toEqual({ type: 'local', command: ['npx', '-y', '@upstash/context7-mcp'] });
    const remote = { url: 'https://mcp.sentry.dev/mcp' };
    expect(mcpInstall('sentry', remote, 'claude-code')[0].text).toBe('claude mcp add --scope user --transport http sentry https://mcp.sentry.dev/mcp');
    expect(JSON.parse(mcpInstall('sentry', remote, 'gemini-cli')[0].text).mcpServers.sentry).toEqual({ httpUrl: 'https://mcp.sentry.dev/mcp' });
    expect(JSON.parse(mcpInstall('sentry', remote, 'windsurf')[0].text).mcpServers.sentry).toEqual({ serverUrl: 'https://mcp.sentry.dev/mcp' });
    const withEnv = mcpInstall('github', { command: 'docker', args: ['run', '-i'], env: { TOKEN: '<your token>' } }, 'claude-code')[0].text;
    expect(withEnv).toBe('claude mcp add --scope user github -e TOKEN="<your token>" -- docker run -i');
    // Every JSON config any item renders is valid JSON.
    for (const i of CATALOG) for (const a of itemAgents(i)) for (const s of installSteps(i, a) ?? []) if (s.how === 'file' && /\.json/.test(s.target ?? '')) expect(() => JSON.parse(s.text), `${i.id}/${a}`).not.toThrow();
  });

  it('filters by agent, category and text, with the agent\'s top picks first', () => {
    const codex = filterCatalog(CATALOG, { agent: 'codex' });
    expect(codex.every((i) => itemAgents(i).includes('codex'))).toBe(true);
    const firstNonTop = codex.findIndex((i) => !i.topFor?.includes('codex'));
    expect(codex.slice(firstNonTop).some((i) => i.topFor?.includes('codex'))).toBe(false);
    expect(filterCatalog(CATALOG, { category: 'browser' }).map((i) => i.id).sort()).toEqual(['chrome-devtools', 'playwright']);
    expect(filterCatalog(CATALOG, { q: 'figma' }).map((i) => i.id)).toEqual(['figma']);
    expect(filterCatalog(CATALOG, { q: 'المتصفح' }).length).toBeGreaterThan(0);
  });
});
