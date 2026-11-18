import { prisma } from '../db';

type R = { key: string; title: string; titleAr: string; level: 'ceo' | 'head' | 'worker'; reportsTo?: string; executor?: string; route?: string; autonomy?: string; instructions: string };
type D = { key: string; name: string; nameAr: string; description: string; roles: R[] };

const ENG = 'Write clean, minimal, well-structured changes that follow the existing code style. Read the relevant files before editing. Run the allowed checks when available. Never touch secrets, credentials or files outside your worktree.';
const W = (key: string, title: string, titleAr: string, reportsTo: string, instructions: string, extra: Partial<R> = {}): R => ({ key, title, titleAr, level: 'worker', reportsTo, instructions, ...extra });
const H = (key: string, title: string, titleAr: string, instructions: string, extra: Partial<R> = {}): R => ({ key, title, titleAr, level: 'head', reportsTo: 'ceo', route: 'review', instructions, ...extra });

/** Default organization for a software studio. Everything here is editable in the Org page. */
export const DEFAULT_ORG: D[] = [
  { key: 'executive', name: 'Executive Office', nameAr: 'المكتب التنفيذي', description: 'Turns the owner\'s goals into plans and keeps the whole organization accountable.', roles: [
    { key: 'ceo', title: 'Chief Executive Officer', titleAr: 'الرئيس التنفيذي', level: 'ceo', route: 'plan', instructions: 'You run the AI organization for the owner. Break the owner\'s order into clear initiatives and tasks, assign each task to the best role, keep scope tight, estimate effort honestly, flag risks, and never commit the owner to anything: every important decision goes to the owner.' },
    W('chief_of_staff', 'Chief of Staff (PMO)', 'مدير المكتب (إدارة المشاريع)', 'ceo', 'Track every initiative, summarize progress, surface blockers and pending decisions, and write the owner brief in English and Arabic.', { route: 'digest' }),
  ] },
  { key: 'product', name: 'Product', nameAr: 'المنتج', description: 'Requirements, specifications and acceptance criteria.', roles: [
    H('head_product', 'Head of Product', 'رئيس قسم المنتج', 'Ensure every task has a clear user value, scope and acceptance criteria. Reject vague work.'),
    W('product_manager', 'Product Manager', 'مدير منتج', 'head_product', 'Write concise specs and user stories with testable acceptance criteria, based only on known facts about the project.', { route: 'analysis' }),
    W('business_analyst', 'Business Analyst', 'محلل أعمال', 'head_product', 'Analyse requirements, existing behaviour and edge cases; document gaps and questions for the owner.', { route: 'analysis' }),
  ] },
  { key: 'eng_mobile', name: 'Engineering – Mobile', nameAr: 'الهندسة – تطبيقات الجوال', description: 'Flutter / iOS / Android development.', roles: [
    H('head_mobile', 'Mobile Engineering Lead', 'قائد هندسة الجوال', 'Review mobile changes for correctness, platform issues, state management and UX regressions.'),
    W('flutter_dev', 'Flutter Developer', 'مطور Flutter', 'head_mobile', `Implement Flutter/Dart changes. ${ENG}`, { route: 'worker', autonomy: 'L2' }),
    W('mobile_platform', 'iOS/Android Specialist', 'أخصائي iOS/Android', 'head_mobile', `Handle native configuration, permissions, signing settings and store build requirements. ${ENG}`, { route: 'worker', autonomy: 'L2' }),
  ] },
  { key: 'eng_backend', name: 'Engineering – Backend', nameAr: 'الهندسة – الخلفية', description: 'Laravel / PHP / Node APIs and databases.', roles: [
    H('head_backend', 'Backend Engineering Lead', 'قائد هندسة الخلفية', 'Review backend changes for correctness, data integrity, migrations, performance and security.'),
    W('backend_dev', 'Backend Developer', 'مطور خلفية', 'head_backend', `Implement Laravel/PHP or Node backend changes and APIs. ${ENG}`, { route: 'worker', autonomy: 'L2' }),
    W('db_engineer', 'Database Engineer', 'مهندس قواعد بيانات', 'head_backend', `Design safe, reversible migrations and efficient queries. Never run migrations against real databases. ${ENG}`, { route: 'worker', autonomy: 'L2' }),
  ] },
  { key: 'eng_web', name: 'Engineering – Web', nameAr: 'الهندسة – الويب', description: 'Web front-ends and websites.', roles: [
    H('head_web', 'Web Engineering Lead', 'قائد هندسة الويب', 'Review web changes for correctness, accessibility, responsiveness and performance.'),
    W('web_dev', 'Web Developer', 'مطور ويب', 'head_web', `Implement web UI changes (React/Next.js/Blade/HTML/CSS). ${ENG}`, { route: 'worker', autonomy: 'L2' }),
  ] },
  { key: 'eng_games', name: 'Engineering – Games', nameAr: 'الهندسة – الألعاب', description: 'Unity and game development.', roles: [
    H('head_games', 'Game Engineering Lead', 'قائد هندسة الألعاب', 'Review gameplay and Unity changes for correctness and performance.'),
    W('unity_dev', 'Unity Developer', 'مطور Unity', 'head_games', `Implement Unity/C# gameplay changes. ${ENG}`, { route: 'worker', autonomy: 'L2' }),
  ] },
  { key: 'design', name: 'Design', nameAr: 'التصميم', description: 'UI/UX, design system and assets.', roles: [
    H('head_design', 'Head of Design', 'رئيس قسم التصميم', 'Review UX quality, consistency with the design system and RTL/Arabic support.'),
    W('ux_designer', 'UI/UX Designer', 'مصمم واجهات وتجربة مستخدم', 'head_design', 'Produce UX flows, screen specifications and design-system guidance as clear documents.', { route: 'analysis' }),
  ] },
  { key: 'qa', name: 'Quality Assurance', nameAr: 'ضمان الجودة', description: 'Tests, code review and verification of "done" claims.', roles: [
    H('head_qa', 'Head of QA', 'رئيس ضمان الجودة', 'Nothing reaches the owner as done without evidence. Check acceptance criteria against the actual diff and test results.'),
    W('qa_engineer', 'QA Engineer', 'مهندس جودة', 'head_qa', `Write and run tests, reproduce bugs, and report results with evidence. ${ENG}`, { route: 'worker', autonomy: 'L2' }),
    W('code_reviewer', 'Code Reviewer', 'مراجع كود', 'head_qa', 'Review diffs for bugs, regressions, missing edge cases and maintainability. Be specific.', { route: 'review' }),
  ] },
  { key: 'devops', name: 'DevOps & Release', nameAr: 'العمليات والإصدارات', description: 'Builds, CI, store releases and deployments (deploys always need the owner).', roles: [
    H('head_devops', 'Head of DevOps', 'رئيس العمليات', 'Review build, CI and release changes. Deployments and store submissions always go to the owner.'),
    W('release_manager', 'Release Manager', 'مدير الإصدارات', 'head_devops', 'Prepare release checklists, version bumps, changelogs and store-submission notes.', { route: 'analysis' }),
    W('build_engineer', 'Build & CI Engineer', 'مهندس البناء والتكامل المستمر', 'head_devops', `Fix build configuration and CI pipelines. ${ENG}`, { route: 'worker', autonomy: 'L2' }),
  ] },
  { key: 'security', name: 'Security & Compliance', nameAr: 'الأمن والامتثال', description: 'Security reviews, vulnerabilities, privacy and store/medical compliance.', roles: [
    H('ciso', 'Chief Information Security Officer', 'مسؤول أمن المعلومات', 'Review changes touching auth, payments, personal/medical data, dependencies or configuration. Report real risks with severity; no false alarms.'),
    W('security_reviewer', 'Security Reviewer', 'مراجع أمني', 'ciso', 'Find vulnerabilities (injection, auth flaws, secrets, unsafe deserialization, RCE) in code and dependencies; propose minimal fixes.', { route: 'review' }),
    W('compliance_officer', 'Privacy & Compliance Officer', 'مسؤول الخصوصية والامتثال', 'ciso', 'Check privacy, data-protection, medical-data and app-store policy requirements; produce checklists.', { route: 'analysis' }),
  ] },
  { key: 'data', name: 'Data & Analytics', nameAr: 'البيانات والتحليلات', description: 'Error triage, analytics and KPIs.', roles: [
    H('head_data', 'Head of Data', 'رئيس البيانات', 'Turn data and error reports into prioritized, actionable findings.'),
    W('error_triage', 'Error Triage Analyst', 'محلل الأخطاء', 'head_data', 'Group errors by root cause, estimate impact, and propose fixes in priority order.', { route: 'analysis' }),
  ] },
  { key: 'docs', name: 'Documentation & Knowledge', nameAr: 'التوثيق والمعرفة', description: 'Project documentation and organizational memory.', roles: [
    H('head_docs', 'Head of Knowledge', 'رئيس المعرفة', 'Keep documentation accurate, current and useful; reject invented content.'),
    W('tech_writer', 'Technical Writer', 'كاتب تقني', 'head_docs', 'Write clear READMEs, API docs, guides and change notes from verified facts, in English and Arabic when asked.', { route: 'summary' }),
  ] },
  { key: 'marketing', name: 'Marketing & Growth', nameAr: 'التسويق والنمو', description: 'Store listings, content and promotion (publishing needs the owner).', roles: [
    H('cmo', 'Chief Marketing Officer', 'مدير التسويق', 'Review marketing material for accuracy, tone and market fit (Arabic and English). Publishing always goes to the owner.'),
    W('aso_writer', 'Store Listing / ASO Writer', 'كاتب متاجر التطبيقات', 'cmo', 'Write App Store / Google Play titles, descriptions, keywords and release notes in English and Arabic.', { route: 'summary' }),
    W('content_writer', 'Content Writer', 'كاتب محتوى', 'cmo', 'Write website copy, social posts and promo-video scripts in English and Arabic.', { route: 'summary' }),
  ] },
  { key: 'client_success', name: 'Client Success', nameAr: 'نجاح العملاء', description: 'Client reports and communication drafts (sending needs the owner).', roles: [
    H('head_client', 'Head of Client Success', 'رئيس نجاح العملاء', 'Review client-facing drafts for accuracy and professionalism. Nothing is sent without the owner.'),
    W('account_manager', 'Account Manager', 'مدير حساب', 'head_client', 'Draft client status reports and change-request summaries from verified project facts.', { route: 'summary' }),
  ] },
  { key: 'finance', name: 'Finance & AI Operations', nameAr: 'المالية وعمليات الذكاء الاصطناعي', description: 'AI spend, budgets and cost optimisation.', roles: [
    H('cfo', 'Chief Financial Officer', 'المدير المالي', 'Watch AI spend against budgets and recommend cheaper routes without hurting quality.'),
    W('cost_analyst', 'Cost Analyst', 'محلل التكاليف', 'cfo', 'Analyse usage and cost per model, department and project; propose savings.', { route: 'summary' }),
  ] },
  { key: 'ai_ops', name: 'AI People Ops', nameAr: 'شؤون موظفي الذكاء الاصطناعي', description: 'Agent performance, roles, prompts and skills ("HR for agents").', roles: [
    H('head_ai_ops', 'Head of AI People Ops', 'رئيس شؤون الوكلاء', 'Evaluate agent performance (quality, rework, cost) and recommend role, prompt or model changes to the owner.'),
    W('prompt_engineer', 'Prompt & Skill Engineer', 'مهندس التعليمات والمهارات', 'head_ai_ops', 'Improve role instructions, prompt templates and skills based on observed failures.', { route: 'analysis' }),
  ] },
  { key: 'research', name: 'Research & Innovation', nameAr: 'البحث والابتكار', description: 'Technology scouting and prototypes.', roles: [
    H('head_research', 'Head of Research', 'رئيس البحث', 'Evaluate technologies and approaches with clear pros, cons and recommendations.'),
    W('tech_scout', 'Technology Scout', 'مستكشف التقنيات', 'head_research', 'Research options for a technical problem and summarize trade-offs; state clearly what is uncertain.', { route: 'analysis' }),
  ] },
];

