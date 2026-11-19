/**
 * Shared types and install renderers for the Agent Skills Shop catalog.
 * Pure data + functions (no server imports): used by the /skills page and the tests.
 */

export type Lang2 = { en: string; ar: string };
export type Lines2 = { en: string[]; ar: string[] };

export const SHOP_AGENTS = ['claude-code', 'codex', 'cursor', 'gemini-cli', 'copilot', 'windsurf', 'opencode', 'antigravity', 'kiro', 'cline'] as const;
export type ShopAgent = (typeof SHOP_AGENTS)[number];

export const SHOP_AGENT_LABELS: Record<ShopAgent, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  'gemini-cli': 'Gemini CLI',
  copilot: 'GitHub Copilot (VS Code)',
  windsurf: 'Windsurf',
  opencode: 'OpenCode',
  antigravity: 'Antigravity',
  kiro: 'Kiro',
  cline: 'Cline',
};

export const CATEGORIES = {
  workflow: { en: 'Skills packs & workflows', ar: 'حزم المهارات وسير العمل', icon: 'sparkles' },
  review: { en: 'Code review & quality', ar: 'مراجعة الكود والجودة', icon: 'review' },
  testing: { en: 'Testing & TDD', ar: 'الاختبارات وTDD', icon: 'flask' },
  browser: { en: 'Browser automation', ar: 'أتمتة المتصفح', icon: 'globe' },
  frontend: { en: 'Frontend & design', ar: 'الواجهات والتصميم', icon: 'palette' },
  docs: { en: 'Up-to-date docs', ar: 'توثيق محدّث', icon: 'book' },
  search: { en: 'Web search & research', ar: 'البحث في الويب', icon: 'search' },
  memory: { en: 'Memory & context', ar: 'الذاكرة والسياق', icon: 'brain' },
  reasoning: { en: 'Code intelligence & planning', ar: 'فهم الكود والتخطيط', icon: 'list' },
  data: { en: 'Databases & backend', ar: 'قواعد البيانات والخلفية', icon: 'database' },
  devops: { en: 'DevOps & cloud', ar: 'DevOps والسحابة', icon: 'cloud' },
  security: { en: 'Security', ar: 'الأمان', icon: 'shield' },
  debugging: { en: 'Errors & monitoring', ar: 'الأخطاء والمراقبة', icon: 'bug' },
  ml: { en: 'Data science & ML', ar: 'علم البيانات وتعلّم الآلة', icon: 'chart' },
  mobile: { en: 'Mobile', ar: 'تطبيقات الجوال', icon: 'phone' },
  pm: { en: 'GitHub & project management', ar: 'GitHub وإدارة المشاريع', icon: 'git' },
  writing: { en: 'Documents & writing', ar: 'المستندات والكتابة', icon: 'file' },
  rules: { en: 'Project rules & guardrails', ar: 'قواعد المشروع والضوابط', icon: 'scroll' },
} as const satisfies Record<string, Lang2 & { icon: string }>;
export type CategoryId = keyof typeof CATEGORIES;

export const SKILL_KINDS = ['mcp', 'skill', 'plugin', 'extension', 'subagent', 'rules', 'hook', 'prompt', 'tool'] as const;
export type SkillKind = (typeof SKILL_KINDS)[number];
export const KIND_LABELS: Record<SkillKind, Lang2> = {
  mcp: { en: 'MCP server', ar: 'خادم MCP' },
  skill: { en: 'Skill', ar: 'مهارة' },
  plugin: { en: 'Plugin', ar: 'إضافة' },
  extension: { en: 'Extension', ar: 'امتداد' },
  subagent: { en: 'Sub-agents', ar: 'وكلاء فرعيون' },
  rules: { en: 'Rules file', ar: 'ملف قواعد' },
  hook: { en: 'Hook', ar: 'خطّاف (Hook)' },
  prompt: { en: 'Custom command', ar: 'أمر مخصص' },
  tool: { en: 'CLI tool', ar: 'أداة سطر أوامر' },
};

export interface McpDef {
  /** Local (stdio) server. */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** Remote (streamable HTTP) server. */
  url?: string;
  headers?: Record<string, string>;
}

export interface InstallStep {
  /** Where the text goes: a command to run, a file to create/edit, or a value to paste in the agent's own UI (see note). */
  how: 'command' | 'file' | 'ui';
  /** File path for how = 'file'. */
  target?: string;
  text: string;
  note?: Lang2;
}

