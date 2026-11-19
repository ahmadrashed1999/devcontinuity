/**
 * Agent Skills Shop: a curated, offline catalog of the most useful skills, MCP servers, plugins,
 * rules and extensions for AI coding agents. Nothing is downloaded or installed from here; every
 * entry says what it gives you, how to install it in each agent and how to use it. Install snippets
 * for MCP servers are generated from one definition per server, so every agent gets the same server.
 *
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
  memory: { en: 'Memory & context', ar: 'الذاكرة والسياق', icon: 'brain' },
  docs: { en: 'Up-to-date docs', ar: 'توثيق محدّث', icon: 'book' },
  browser: { en: 'Browser & UI testing', ar: 'المتصفح واختبار الواجهات', icon: 'globe' },
  github: { en: 'GitHub & code review', ar: 'GitHub ومراجعة الكود', icon: 'git' },
  design: { en: 'Design to code', ar: 'من التصميم إلى الكود', icon: 'palette' },
  data: { en: 'Databases & backend', ar: 'قواعد البيانات والخلفية', icon: 'database' },
  debugging: { en: 'Errors & debugging', ar: 'الأخطاء وتتبعها', icon: 'bug' },
  reasoning: { en: 'Planning & reasoning', ar: 'التخطيط والتفكير', icon: 'list' },
  workflow: { en: 'Workflow & skills packs', ar: 'سير العمل وحزم المهارات', icon: 'sparkles' },
  rules: { en: 'Project rules & guardrails', ar: 'قواعد المشروع والضوابط', icon: 'shield' },
  documents: { en: 'Documents & files', ar: 'المستندات والملفات', icon: 'file' },
} as const satisfies Record<string, Lang2 & { icon: string }>;
export type CategoryId = keyof typeof CATEGORIES;

export type SkillKind = 'mcp' | 'skill' | 'plugin' | 'rules' | 'subagent' | 'extension' | 'hook' | 'prompt';
export const KIND_LABELS: Record<SkillKind, Lang2> = {
  mcp: { en: 'MCP server', ar: 'خادم MCP' },
  skill: { en: 'Skill', ar: 'مهارة' },
  plugin: { en: 'Plugin', ar: 'إضافة' },
  rules: { en: 'Rules file', ar: 'ملف قواعد' },
  subagent: { en: 'Sub-agent', ar: 'وكيل فرعي' },
  extension: { en: 'Extension', ar: 'امتداد' },
  hook: { en: 'Hook', ar: 'خطّاف (Hook)' },
  prompt: { en: 'Custom command', ar: 'أمر مخصص' },
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
  /** Where the text goes: a command to run, or a file to create/edit. */
  how: 'command' | 'file';
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
  /** Agents the item works with. For MCP servers this defaults to every agent in SHOP_AGENTS. */
  agents?: ShopAgent[];
  /** Explicit install steps (non-MCP items, or overrides). */
  install?: Partial<Record<ShopAgent, InstallStep[]>>;
  /** Agents for which this is a top pick. */
  topFor?: ShopAgent[];
}

