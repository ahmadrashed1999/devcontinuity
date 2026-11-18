import Link from 'next/link';
import { ArrowRightLeft } from 'lucide-react';
import { FilterBar, Select } from '@/components/dc/actions';
import { ContinuePanel } from '@/components/dc/continue-panel';
import { Empty, PageHeader, Panel } from '@/components/dc/ui';
import { ensureDb, prisma } from '@/server/db';
import { AGENT_COLORS, fmtDate, agentName } from '@/lib/format';
import { getT } from '@/lib/server-i18n';

export const dynamic = 'force-dynamic';

export default async function HandoffPage({ searchParams }: PageProps<'/handoff'>) {
  await ensureDb();
  const { t } = await getT();
  const sp = await searchParams;
  const db = prisma();
  const projects = await db.project.findMany({ orderBy: { lastActivityAt: 'desc' }, select: { id: true, name: true } });
  const projectId = typeof sp.projectId === 'string' && sp.projectId ? sp.projectId : projects[0]?.id;
  const sessionId = typeof sp.sessionId === 'string' && sp.sessionId ? sp.sessionId : undefined;
  const sessions = projectId ? await db.session.findMany({ where: { projectId, isSubagent: false, endState: { not: 'empty' } }, orderBy: { endedAt: 'desc' }, take: 40, select: { id: true, title: true, endedAt: true, agent: true } }) : [];
  const history = await db.handoff.findMany({ orderBy: { createdAt: 'desc' }, take: 20, include: { project: { select: { name: true } } } });
  return (
    <div className="space-y-6">
      <PageHeader title={t.continueCta} subtitle="Continue any project or session with Claude Code, OpenCode, Codex, Cursor or any other model. DevContinuity reconstructs the working context accurately. It cannot restore another agent's hidden internal state, and it does not pretend to." />
      {projects.length === 0 ? <Empty>{t.importFirst}</Empty> : (
        <>
          <FilterBar>
            <Select name="projectId" value={projectId} label="Project" options={projects.map((p) => [p.id, p.name])} />
            <Select name="sessionId" value={sessionId} label="Focus (optional: defaults to the latest session)" options={sessions.map((s) => [s.id, `${fmtDate(s.endedAt, false)} · ${agentName(s.agent)} · ${(s.title ?? s.id).slice(0, 60)}`])} />
          </FilterBar>
          <Panel title={<span className="inline-flex items-center gap-2"><ArrowRightLeft className="size-4 text-cyan" /> Handoff</span>}>
            <ContinuePanel projectId={projectId} sessionId={sessionId} />
          </Panel>
          <div className="grid gap-4 md:grid-cols-3">
            {[
              ['1 · Copy & paste', 'Copy the prompt and paste it as the first message in the agent. Works with any model, even a plain chat window.'],
              ['2 · Package', 'Download the ZIP: README, 13 context documents, SESSION_REFERENCES.json, manifest.json with checksums, and one prompt per agent.'],
              ['3 · Drop into the repo', 'Writes into <project>/.devcontinuity/ only (never overwrites anything). Then tell any agent: “Read .devcontinuity/RESUME.md and continue.”'],
            ].map(([h, b]) => <div key={h} className="rounded-xl border border-border bg-card p-4"><div className="font-semibold text-white">{h}</div><p className="mt-1 text-sm text-muted-foreground">{b}</p></div>)}
          </div>
        </>
      )}
      <Panel title="Previous handoffs" bodyClass="p-0">
        <table className="w-full text-sm">
          <tbody>
            {history.map((h) => (
              <tr key={h.id} className="border-t border-border first:border-0">
                <td className="p-2 text-xs text-muted-foreground">{fmtDate(h.createdAt)}</td>
                <td className="p-2"><Link href={`/projects/${h.projectId}`} className="text-slate-200 hover:text-primary">{h.project.name}</Link></td>
                <td className={`p-2 text-xs ${AGENT_COLORS[h.targetAgent] ?? ''}`}>{h.targetAgent}</td>
                <td className="p-2 font-mono text-[11px] text-slate-500">{h.dirPath}</td>
                <td className="p-2 text-end">{h.zipPath && <a href={`/api/handoffs/${h.id}/download`} className="text-xs text-primary">ZIP</a>}</td>
              </tr>
            ))}
            {history.length === 0 && <tr><td className="p-4 text-sm text-muted-foreground">No handoffs yet.</td></tr>}
          </tbody>
        </table>
      </Panel>
    </div>
  );
}
