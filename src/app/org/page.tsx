import { OrgChart } from '@/components/dc/org-ui';
import { ClaudeReadiness } from '@/components/dc/tools-ui';
import { PageHeader } from '@/components/dc/ui';
import { ensureDb } from '@/server/db';
import { getT } from '@/lib/server-i18n';

export const dynamic = 'force-dynamic';

export default async function OrgPage() {
  await ensureDb();
  const { t, lang } = await getT();
  return (
    <div className="space-y-6">
      <PageHeader title={t.org} subtitle={lang === 'ar' ? 'أقسام وأدوار فريقك. كل شيء قابل للتعديل: أضف أو أوقف أقساماً، غيّر النموذج أو الوكيل لكل دور، وحدد الصلاحيات والميزانيات.' : 'Departments and roles of your AI organization. Everything is editable: add or pause departments, change the model or agent for any role, set autonomy and budgets.'} />
      <ClaudeReadiness />
      <OrgChart lang={lang} />
      <div className="rounded-xl border border-border bg-card p-4 text-sm text-slate-300">
        <div className="mb-1 font-semibold text-white">{lang === 'ar' ? 'كيف يعمل' : 'How work flows'}</div>
        <ol className="list-decimal space-y-1 ps-5">
          <li>You give an order → the CEO writes a plan → <b>you approve</b> it in the Decision Inbox.</li>
          <li>Workers execute in isolated Git worktrees (never on your branches) using their assigned executor.</li>
          <li>The department head reviews against the acceptance criteria (up to the configured rework rounds).</li>
          <li>QA runs the project test command; Security reviews sensitive changes.</li>
          <li>The result arrives in your Review Queue: <b>you</b> approve merge / PR / keep branch, request changes, or reject.</li>
        </ol>
      </div>
    </div>
  );
}
