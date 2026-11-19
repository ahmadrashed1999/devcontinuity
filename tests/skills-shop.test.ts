import { describe, expect, it } from 'vitest';
import { CATALOG, CATEGORIES, KIND_LABELS, POPULAR_STARS, SHOP_AGENTS, SKILL_KINDS, categoryCounts, filterCatalog, installSteps, isPopular, itemAgents, kindCounts, mcpInstall, skillsCli } from '../src/lib/skills-catalog';

const every = (agent: (typeof SHOP_AGENTS)[number]) => filterCatalog(CATALOG, { agent });

describe('Agent Skills Shop catalog', () => {
  it('is a large catalog with unique ids', () => {
    expect(CATALOG.length).toBeGreaterThanOrEqual(80);
    const ids = CATALOG.map((i) => i.id);
    expect(new Set(ids).size, `duplicate ids: ${ids.filter((x, k) => ids.indexOf(x) !== k).join(', ')}`).toBe(ids.length);
    for (const i of CATALOG) expect(i.id, i.id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
  });

  it('has complete English and Arabic text and at least one way to install every item', () => {
    for (const i of CATALOG) {
      expect(i.name.trim(), i.id).toBeTruthy();
      expect(i.publisher.trim(), i.id).toBeTruthy();
      expect(i.summary.en && i.summary.ar, i.id).toBeTruthy();
      expect(/[؀-ۿ]/.test(i.summary.ar), `${i.id} Arabic summary`).toBe(true);
      expect(i.benefits.en.length, `${i.id} benefits`).toBeGreaterThan(0);
      expect(i.benefits.ar.length, `${i.id} benefits`).toBe(i.benefits.en.length);
      expect(i.usage.ar.length, `${i.id} usage`).toBe(i.usage.en.length);
      for (const s of [...i.benefits.ar, ...i.usage.ar]) expect(s.trim(), i.id).toBeTruthy();
      expect(i.url, i.id).toMatch(/^https:\/\/[^\s]+$/);
      expect(KIND_LABELS[i.kind], i.id).toBeTruthy();
      expect(CATEGORIES[i.category], i.id).toBeTruthy();
      if (i.requires) expect(i.requires.en && i.requires.ar, i.id).toBeTruthy();
      if (i.stars !== undefined) expect(i.stars, i.id).toBeGreaterThan(0);
      const agents = itemAgents(i);
      expect(agents.length, `${i.id} agents`).toBeGreaterThan(0);
      for (const a of agents) {
        const steps = installSteps(i, a);
        expect(steps?.length, `${i.id} on ${a}`).toBeGreaterThan(0);
        for (const s of steps!) {
          expect(s.text.trim(), `${i.id} on ${a}`).toBeTruthy();
          if (s.how === 'file') expect(s.target, `${i.id} on ${a}`).toBeTruthy();
          if (s.how === 'ui') expect(s.note?.en && s.note.ar, `${i.id} on ${a}: UI steps need instructions`).toBeTruthy();
          if (s.note) expect(s.note.en && s.note.ar, `${i.id} on ${a} note`).toBeTruthy();
        }
      }
      for (const a of i.topFor ?? []) expect(agents, `${i.id} is a top pick for ${a} but does not work there`).toContain(a);
      for (const a of SHOP_AGENTS.filter((x) => !agents.includes(x))) expect(installSteps(i, a), `${i.id} on ${a}`).toBeNull();
    }
  });

  it('never ships a real-looking secret, only placeholders', () => {
    for (const i of CATALOG) for (const a of itemAgents(i)) for (const s of installSteps(i, a) ?? []) {
      expect(s.text, `${i.id}/${a}`).not.toMatch(/(ghp_|github_pat_|sk-[A-Za-z0-9]{20}|ntn_[A-Za-z0-9]{10})/);
    }
    // Credentials in env/headers are always <placeholders> the user fills in.
    for (const i of CATALOG) for (const [k, v] of [...Object.entries(i.mcp?.env ?? {}), ...Object.entries(i.mcp?.headers ?? {})]) {
      if (/key|token|secret|password|auth/i.test(k)) expect(v, `${i.id} ${k}`).toMatch(/^<[^>]+>$/);
    }
  });

  it('uses every category, every agent gets a good selection with top picks, and ponytail is in', () => {
    const counts = categoryCounts(CATALOG);
    for (const c of Object.keys(CATEGORIES) as (keyof typeof CATEGORIES)[]) expect(counts[c], c).toBeGreaterThan(0);
    for (const a of SHOP_AGENTS) {
      expect(every(a).length, a).toBeGreaterThanOrEqual(45);
      expect(every(a).filter((i) => i.topFor?.includes(a)).length, `${a} top picks`).toBeGreaterThanOrEqual(3);
    }
    const ponytail = CATALOG.find((i) => i.id === 'ponytail')!;
    expect(ponytail.url).toBe('https://github.com/DietrichGebert/ponytail');
    expect(installSteps(ponytail, 'claude-code')!.map((s) => s.text)).toEqual(['/plugin marketplace add DietrichGebert/ponytail', '/plugin install ponytail@ponytail']);
    expect(installSteps(ponytail, 'codex')!.map((s) => s.text)).toEqual(['codex plugin marketplace add DietrichGebert/ponytail', 'codex plugin add ponytail@ponytail']);
    expect(itemAgents(ponytail)).toEqual([...SHOP_AGENTS]);
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
    // Headers reach every agent's format, including Codex (http_headers).
    const hdr = { url: 'https://21st.dev/api/mcp', headers: { 'x-api-key': '<your key>' } };
    expect(mcpInstall('magic', hdr, 'codex')[0].text).toBe('[mcp_servers.magic]\nurl = "https://21st.dev/api/mcp"\nhttp_headers = { "x-api-key" = "<your key>" }');
    expect(mcpInstall('magic', hdr, 'claude-code')[0].text).toContain('--header "x-api-key: <your key>"');
    // URLs with & are quoted for the shell.
    expect(mcpInstall('neon', { url: 'https://mcp.neon.tech/mcp?a=1&b=2' }, 'claude-code')[0].text).toContain('"https://mcp.neon.tech/mcp?a=1&b=2"');
    // Every JSON config any item renders is valid JSON; every TOML block names its server table.
    for (const i of CATALOG) for (const a of itemAgents(i)) for (const s of installSteps(i, a) ?? []) {
      if (s.how === 'file' && /\.json/.test(s.target ?? '')) expect(() => JSON.parse(s.text), `${i.id}/${a}`).not.toThrow();
      if (s.how === 'file' && /\.toml$/.test(s.target ?? '')) expect(s.text, `${i.id}/${a}`).toMatch(/^\[mcp_servers\.[a-z0-9-]+\]/);
    }
  });

  it('prepends setup steps and uses the skills CLI ids for every agent', () => {
    const serena = CATALOG.find((i) => i.id === 'serena')!;
    expect(installSteps(serena, 'cursor')![0].text).toBe('uv tool install -p 3.13 serena-agent');
    expect(installSteps(serena, 'claude-code')!.at(-1)!.text).toContain('--context claude-code');
    const s = skillsCli('vercel-labs/agent-skills', { skill: 'web-design-guidelines' });
    expect(s.copilot![0].text).toBe('npx skills add vercel-labs/agent-skills -a github-copilot --skill web-design-guidelines');
    expect(s.kiro![0].text).toBe('npx skills add vercel-labs/agent-skills -a kiro-cli --skill web-design-guidelines');
    expect(Object.keys(s).sort()).toEqual([...SHOP_AGENTS].sort());
  });

  it('filters by agent, category, kind, official and text, with the agent\'s top picks first', () => {
    const codex = filterCatalog(CATALOG, { agent: 'codex' });
    expect(codex.every((i) => itemAgents(i).includes('codex'))).toBe(true);
    const firstNonTop = codex.findIndex((i) => !i.topFor?.includes('codex'));
    expect(codex.slice(firstNonTop).some((i) => i.topFor?.includes('codex'))).toBe(false);
    expect(filterCatalog(CATALOG, { category: 'browser' }).map((i) => i.id).sort()).toEqual(['chrome-devtools', 'playwright']);
    expect(filterCatalog(CATALOG, { q: 'ponytail' }).map((i) => i.id)).toEqual(['ponytail']);
    expect(filterCatalog(CATALOG, { q: 'المتصفح' }).length).toBeGreaterThan(0);
    const mcp = filterCatalog(CATALOG, { kind: 'mcp' });
    expect(mcp.length).toBeGreaterThan(30);
    expect(mcp.every((i) => i.kind === 'mcp')).toBe(true);
    const official = filterCatalog(CATALOG, { officialOnly: true, agent: 'gemini-cli' });
    expect(official.length).toBeGreaterThan(10);
    expect(official.every((i) => i.official && itemAgents(i).includes('gemini-cli'))).toBe(true);
    expect(filterCatalog(CATALOG, { kind: 'extension', agent: 'claude-code' }).every((i) => i.kind === 'extension')).toBe(true);
  });

  it('sorts by stars and by name, and marks popular items', () => {
    const byStars = filterCatalog(CATALOG, { sort: 'stars' });
    const stars = byStars.map((i) => i.stars ?? -1);
    expect([...stars].sort((a, b) => b - a)).toEqual(stars);
    const names = filterCatalog(CATALOG, { sort: 'name' }).map((i) => i.name);
    expect([...names].sort((a, b) => a.localeCompare(b))).toEqual(names);
    expect(CATALOG.filter(isPopular).length).toBeGreaterThan(10);
    expect(CATALOG.filter(isPopular).every((i) => (i.stars ?? 0) >= POPULAR_STARS)).toBe(true);
  });

  it('counts categories and kinds consistently with the filters', () => {
    for (const a of [null, ...SHOP_AGENTS]) {
      const counts = categoryCounts(CATALOG, a, { kind: 'mcp' });
      expect(Object.values(counts).reduce((x, y) => x + y, 0)).toBe(filterCatalog(CATALOG, { agent: a, kind: 'mcp' }).length);
    }
    const kinds = kindCounts(CATALOG, { agent: 'cursor' });
    expect(Object.values(kinds).reduce((x, y) => x + (y ?? 0), 0)).toBe(filterCatalog(CATALOG, { agent: 'cursor' }).length);
    for (const k of Object.keys(kinds)) expect(SKILL_KINDS).toContain(k);
  });
});
