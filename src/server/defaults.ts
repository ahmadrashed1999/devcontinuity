import { prisma } from './db';

/** Core starter content (not part of the AI organization module): default schedules and prompt templates. */
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

/** Adds the default schedules and prompts once, when there are none. Owner edits are never overwritten. */
export async function seedDefaults(): Promise<void> {
  const db = prisma();
  if ((await db.schedule.count()) === 0) for (const s of DEFAULT_SCHEDULES) await db.schedule.create({ data: { name: s.name, action: s.action, timing: JSON.stringify(s.timing) } });
  if ((await db.promptTemplate.count()) === 0) for (const p of DEFAULT_PROMPTS) await db.promptTemplate.create({ data: p });
}