const q = (s: string) => (/[\s"']/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);
const tomlStr = (s: string) => JSON.stringify(s);

/** Install steps for an MCP server in one agent, in that agent's own config format. */
export function mcpInstall(name: string, m: McpDef, agent: ShopAgent): InstallStep[] {
  const env = m.env && Object.keys(m.env).length ? m.env : undefined;
  const local = { command: m.command ?? '', args: m.args ?? [], ...(env ? { env } : {}) };
  const json = (obj: unknown) => JSON.stringify(obj, null, 2);
  const remoteNote = { en: 'Remote server: your agent connects to it over HTTPS and signs in when asked.', ar: 'خادم بعيد: يتصل به الوكيل عبر HTTPS ويطلب تسجيل الدخول عند الحاجة.' };
  switch (agent) {
    case 'claude-code':
      if (m.url) return [{ how: 'command', text: `claude mcp add --scope user --transport http ${name} ${m.url}${Object.entries(m.headers ?? {}).map(([k, v]) => ` --header ${q(`${k}: ${v}`)}`).join('')}`, note: remoteNote }];
      return [{ how: 'command', text: `claude mcp add --scope user ${name}${Object.entries(env ?? {}).map(([k, v]) => ` -e ${k}=${q(v)}`).join('')} -- ${[m.command, ...(m.args ?? [])].map((x) => q(x ?? '')).join(' ')}` }];
    case 'codex':
      if (m.url) return [{ how: 'file', target: '~/.codex/config.toml', text: `[mcp_servers.${name}]\nurl = ${tomlStr(m.url)}`, note: { en: 'Remote servers need a recent Codex version.', ar: 'الخوادم البعيدة تحتاج إصدارًا حديثًا من Codex.' } }];
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
      return [{ how: 'file', target: '~/.gemini/antigravity/mcp_config.json', text: json({ mcpServers: { [name]: m.url ? { serverUrl: m.url } : local } }), note: { en: 'Or Agent panel → … → MCP Servers → Manage. Refresh after editing.', ar: 'أو من لوحة الوكيل ← … ← MCP Servers ← Manage، ثم حدّث بعد التعديل.' } }];
    case 'kiro':
      return [{ how: 'file', target: '~/.kiro/settings/mcp.json', text: json({ mcpServers: { [name]: m.url ? { url: m.url } : local } }) }];
    case 'cline':
      return [{ how: 'file', target: 'cline_mcp_settings.json (Cline → MCP Servers → Configure)', text: json({ mcpServers: { [name]: m.url ? { url: m.url, type: 'streamableHttp' } : local } }) }];
  }
}

/** Every agent an item works with, and its install steps there. */
export function installSteps(item: CatalogItem, agent: ShopAgent): InstallStep[] | null {
  if (item.install?.[agent]) return item.install[agent]!;
  if (item.mcp && worksWith(item, agent)) return mcpInstall(item.id, item.mcp, agent);
  return null;
}

export function worksWith(item: CatalogItem, agent: ShopAgent): boolean {
  if (item.agents) return item.agents.includes(agent);
  if (item.mcp) return true;
  return !!item.install?.[agent];
}

export function itemAgents(item: CatalogItem): ShopAgent[] {
  return SHOP_AGENTS.filter((a) => worksWith(item, a));
}

const ALL_TOP: ShopAgent[] = [...SHOP_AGENTS];

export const CATALOG: CatalogItem[] = [
  {
    id: 'devcontinuity',
    name: 'DevContinuity shared memory',
    kind: 'mcp',
    category: 'memory',
    publisher: 'DevContinuity',
    official: true,
    url: 'https://github.com/ahmadrashed1999/devcontinuity',
    summary: { en: 'Every agent sees what the others did in this project: requests, how sessions ended, open tasks, last errors.', ar: 'كل وكيل يرى ما فعله الآخرون في هذا المشروع: الطلبات، وكيف انتهت الجلسات، والمهام المفتوحة، وآخر الأخطاء.' },
    benefits: { en: ['No more redoing or undoing another agent\'s work', 'Continue after a usage limit in another agent', 'Agents leave notes for each other with log_summary'], ar: ['لا مزيد من تكرار عمل وكيل آخر أو التراجع عنه', 'تابع في وكيل آخر بعد الوصول إلى حد الاستخدام', 'الوكلاء يتركون ملاحظات لبعضهم عبر log_summary'] },
    usage: { en: ['Connect the agent once (command below; it previews and backs up the config).', 'Sync project rules with "Shared memory" ticked so agents call project_context at the start and log_summary at the end.'], ar: ['اربط الوكيل مرة واحدة (الأمر أدناه يعرض التغيير ويأخذ نسخة احتياطية).', 'زامن قواعد المشروع مع تفعيل "الذاكرة المشتركة" ليستدعي الوكلاء project_context في البداية وlog_summary في النهاية.'] },
    examples: ['Call project_context for this folder and tell me what the other agents did here this week.', 'Before you start, check project_context; when done, log_summary what you changed.'],
    agents: ['claude-code', 'codex', 'cursor', 'gemini-cli', 'windsurf', 'antigravity', 'kiro'],
    install: Object.fromEntries((['claude-code', 'codex', 'cursor', 'gemini-cli', 'windsurf', 'antigravity', 'kiro'] as ShopAgent[]).map((a) => [a, [{ how: 'command', text: `npx devcontinuity connect ${a} --yes` }]])),
    topFor: ALL_TOP,
  },
  {
    id: 'context7',
    name: 'Context7',
    kind: 'mcp',
    category: 'docs',
    publisher: 'Upstash',
    official: false,
    url: 'https://github.com/upstash/context7',
    summary: { en: 'Current, version-specific documentation and code examples for thousands of libraries, pulled into the prompt.', ar: 'توثيق وأمثلة كود حديثة ومطابقة للإصدار لآلاف المكتبات تُضاف إلى الطلب مباشرة.' },
    benefits: { en: ['Fewer hallucinated or outdated APIs', 'Works for fast-moving frameworks (Next.js, React, Tailwind…)', 'No API key needed for basic use'], ar: ['واجهات برمجية مخترعة أو قديمة أقل', 'مفيد للأطر سريعة التغير (Next.js وReact وTailwind…)', 'لا يحتاج مفتاحًا للاستخدام الأساسي'] },
    usage: { en: ['Add "use context7" to a prompt, or ask the agent to look up a library\'s docs.'], ar: ['أضف "use context7" إلى الطلب، أو اطلب من الوكيل البحث في توثيق مكتبة.'] },
    examples: ['Create a Next.js middleware that checks a JWT cookie. use context7', 'How do I configure Prisma with SQLite in the latest version? use context7'],
    mcp: { command: 'npx', args: ['-y', '@upstash/context7-mcp'] },
    topFor: ['claude-code', 'codex', 'cursor', 'gemini-cli', 'copilot', 'windsurf', 'opencode', 'cline'],
  },
  {
    id: 'playwright',
    name: 'Playwright MCP',
    kind: 'mcp',
    category: 'browser',
    publisher: 'Microsoft',
    official: true,
    url: 'https://github.com/microsoft/playwright-mcp',
    summary: { en: 'Lets the agent drive a real browser: open pages, click, type, read the page and take screenshots.', ar: 'يتيح للوكيل التحكم بمتصفح حقيقي: فتح الصفحات والنقر والكتابة وقراءة الصفحة والتقاط الصور.' },
    benefits: { en: ['The agent checks its own UI changes instead of guessing', 'Reproduce bugs and write end-to-end tests from what it sees', 'Uses the accessibility tree, so it is fast and precise'], ar: ['الوكيل يتحقق من تغييرات الواجهة بنفسه بدل التخمين', 'إعادة إنتاج الأخطاء وكتابة اختبارات شاملة مما يراه', 'يعتمد على شجرة الوصول فيكون سريعًا ودقيقًا'] },
    usage: { en: ['Start your dev server, then ask the agent to open it and verify the change.'], ar: ['شغّل خادم التطوير ثم اطلب من الوكيل فتحه والتحقق من التغيير.'] },
    examples: ['Open http://localhost:3000/login, sign in with the test user and confirm the dashboard loads.', 'Write a Playwright test for the checkout flow you just built.'],
    requires: { en: 'Node.js; downloads a browser on first use.', ar: 'Node.js، ويُنزّل متصفحًا عند أول استخدام.' },
    mcp: { command: 'npx', args: ['@playwright/mcp@latest'] },
    topFor: ['claude-code', 'codex', 'gemini-cli', 'opencode', 'cline', 'kiro'],
  },
  {
    id: 'chrome-devtools',
    name: 'Chrome DevTools MCP',
    kind: 'mcp',
    category: 'browser',
    publisher: 'Google Chrome team',
    official: true,
    url: 'https://github.com/ChromeDevTools/chrome-devtools-mcp',
    summary: { en: 'Chrome DevTools for the agent: console errors, network requests, performance traces and screenshots.', ar: 'أدوات مطوري Chrome للوكيل: أخطاء الكونسول وطلبات الشبكة وتتبع الأداء ولقطات الشاشة.' },
    benefits: { en: ['Debug front-end errors from real console and network data', 'Measure performance (LCP, long tasks) and get concrete fixes', 'Great with web frameworks and CSS issues'], ar: ['تتبع أخطاء الواجهة من بيانات الكونسول والشبكة الحقيقية', 'قياس الأداء (LCP والمهام الطويلة) واقتراح إصلاحات محددة', 'ممتاز مع أطر الويب ومشاكل CSS'] },
    usage: { en: ['Ask the agent to open your page and inspect the console, network or performance.'], ar: ['اطلب من الوكيل فتح الصفحة وفحص الكونسول أو الشبكة أو الأداء.'] },
    examples: ['Open localhost:3000, check the console and network tab, and fix the failing request.', 'Record a performance trace of the home page and suggest the top 3 fixes.'],
    requires: { en: 'Chrome installed; Node.js.', ar: 'متصفح Chrome مثبت، وNode.js.' },
    mcp: { command: 'npx', args: ['-y', 'chrome-devtools-mcp@latest'] },
    topFor: ['cursor', 'gemini-cli', 'antigravity'],
  },
  {
    id: 'github',
    name: 'GitHub MCP server',
    kind: 'mcp',
    category: 'github',
    publisher: 'GitHub',
    official: true,
    url: 'https://github.com/github/github-mcp-server',
    summary: { en: 'Issues, pull requests, reviews, Actions runs and code search from inside the agent.', ar: 'المشكلات وطلبات الدمج والمراجعات وتشغيلات Actions والبحث في الكود من داخل الوكيل.' },
    benefits: { en: ['Turn an issue into a branch and PR without leaving the chat', 'Read failing CI logs and fix them', 'Review PRs with full context'], ar: ['حوّل مشكلة إلى فرع وطلب دمج دون مغادرة المحادثة', 'اقرأ سجلات CI الفاشلة وأصلحها', 'راجع طلبات الدمج بسياق كامل'] },
    usage: { en: ['Create a fine-grained personal access token with only the repositories and permissions you need, and put it in the config.'], ar: ['أنشئ رمز وصول شخصي محدد الصلاحيات للمستودعات التي تحتاجها فقط، وضعه في الإعدادات.'] },
    examples: ['Summarize open issues labeled bug in this repo and propose an order to fix them.', 'Why did the last CI run on main fail? Fix it and open a PR.'],
    requires: { en: 'Docker and a GitHub personal access token (keep its scope small).', ar: 'Docker ورمز وصول شخصي من GitHub (اجعل صلاحياته ضيقة).' },
    mcp: { command: 'docker', args: ['run', '-i', '--rm', '-e', 'GITHUB_PERSONAL_ACCESS_TOKEN', 'ghcr.io/github/github-mcp-server'], env: { GITHUB_PERSONAL_ACCESS_TOKEN: '<your token>' } },
    topFor: ['claude-code', 'codex', 'cursor', 'windsurf'],
  },
  {
    id: 'figma',
    name: 'Figma Dev Mode MCP',
    kind: 'mcp',
    category: 'design',
    publisher: 'Figma',
    official: true,
    url: 'https://help.figma.com/hc/en-us/articles/32132100833559',
    summary: { en: 'Gives the agent the selected Figma frame: layout, variables, components and code hints.', ar: 'يعطي الوكيل الإطار المحدد في Figma: التخطيط والمتغيرات والمكوّنات وتلميحات الكود.' },
    benefits: { en: ['Pixel-closer UI from designs', 'Reuses your design tokens and components', 'Less back-and-forth with screenshots'], ar: ['واجهات أقرب للتصميم', 'يعيد استخدام رموز التصميم والمكوّنات', 'تقليل تبادل لقطات الشاشة'] },
    usage: { en: ['In the Figma desktop app enable the Dev Mode MCP server, select a frame, then ask the agent to build it.'], ar: ['فعّل خادم Dev Mode MCP في تطبيق Figma المكتبي، حدّد إطارًا، ثم اطلب من الوكيل بناءه.'] },
    examples: ['Implement the selected Figma frame as a React component using our existing Button and Card.'],
    requires: { en: 'Figma desktop app with a Dev or Full seat.', ar: 'تطبيق Figma المكتبي بمقعد Dev أو Full.' },
    mcp: { url: 'http://127.0.0.1:3845/mcp' },
    topFor: ['cursor', 'copilot', 'windsurf'],
  },
  {
    id: 'supabase',
    name: 'Supabase MCP',
    kind: 'mcp',
    category: 'data',
    publisher: 'Supabase',
    official: true,
    url: 'https://github.com/supabase-community/supabase-mcp',
    summary: { en: 'Query tables, inspect the schema, manage migrations and read logs of a Supabase project.', ar: 'استعلم عن الجداول، وافحص المخطط، وأدر الترحيلات، واقرأ سجلات مشروع Supabase.' },
    benefits: { en: ['Schema-aware SQL and migrations', 'Debug with real logs', 'Read-only mode for safety'], ar: ['SQL وترحيلات تعرف المخطط', 'تتبع الأخطاء بسجلات حقيقية', 'وضع القراءة فقط للأمان'] },
    usage: { en: ['Use a personal access token and keep --read-only on unless you really want the agent to change data. Point it at a development project, not production.'], ar: ['استخدم رمز وصول شخصي وأبقِ --read-only مفعّلًا ما لم تحتج فعلًا لتعديل البيانات، ووجّهه إلى مشروع تطوير لا الإنتاج.'] },
    examples: ['List tables without an RLS policy and propose policies.', 'Write a migration that adds an orders.status column with a check constraint.'],
    requires: { en: 'Supabase personal access token.', ar: 'رمز وصول شخصي من Supabase.' },
    mcp: { command: 'npx', args: ['-y', '@supabase/mcp-server-supabase@latest', '--read-only', '--access-token', '<your token>'] },
    topFor: ['cursor', 'windsurf'],
  },
  {
    id: 'sentry',
    name: 'Sentry MCP',
    kind: 'mcp',
    category: 'debugging',
    publisher: 'Sentry',
    official: true,
    url: 'https://docs.sentry.io/product/sentry-mcp/',
    summary: { en: 'Brings production errors, stack traces and releases into the agent so it can fix real issues.', ar: 'يجلب أخطاء الإنتاج وتتبعات المكدس والإصدارات إلى الوكيل ليصلح مشكلات حقيقية.' },
    benefits: { en: ['Fix bugs from the exact stack trace', 'Prioritize by frequency and users affected', 'Remote server, sign in with Sentry'], ar: ['أصلح الأخطاء من تتبع المكدس الدقيق', 'رتّب الأولويات حسب التكرار والمستخدمين المتأثرين', 'خادم بعيد مع تسجيل دخول Sentry'] },
    usage: { en: ['Add the server, sign in when prompted, then ask about an issue id or the top errors.'], ar: ['أضف الخادم، وسجّل الدخول عند الطلب، ثم اسأل عن رقم مشكلة أو أكثر الأخطاء.'] },
    examples: ['What are the top 5 unresolved Sentry issues in the web project? Fix the first one.'],
    requires: { en: 'A Sentry account.', ar: 'حساب Sentry.' },
    mcp: { url: 'https://mcp.sentry.dev/mcp' },
    topFor: ['claude-code', 'codex'],
  },
  {
    id: 'sequential-thinking',
    name: 'Sequential Thinking',
    kind: 'mcp',
    category: 'reasoning',
    publisher: 'Model Context Protocol',
    official: true,
    url: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking',
    summary: { en: 'A structured scratchpad for step-by-step plans that can be revised and branched.', ar: 'مسودة منظمة لخطط خطوة بخطوة يمكن مراجعتها وتفريعها.' },
    benefits: { en: ['Better plans for big refactors and migrations', 'Helps models without built-in extended thinking', 'Visible reasoning steps you can review'], ar: ['خطط أفضل لإعادة الهيكلة والترحيلات الكبيرة', 'يساعد النماذج التي لا تملك تفكيرًا موسعًا مدمجًا', 'خطوات تفكير ظاهرة يمكنك مراجعتها'] },
    usage: { en: ['Ask the agent to "think it through step by step with sequential thinking" before a complex change.'], ar: ['اطلب من الوكيل "التفكير خطوة بخطوة باستخدام sequential thinking" قبل أي تغيير معقد.'] },
    examples: ['Use sequential thinking to plan moving our auth from sessions to JWT without downtime.'],
    mcp: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'] },
    topFor: ['opencode', 'cline', 'kiro', 'copilot'],
  },
  {
    id: 'serena',
    name: 'Serena',
    kind: 'mcp',
    category: 'reasoning',
    publisher: 'Oraios AI',
    official: false,
    url: 'https://github.com/oraios/serena',
    summary: { en: 'Semantic code tools (find symbol, references, symbol-level edits) through language servers.', ar: 'أدوات كود دلالية (إيجاد الرموز والمراجع والتعديل على مستوى الرمز) عبر خوادم اللغة.' },
    benefits: { en: ['Precise edits in large codebases', 'Fewer tokens than reading whole files', 'Works across many languages'], ar: ['تعديلات دقيقة في قواعد كود كبيرة', 'رموز (tokens) أقل من قراءة ملفات كاملة', 'يدعم لغات كثيرة'] },
    usage: { en: ['Start your agent in the project folder; Serena indexes it on first use.'], ar: ['شغّل الوكيل في مجلد المشروع؛ يقوم Serena بفهرسته عند أول استخدام.'] },
    examples: ['Find every caller of PaymentService.refund and update them for the new signature.'],
    requires: { en: 'uv (Python package manager).', ar: 'أداة uv لبايثون.' },
    mcp: { command: 'uvx', args: ['--from', 'git+https://github.com/oraios/serena', 'serena', 'start-mcp-server'] },
    topFor: ['claude-code', 'codex', 'opencode'],
  },
  {
    id: 'anthropic-skills',
    name: 'Anthropic Agent Skills',
    kind: 'skill',
    category: 'documents',
    publisher: 'Anthropic',
    official: true,
    url: 'https://github.com/anthropics/skills',
    summary: { en: 'Ready-made Claude skills: Word, Excel, PowerPoint and PDF files, plus examples for testing web apps and building MCP servers.', ar: 'مهارات جاهزة لـ Claude: ملفات Word وExcel وPowerPoint وPDF، وأمثلة لاختبار تطبيقات الويب وبناء خوادم MCP.' },
    benefits: { en: ['Claude creates and edits real office documents', 'Loaded only when needed, so they cost no context otherwise', 'Templates for writing your own skills'], ar: ['Claude ينشئ ويعدّل مستندات مكتبية حقيقية', 'تُحمَّل عند الحاجة فقط فلا تستهلك السياق', 'قوالب لكتابة مهاراتك الخاصة'] },
    usage: { en: ['Install the plugin, then just ask for the document; Claude picks the matching skill.'], ar: ['ثبّت الإضافة ثم اطلب المستند مباشرة؛ يختار Claude المهارة المناسبة.'] },
    examples: ['Turn CHANGELOG.md into a 5-slide PowerPoint for the release meeting.', 'Read invoices.pdf and put the totals in an Excel sheet.'],
    agents: ['claude-code'],
    install: { 'claude-code': [{ how: 'command', text: '/plugin marketplace add anthropics/skills' }, { how: 'command', text: '/plugin install document-skills@anthropic-agent-skills' }] },
    topFor: ['claude-code'],
  },
  {
    id: 'superpowers',
    name: 'Superpowers',
    kind: 'plugin',
    category: 'workflow',
    publisher: 'Jesse Vincent (obra)',
    official: false,
    url: 'https://github.com/obra/superpowers',
    summary: { en: 'A skills library that teaches Claude Code disciplined workflows: brainstorm, plan, TDD, systematic debugging, code review.', ar: 'مكتبة مهارات تعلّم Claude Code سير عمل منضبطًا: عصف ذهني، تخطيط، TDD، تتبع أخطاء منهجي، ومراجعة كود.' },
    benefits: { en: ['Plans before code, tests before claims', 'Repeatable debugging instead of guessing', 'Slash commands like /brainstorm and /write-plan'], ar: ['تخطيط قبل الكود واختبارات قبل الادعاء', 'تتبع أخطاء منهجي بدل التخمين', 'أوامر مثل /brainstorm و/write-plan'] },
    usage: { en: ['Install, restart Claude Code, then start a feature with /brainstorm or /write-plan.'], ar: ['ثبّت، أعد تشغيل Claude Code، ثم ابدأ ميزة بـ /brainstorm أو /write-plan.'] },
    examples: ['/brainstorm a CSV export for the orders page', '/write-plan then /execute-plan'],
    agents: ['claude-code'],
    install: { 'claude-code': [{ how: 'command', text: '/plugin marketplace add obra/superpowers-marketplace' }, { how: 'command', text: '/plugin install superpowers@superpowers-marketplace' }] },
    topFor: ['claude-code'],
  },
  {
    id: 'code-reviewer-subagent',
    name: 'Code reviewer sub-agent',
    kind: 'subagent',
    category: 'github',
    publisher: 'Pattern (write your own)',
    official: false,
    url: 'https://docs.anthropic.com/en/docs/claude-code/sub-agents',
    summary: { en: 'A dedicated reviewer with its own context that checks every change for bugs, security and missing tests.', ar: 'مراجع مخصص بسياق مستقل يفحص كل تغيير بحثًا عن الأخطاء والأمان والاختبارات الناقصة.' },
    benefits: { en: ['A second opinion without polluting the main context', 'Consistent review checklist', 'Runs automatically after big changes'], ar: ['رأي ثانٍ دون إثقال السياق الرئيسي', 'قائمة مراجعة ثابتة', 'يعمل تلقائيًا بعد التغييرات الكبيرة'] },
    usage: { en: ['Save the file, then ask "use the code-reviewer agent on my changes".'], ar: ['احفظ الملف ثم اطلب "use the code-reviewer agent on my changes".'] },
    examples: ['Use the code-reviewer agent on the diff against main.'],
    agents: ['claude-code'],
    install: { 'claude-code': [{ how: 'file', target: '.claude/agents/code-reviewer.md', text: '---\nname: code-reviewer\ndescription: Reviews code changes for bugs, security issues and missing tests. Use after writing or changing code.\ntools: Read, Grep, Glob, Bash\n---\nYou are a senior reviewer. Run `git diff` to see the changes. For each file report: real bugs (with a failing scenario), security issues, missing tests, and simpler alternatives. Be specific: file, line, why, fix. Do not rewrite code that is fine.' }] },
  },
  {
    id: 'format-hook',
    name: 'Auto-format after edits',
    kind: 'hook',
    category: 'rules',
    publisher: 'Pattern',
    official: false,
    url: 'https://docs.anthropic.com/en/docs/claude-code/hooks',
    summary: { en: 'Runs your formatter after every file the agent writes, so diffs stay clean.', ar: 'يشغّل أداة التنسيق بعد كل ملف يكتبه الوكيل لتبقى الفروقات نظيفة.' },
    benefits: { en: ['No formatting noise in reviews', 'Matches your project style automatically'], ar: ['لا ضوضاء تنسيق في المراجعات', 'يطابق أسلوب مشروعك تلقائيًا'] },
    usage: { en: ['Add the hook to the project settings; replace prettier with your formatter.'], ar: ['أضف الخطّاف إلى إعدادات المشروع؛ واستبدل prettier بأداة التنسيق لديك.'] },
    examples: [],
    agents: ['claude-code'],
    install: { 'claude-code': [{ how: 'file', target: '.claude/settings.json', text: JSON.stringify({ hooks: { PostToolUse: [{ matcher: 'Edit|Write|MultiEdit', hooks: [{ type: 'command', command: 'npx prettier --write "$(jq -r \'.tool_input.file_path\')"' }] }] } }, null, 2), note: { en: 'Needs jq on PATH.', ar: 'يحتاج jq في PATH.' } }] },
  },
  {
    id: 'agents-md',
    name: 'AGENTS.md project rules',
    kind: 'rules',
    category: 'rules',
    publisher: 'Open convention (agents.md)',
    official: true,
    url: 'https://agents.md',
    summary: { en: 'One rules file most agents read: build and test commands, style, do and don\'t.', ar: 'ملف قواعد واحد تقرأه معظم الوكلاء: أوامر البناء والاختبار والأسلوب وما يجب وما لا يجب.' },
    benefits: { en: ['Every agent follows the same conventions', 'Fewer repeated instructions in prompts', 'DevContinuity can keep it in sync with CLAUDE.md, GEMINI.md and Cursor rules'], ar: ['كل الوكلاء يتبعون الأعراف نفسها', 'تعليمات مكررة أقل في الطلبات', 'يمكن لـ DevContinuity مزامنته مع CLAUDE.md وGEMINI.md وقواعد Cursor'] },
    usage: { en: ['Write it once in DevContinuity (Projects → project → Rules) and sync, or create it by hand at the repository root.'], ar: ['اكتبه مرة في DevContinuity (المشاريع ← المشروع ← القواعد) وزامنه، أو أنشئه يدويًا في جذر المستودع.'] },
    examples: [],
    agents: ['codex', 'cursor', 'copilot', 'opencode', 'gemini-cli', 'windsurf', 'kiro', 'cline', 'claude-code', 'antigravity'],
    install: Object.fromEntries((['codex', 'cursor', 'copilot', 'opencode', 'windsurf', 'kiro', 'cline', 'antigravity'] as ShopAgent[]).map((a) => [a, [{ how: 'file', target: 'AGENTS.md', text: '# Agent rules\n\n## Commands\n- Install: npm install\n- Test: npm test (must pass before you say you are done)\n- Lint: npm run lint\n\n## Conventions\n- TypeScript strict; no `any`.\n- Small focused commits.\n\n## Never\n- Commit secrets or .env files.\n- Run git reset --hard or force-push.' }]] as [ShopAgent, InstallStep[]])
      .concat([['claude-code', [{ how: 'file', target: 'CLAUDE.md', text: '@AGENTS.md\n', note: { en: 'Claude Code reads CLAUDE.md; this line imports AGENTS.md.', ar: 'Claude Code يقرأ CLAUDE.md؛ هذا السطر يستورد AGENTS.md.' } }]], ['gemini-cli', [{ how: 'file', target: '~/.gemini/settings.json', text: '{ "contextFileName": ["AGENTS.md", "GEMINI.md"] }', note: { en: 'Makes Gemini CLI read AGENTS.md too.', ar: 'يجعل Gemini CLI يقرأ AGENTS.md أيضًا.' } }]]])),
    topFor: ['codex', 'opencode', 'kiro'],
  },
  {
    id: 'cursor-rules',
    name: 'Cursor project rules',
    kind: 'rules',
    category: 'rules',
    publisher: 'Cursor',
    official: true,
    url: 'https://docs.cursor.com/context/rules',
    summary: { en: 'Scoped rules in .cursor/rules that apply always, by file pattern, or on request.', ar: 'قواعد محددة النطاق في .cursor/rules تُطبق دائمًا أو حسب نمط الملفات أو عند الطلب.' },
    benefits: { en: ['Different rules for frontend, backend and tests', 'Rules travel with the repository'], ar: ['قواعد مختلفة للواجهة والخلفية والاختبارات', 'القواعد تنتقل مع المستودع'] },
    usage: { en: ['Create one .mdc file per area with globs; Cursor attaches matching rules automatically.'], ar: ['أنشئ ملف .mdc لكل جزء مع أنماط globs؛ يرفق Cursor القواعد المطابقة تلقائيًا.'] },
    examples: [],
    agents: ['cursor'],
    install: { cursor: [{ how: 'file', target: '.cursor/rules/frontend.mdc', text: '---\ndescription: Frontend conventions\nglobs: src/components/**/*.tsx\nalwaysApply: false\n---\n- Use the existing UI components in src/components/ui.\n- Every user-facing string goes through the i18n dictionary.' }] },
    topFor: ['cursor'],
  },
  {
    id: 'codex-prompts',
    name: 'Codex custom prompts',
    kind: 'prompt',
    category: 'workflow',
    publisher: 'OpenAI Codex',
    official: true,
    url: 'https://github.com/openai/codex/blob/main/docs/prompts.md',
    summary: { en: 'Reusable slash commands for Codex from Markdown files in ~/.codex/prompts.', ar: 'أوامر قابلة لإعادة الاستخدام في Codex من ملفات Markdown في ~/.codex/prompts.' },
    benefits: { en: ['One command for repeated workflows (review, release notes, triage)', 'Shareable as plain files'], ar: ['أمر واحد لسير العمل المتكرر (مراجعة، ملاحظات إصدار، فرز)', 'قابلة للمشاركة كملفات عادية'] },
    usage: { en: ['Save the file and type /prompts:review in Codex (restart Codex to load new prompts).'], ar: ['احفظ الملف واكتب /prompts:review في Codex (أعد تشغيل Codex لتحميل الأوامر الجديدة).'] },
    examples: ['/prompts:review'],
    agents: ['codex'],
    install: { codex: [{ how: 'file', target: '~/.codex/prompts/review.md', text: 'Review the uncommitted changes (git diff). List real bugs with a failing scenario, security problems and missing tests, most severe first. Do not change files.' }] },
    topFor: ['codex'],
  },
  {
    id: 'gemini-security',
    name: 'Gemini CLI security extension',
    kind: 'extension',
    category: 'debugging',
    publisher: 'Google',
    official: true,
    url: 'https://github.com/gemini-cli-extensions/security',
    summary: { en: 'Adds a /security:analyze command that reviews your changes for common vulnerabilities.', ar: 'يضيف الأمر /security:analyze لمراجعة تغييراتك بحثًا عن الثغرات الشائعة.' },
    benefits: { en: ['Security review before you push', 'Explains each finding with a fix'], ar: ['مراجعة أمنية قبل الدفع', 'يشرح كل ملاحظة مع الإصلاح'] },
    usage: { en: ['Install, restart Gemini CLI, then run /security:analyze in your repository.'], ar: ['ثبّت، أعد تشغيل Gemini CLI، ثم شغّل /security:analyze في المستودع.'] },
    examples: ['/security:analyze'],
    agents: ['gemini-cli'],
    install: { 'gemini-cli': [{ how: 'command', text: 'gemini extensions install https://github.com/gemini-cli-extensions/security' }] },
    topFor: ['gemini-cli'],
  },
];

export interface ShopFilter {
  agent?: ShopAgent | null;
  category?: CategoryId | null;
  q?: string;
}

/** Items matching the filter; top picks for the chosen agent first. */
export function filterCatalog(items: CatalogItem[], f: ShopFilter): CatalogItem[] {
  const q = f.q?.trim().toLowerCase();
  const out = items.filter((i) => (!f.agent || worksWith(i, f.agent)) && (!f.category || i.category === f.category) && (!q || [i.name, i.publisher, i.summary.en, i.summary.ar, CATEGORIES[i.category].en, CATEGORIES[i.category].ar, ...i.benefits.en, ...i.benefits.ar].some((s) => s.toLowerCase().includes(q))));
  if (!f.agent) return out;
  const top = (i: CatalogItem) => (i.topFor?.includes(f.agent!) ? 0 : 1);
  return [...out].sort((a, b) => top(a) - top(b));
}

export function categoryCounts(items: CatalogItem[], agent?: ShopAgent | null): Record<CategoryId, number> {
  const c = Object.fromEntries(Object.keys(CATEGORIES).map((k) => [k, 0])) as Record<CategoryId, number>;
  for (const i of items) if (!agent || worksWith(i, agent)) c[i.category]++;
  return c;
}