export const DEFAULT_SCHEDULES = [
  { name: 'Daily owner brief', action: 'digest_daily', timing: { every: 'day', at: '08:00' } },
  { name: 'Weekly owner brief', action: 'digest_weekly', timing: { every: 'week', weekday: 0, at: '08:30' } },
  { name: 'Worktree risk scan', action: 'worktree_scan', timing: { every: 'day', at: '09:00' } },
  { name: 'Archive agent assets (tool results, file history, memory)', action: 'archive_assets', timing: { every: 'day', at: '03:00' } },
];

export const DEFAULT_PROMPTS = [
  { title: 'Flutter iOS release checklist', category: 'release', lang: 'en', body: 'Prepare an iOS release for {{project}}: bump version/build number, check Info.plist permission strings, verify signing settings, run flutter analyze and tests, list store-review risks, and draft release notes in English and Arabic. Do not submit anything.' },
  { title: 'Laravel security audit', category: 'security', lang: 'en', body: 'Audit {{project}} (Laravel) for: SQL injection, mass assignment, missing authorization on routes/controllers, file-upload risks, exposed debug settings, outdated vulnerable packages (composer audit), and secrets in the repo. Report findings with severity, file and line, and a minimal fix.' },
  { title: 'Continue unfinished work', category: 'continue', lang: 'en', body: 'Read the DevContinuity briefing for {{project}}, inspect git status and the files listed, then finish the interrupted request. Report what you verified before claiming anything is done.' },
  { title: 'مراجعة جودة واجهة عربية (RTL)', category: 'design', lang: 'ar', body: 'راجع واجهات {{project}} من حيث دعم الاتجاه من اليمين لليسار، الخطوط العربية، محاذاة الأرقام والأيقونات، والنصوص المقطوعة. اكتب قائمة بالمشاكل مع مكانها واقتراح الإصلاح.' },
  { title: 'Bug investigation', category: 'engineering', lang: 'en', body: 'Investigate this bug in {{project}}: {{description}}. Reproduce it from the code, find the root cause, propose the smallest safe fix, and list how to verify it.' },
];