export interface CatalogItem {
  id: string;
  name: string;
  kind: SkillKind;
  category: CategoryId;
  publisher: string;
  official: boolean;
  url: string;
  summary: Lang2;
  benefits: Lines2;
  usage: Lines2;
  /** Example prompts to try once installed (prompts stay in English: agents understand both). */
  examples: string[];
  requires?: Lang2;
  /** MCP servers: one definition, rendered for every agent. */
  mcp?: McpDef;
  /** Steps shown before the agent-specific ones on every agent (e.g. install the server's CLI). */
  setup?: InstallStep[];
  /** Agents the item works with. For MCP servers this defaults to every agent in SHOP_AGENTS. */
  agents?: ShopAgent[];
  /** Explicit install steps (non-MCP items, or overrides). */
  install?: Partial<Record<ShopAgent, InstallStep[]>>;
  /** Agents for which this is a top pick. */
  topFor?: ShopAgent[];
  /** GitHub stars of the item's repository when it was last checked (see STARS_CHECKED). */
  stars?: number;
}

/** When the `stars` numbers were read from the GitHub API. */
export const STARS_CHECKED = '2026-11-19';
/** Items at or above this many stars get the "popular" marker. */
export const POPULAR_STARS = 10_000;

const q = (s: string) => (/[\s"'&]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);
const tomlStr = (s: string) => JSON.stringify(s);

/** Install steps for an MCP server in one agent, in that agent's own config format. */
export function mcpInstall(name: string, m: McpDef, agent: ShopAgent): InstallStep[] {
  const env = m.env && Object.keys(m.env).length ? m.env : undefined;
  const local = { command: m.command ?? '', args: m.args ?? [], ...(env ? { env } : {}) };
  const json = (obj: unknown) => JSON.stringify(obj, null, 2);
  const remoteNote = { en: 'Remote server: your agent connects to it over HTTPS and signs in when asked.', ar: 'خادم بعيد: يتصل به الوكيل عبر HTTPS ويطلب تسجيل الدخول عند الحاجة.' };
  switch (agent) {
    case 'claude-code':
      if (m.url) return [{ how: 'command', text: `claude mcp add --scope user --transport http ${name} ${q(m.url)}${Object.entries(m.headers ?? {}).map(([k, v]) => ` --header ${q(`${k}: ${v}`)}`).join('')}`, note: remoteNote }];
      return [{ how: 'command', text: `claude mcp add --scope user ${name}${Object.entries(env ?? {}).map(([k, v]) => ` -e ${k}=${q(v)}`).join('')} -- ${[m.command, ...(m.args ?? [])].map((x) => q(x ?? '')).join(' ')}` }];
    case 'codex':
      if (m.url) return [{ how: 'file', target: '~/.codex/config.toml', text: `[mcp_servers.${name}]\nurl = ${tomlStr(m.url)}${m.headers ? `\nhttp_headers = { ${Object.entries(m.headers).map(([k, v]) => `${tomlStr(k)} = ${tomlStr(v)}`).join(', ')} }` : ''}`, note: { en: 'Remote servers need a recent Codex version.', ar: 'الخوادم البعيدة تحتاج إصدارًا حديثًا من Codex.' } }];
      return [{ how: 'file', target: '~/.codex/config.toml', text: `[mcp_servers.${name}]\ncommand = ${tomlStr(m.command ?? '')}\nargs = ${JSON.stringify(m.args ?? [])}${env ? `\nenv = { ${Object.entries(env).map(([k, v]) => `${k} = ${tomlStr(v)}`).join(', ')} }` : ''}` }];
    case 'cursor':
      return [{ how: 'file', target: '~/.cursor/mcp.json', text: json({ mcpServers: { [name]: m.url ? { url: m.url, ...(m.headers ? { headers: m.headers } : {}) } : local } }) }];
    case 'gemini-cli':
      return [{ how: 'file', target: '~/.gemini/settings.json', text: json({ mcpServers: { [name]: m.url ? { httpUrl: m.url, ...(m.headers ? { headers: m.headers } : {}) } : local } }) }];
    case 'copilot':
      return [{ how: 'file', target: '.vscode/mcp.json', text: json({ servers: { [name]: m.url ? { type: 'http', url: m.url, ...(m.headers ? { headers: m.headers } : {}) } : { type: 'stdio', ...local } } }), note: { en: 'Or run "MCP: Add Server" from the VS Code command palette. Use Agent mode in Copilot Chat.', ar: 'أو شغّل "MCP: Add Server" من لوحة أوامر VS Code، واستخدم وضع Agent في Copilot Chat.' } }];
    case 'windsurf':
      return [{ how: 'file', target: '~/.codeium/windsurf/mcp_config.json', text: json({ mcpServers: { [name]: m.url ? { serverUrl: m.url, ...(m.headers ? { headers: m.headers } : {}) } : local } }) }];
    case 'opencode':
      return [{ how: 'file', target: '~/.config/opencode/opencode.json', text: json({ mcp: { [name]: m.url ? { type: 'remote', url: m.url, ...(m.headers ? { headers: m.headers } : {}) } : { type: 'local', command: [m.command, ...(m.args ?? [])], ...(env ? { environment: env } : {}) } } }) }];
    case 'antigravity':
      return [{ how: 'file', target: '~/.gemini/antigravity/mcp_config.json', text: json({ mcpServers: { [name]: m.url ? { serverUrl: m.url, ...(m.headers ? { headers: m.headers } : {}) } : local } }), note: { en: 'Or Agent panel → … → MCP Servers → Manage. Refresh after editing.', ar: 'أو من لوحة الوكيل ← … ← MCP Servers ← Manage، ثم حدّث بعد التعديل.' } }];
    case 'kiro':
      return [{ how: 'file', target: '~/.kiro/settings/mcp.json', text: json({ mcpServers: { [name]: m.url ? { url: m.url, ...(m.headers ? { headers: m.headers } : {}) } : local } }) }];
    case 'cline':
      return [{ how: 'file', target: 'cline_mcp_settings.json (Cline → MCP Servers → Configure)', text: json({ mcpServers: { [name]: m.url ? { url: m.url, type: 'streamableHttp', ...(m.headers ? { headers: m.headers } : {}) } : local } }) }];
  }
}

/** Agent ids used by the open skills CLI (`npx skills add … -a <id>`, github.com/vercel-labs/skills docs/agents.md). */
export const SKILLS_CLI_AGENT: Record<ShopAgent, string> = {
  'claude-code': 'claude-code',
  codex: 'codex',
  cursor: 'cursor',
  'gemini-cli': 'gemini-cli',
  copilot: 'github-copilot',
  windsurf: 'windsurf',
  opencode: 'opencode',
  antigravity: 'antigravity',
  kiro: 'kiro-cli',
  cline: 'cline',
};

/**
 * Install steps for an Agent Skills repository through the open skills CLI, for the given agents
 * (default: every agent). Only used for repositories that document `npx skills add`.
 */
export function skillsCli(source: string, opts: { skill?: string; agents?: readonly ShopAgent[] } = {}): Partial<Record<ShopAgent, InstallStep[]>> {
  const note = { en: 'The skills CLI copies the skills into this agent\'s skills folder. Add --global to install for your user instead of this project.', ar: 'تنسخ أداة skills المهارات إلى مجلد مهارات هذا الوكيل. أضف ‎--global للتثبيت لمستخدمك بدل هذا المشروع.' };
  return Object.fromEntries((opts.agents ?? SHOP_AGENTS).map((a) => [a, [{ how: 'command', text: `npx skills add ${source} -a ${SKILLS_CLI_AGENT[a]}${opts.skill ? ` --skill ${q(opts.skill)}` : ''}`, note }]]));
}

/** One command for a list of agents. */
export function sameCommand(agents: readonly ShopAgent[], text: string, note?: Lang2): Partial<Record<ShopAgent, InstallStep[]>> {
  return Object.fromEntries(agents.map((a) => [a, [{ how: 'command', text, ...(note ? { note } : {}) }]]));
}

/** Two Claude Code plugin commands: add a marketplace, then install a plugin from it. */
export function claudePlugin(marketplace: string | null, plugin: string): InstallStep[] {
  return [
    ...(marketplace ? [{ how: 'command' as const, text: `/plugin marketplace add ${marketplace}` }] : []),
    { how: 'command', text: `/plugin install ${plugin}`, note: marketplace ? { en: 'Send these as two separate prompts inside Claude Code, then restart it.', ar: 'أرسلهما كطلبين منفصلين داخل Claude Code، ثم أعد تشغيله.' } : { en: 'Inside Claude Code. The official marketplace is already registered.', ar: 'داخل Claude Code. السوق الرسمي مسجّل مسبقًا.' } },
  ];
}

export function worksWith(item: CatalogItem, agent: ShopAgent): boolean {
  if (item.agents) return item.agents.includes(agent);
  if (item.mcp) return true;
  return !!item.install?.[agent];
}

/** The install steps of an item in one agent, or null if it does not work there. */
export function installSteps(item: CatalogItem, agent: ShopAgent): InstallStep[] | null {
  if (!worksWith(item, agent)) return null;
  const own = item.install?.[agent] ?? (item.mcp ? mcpInstall(item.id, item.mcp, agent) : null);
  if (!own) return null;
  return [...(item.setup ?? []), ...own];
}

export function itemAgents(item: CatalogItem): ShopAgent[] {
  return SHOP_AGENTS.filter((a) => worksWith(item, a));
}

export const ALL_AGENTS: ShopAgent[] = [...SHOP_AGENTS];
