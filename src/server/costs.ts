import { getBudget, monthStart, spentThisMonth } from './ai/gateway';
import { parseJson, prisma } from './db';

/** Spending and usage-limit overview across DevContinuity's own AI calls and the agents' own transcripts. */
export async function costOverview() {
  const db = prisma();
  const since = new Date(Date.now() - 30 * 86400_000);
  const [byModel, byJob, byDept, byDayRaw, budget, month, unknownPrice] = await Promise.all([
    db.usageRecord.groupBy({ by: ['model', 'providerKind'], where: { at: { gte: since } }, _sum: { costUsd: true, inputTokens: true, outputTokens: true }, _count: true }),
    db.usageRecord.groupBy({ by: ['job'], where: { at: { gte: since } }, _sum: { costUsd: true }, _count: true }),
    db.usageRecord.groupBy({ by: ['departmentId'], where: { at: { gte: monthStart() } }, _sum: { costUsd: true } }),
    db.$queryRawUnsafe<{ day: string; cost: number | null }[]>("SELECT strftime('%Y-%m-%d', at/1000, 'unixepoch', 'localtime') AS day, sum(costUsd) AS cost FROM UsageRecord WHERE at >= ? GROUP BY day ORDER BY day", since.getTime()),
    getBudget(),
    spentThisMonth(),
    db.usageRecord.count({ where: { at: { gte: monthStart() }, costUsd: null } }),
  ]);
  const depts = await db.department.findMany({ select: { id: true, name: true, budgetUsd: true } });

  // Agents' own spending, as recorded in their transcripts (Claude Code writes cost-state records).
  const sessions = await db.session.findMany({ where: { isSubagent: false }, select: { agent: true, providerMeta: true, endedAt: true, primaryModel: true, project: { select: { name: true } }, endState: true, endStateDetail: true, id: true } });
  const agentCost = new Map<string, number>();
  const projectCost = new Map<string, number>();
  const modelSessions = new Map<string, number>();
  const limitEvents: { id: string; at: string | null; agent: string; project: string | null; detail: string }[] = [];
  for (const s of sessions) {
    const c = parseJson<{ cost?: { totalCostUSD?: number } }>(s.providerMeta, {}).cost?.totalCostUSD;
    if (typeof c === 'number' && c > 0) {
      agentCost.set(s.agent, (agentCost.get(s.agent) ?? 0) + c);
      const p = s.project?.name ?? '(none)';
      projectCost.set(p, (projectCost.get(p) ?? 0) + c);
    }
    if (s.primaryModel) modelSessions.set(s.primaryModel, (modelSessions.get(s.primaryModel) ?? 0) + 1);
    if (s.endState === 'api_error' && /limit|usage|subscription|payment|quota|credit/i.test(s.endStateDetail ?? '')) limitEvents.push({ id: s.id, at: s.endedAt?.toISOString() ?? null, agent: s.agent, project: s.project?.name ?? null, detail: s.endStateDetail ?? '' });
  }
  limitEvents.sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''));
  const recentLimits = limitEvents.filter((l) => l.at && Date.now() - new Date(l.at).getTime() < 7 * 86400_000).length;
  const warnings: string[] = [];
  if (budget.monthlyCapUsd && month >= budget.warnAtUsd) warnings.push(`Spending is $${month.toFixed(2)} of the $${budget.monthlyCapUsd} monthly cap.`);
  if (recentLimits) warnings.push(`${recentLimits} session(s) hit a usage/subscription limit in the last 7 days. Route heavy jobs to another provider or agent (Settings → AI routes), or continue those sessions with another agent.`);
  if (unknownPrice) warnings.push(`${unknownPrice} AI call(s) this month used models without a price; set prices so the budget is accurate.`);
  return {
    budget,
    monthSpent: month,
    byModel: byModel.map((m) => ({ model: m.model, provider: m.providerKind, calls: m._count, costUsd: m._sum.costUsd ?? 0, inputTokens: m._sum.inputTokens ?? 0, outputTokens: m._sum.outputTokens ?? 0 })).sort((a, b) => b.costUsd - a.costUsd),
    byJob: byJob.map((j) => ({ job: j.job, calls: j._count, costUsd: j._sum.costUsd ?? 0 })),
    byDepartment: byDept.map((d) => ({ department: depts.find((x) => x.id === d.departmentId)?.name ?? '(not org work)', budgetUsd: depts.find((x) => x.id === d.departmentId)?.budgetUsd ?? null, costUsd: d._sum.costUsd ?? 0 })),
    byDay: byDayRaw.map((d) => ({ day: d.day, costUsd: Number(d.cost ?? 0) })),
    transcriptCostByAgent: [...agentCost.entries()].map(([agent, costUsd]) => ({ agent, costUsd })),
    transcriptCostByProject: [...projectCost.entries()].map(([project, costUsd]) => ({ project, costUsd })).sort((a, b) => b.costUsd - a.costUsd).slice(0, 20),
    modelSessions: [...modelSessions.entries()].map(([model, sessions]) => ({ model, sessions })).sort((a, b) => b.sessions - a.sessions),
    limitEvents: limitEvents.slice(0, 30),
    warnings,
  };
}