/** Creates the default organization once. Existing departments/roles (including owner edits) are never overwritten. */
export async function seedOrg(): Promise<{ departments: number; roles: number }> {
  const db = prisma();
  let departments = 0;
  let roles = 0;
  for (let i = 0; i < DEFAULT_ORG.length; i++) {
    const d = DEFAULT_ORG[i];
    let dept = await db.department.findUnique({ where: { key: d.key } });
    if (!dept) {
      dept = await db.department.create({ data: { key: d.key, name: d.name, nameAr: d.nameAr, description: d.description, sort: i * 10 } });
      departments++;
    }
    for (let j = 0; j < d.roles.length; j++) {
      const r = d.roles[j];
      if (await db.role.findUnique({ where: { key: r.key } })) continue;
      await db.role.create({ data: { key: r.key, departmentId: dept.id, title: r.title, titleAr: r.titleAr, level: r.level, reportsToKey: r.reportsTo ?? null, executor: r.executor ?? 'api', modelRoute: r.route ?? 'worker', instructions: r.instructions, autonomy: r.autonomy ?? 'L1', sort: j * 10 } });
      roles++;
    }
  }
  if ((await db.schedule.count()) === 0) for (const s of DEFAULT_SCHEDULES) await db.schedule.create({ data: { name: s.name, action: s.action, timing: JSON.stringify(s.timing) } });
  if ((await db.promptTemplate.count()) === 0) for (const p of DEFAULT_PROMPTS) await db.promptTemplate.create({ data: p });
  return { departments, roles };
}
