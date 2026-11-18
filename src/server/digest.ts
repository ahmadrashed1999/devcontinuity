import { complete } from './ai/gateway';
import { notify } from './audit';
import { getSetting, prisma } from './db';

/** Daily / weekly owner brief in English and Arabic. Facts are computed; AI narrative is optional. */
export async function buildDigest(kind: 'owner_daily' | 'owner_weekly') {
  const db = prisma();
  const days = kind === 'owner_daily' ? 1 : 7;
  const since = new Date(Date.now() - days * 86400_000);
  const [sessions, newTasks, openTasks, decisions, reviews, spend, orders, verifications] = await Promise.all([
    db.session.findMany({ where: { isSubagent: false, endedAt: { gte: since } }, include: { project: { select: { name: true } } } }),
    db.task.count({ where: { createdAt: { gte: since } } }),
    db.task.groupBy({ by: ['status'], where: { status: { in: ['in_progress', 'blocked', 'failed', 'pending'] } }, _count: true }),
    db.decisionRequest.count({ where: { status: 'pending' } }),
    db.workItem.count({ where: { status: 'owner_review' } }),
    db.usageRecord.aggregate({ where: { at: { gte: since } }, _sum: { costUsd: true } }),
    db.workItem.groupBy({ by: ['status'], where: { updatedAt: { gte: since }, kind: 'task' }, _count: true }),
    db.verificationRun.findMany({ where: { startedAt: { gte: since } }, select: { status: true } }),
  ]);
  const byProject = new Map<string, { n: number; interrupted: number; errors: number }>();
  for (const s of sessions) {
    const k = s.project?.name ?? 'Unassigned';
    const v = byProject.get(k) ?? { n: 0, interrupted: 0, errors: 0 };
    v.n++;
    if (['interrupted_tool', 'interrupted_response', 'awaiting_assistant'].includes(s.endState)) v.interrupted++;
    if (s.endState === 'api_error') v.errors++;
    byProject.set(k, v);
  }
  const open = Object.fromEntries(openTasks.map((o) => [o.status, o._count]));
  const ord = Object.fromEntries(orders.map((o) => [o.status, o._count]));
  const cost = spend._sum.costUsd ?? 0;
  const vPass = verifications.filter((v) => v.status === 'passed').length;
  const period = kind === 'owner_daily' ? 'last 24 hours' : 'last 7 days';
  const periodAr = kind === 'owner_daily' ? 'آخر 24 ساعة' : 'آخر 7 أيام';
  const projLines = [...byProject.entries()].sort((a, b) => b[1].n - a[1].n);

  const en = [
    `# ${kind === 'owner_daily' ? 'Daily' : 'Weekly'} brief — ${new Date().toISOString().slice(0, 10)}`,
    '',
    '## Needs you',
    `- ${decisions} decision(s) waiting · ${reviews} item(s) to review`,
    '',
    `## Activity (${period})`,
    `- ${sessions.length} agent session(s) across ${byProject.size} project(s); ${newTasks} new task candidate(s)`,
    ...projLines.map(([p, v]) => `- **${p}**: ${v.n} session(s)${v.interrupted ? `, ${v.interrupted} interrupted` : ''}${v.errors ? `, ${v.errors} stopped by errors/limits` : ''}`),
    '',
    '## Open work',
    `- In progress ${open.in_progress ?? 0} · Blocked ${open.blocked ?? 0} · Failed ${open.failed ?? 0} · Pending ${open.pending ?? 0}`,
    `- AI organization: done ${ord.done ?? 0}, running ${ord.running ?? 0}, waiting for review ${ord.owner_review ?? 0}, failed ${ord.failed ?? 0}`,
    `- Verification runs: ${vPass} passed / ${verifications.length - vPass} failed`,
    '',
    '## Spending',
    `- AI spend in the period: $${cost.toFixed(2)}`,
  ].join('\n');
  const ar = [
    `# الملخص ${kind === 'owner_daily' ? 'اليومي' : 'الأسبوعي'} — ${new Date().toISOString().slice(0, 10)}`,
    '',
    '## يحتاج إلى قرارك',
    `- ${decisions} قرار بانتظارك · ${reviews} عمل بانتظار المراجعة`,
    '',
    `## النشاط (${periodAr})`,
    `- ${sessions.length} جلسة عبر ${byProject.size} مشروع؛ ${newTasks} مهمة جديدة مرشحة`,
    ...projLines.map(([p, v]) => `- **${p}**: ${v.n} جلسة${v.interrupted ? `، ${v.interrupted} متوقفة قبل الانتهاء` : ''}${v.errors ? `، ${v.errors} توقفت بسبب خطأ أو حد الاستخدام` : ''}`),
    '',
    '## العمل المفتوح',
    `- قيد التنفيذ ${open.in_progress ?? 0} · متوقفة ${open.blocked ?? 0} · فاشلة ${open.failed ?? 0} · معلقة ${open.pending ?? 0}`,
    `- فريق الذكاء الاصطناعي: منجز ${ord.done ?? 0}، قيد العمل ${ord.running ?? 0}، بانتظار مراجعتك ${ord.owner_review ?? 0}، فاشل ${ord.failed ?? 0}`,
    `- عمليات التحقق: ${vPass} ناجحة / ${verifications.length - vPass} فاشلة`,
    '',
    '## التكلفة',
    `- إنفاق الذكاء الاصطناعي في الفترة: ${cost.toFixed(2)}$`,
  ].join('\n');

  let content = en;
  let contentAr = ar;
  if (await getSetting<boolean>('digestUseAi', false)) {
    try {
      const sys = 'You are the Chief of Staff writing a short executive brief for the company owner. Use only the facts given. 5-8 bullet points: what matters, what needs a decision, risks. No invented facts.';
      content = `${en}\n\n## Chief of Staff notes (AI)\n${(await complete('digest', sys, en, { ctx: { origin: 'org' }, maxTokens: 700 })).text}`;
      contentAr = `${ar}\n\n## ملاحظات مدير المكتب (ذكاء اصطناعي)\n${(await complete('digest', `${sys} Write in Arabic.`, ar, { ctx: { origin: 'org' }, maxTokens: 900 })).text}`;
    } catch {
      /* the factual brief is still saved */
    }
  }
  const report = await db.report.create({ data: { kind, title: kind === 'owner_daily' ? 'Daily brief' : 'Weekly brief', content, contentAr } });
  await notify('info', kind === 'owner_daily' ? 'Your daily brief is ready' : 'Your weekly brief is ready', `${decisions} decision(s) and ${reviews} review(s) waiting.`, '/owner');
  return report;
}
