import { Check, Minus } from 'lucide-react';
import { LinkButton, PageHeader, Panel, Pill } from '@/components/dc/ui';
import { ADAPTERS } from '@/server/adapters';
import { ensureDb, prisma } from '@/server/db';
import { AGENT_COLORS, ago, fmtNum } from '@/lib/format';
import { getT } from '@/lib/server-i18n';
import { AgentPathsSettings } from '@/components/dc/settings-ui';
import { ClaudeReadiness, McpSkillsPanel } from '@/components/dc/tools-ui';
import { ConnectedAgents } from '@/components/dc/live-ui';

export const dynamic = 'force-dynamic';

export default async function AgentsPage() {
  await ensureDb();
  const { t } = await getT();
  const counts = await prisma().session.groupBy({ by: ['agent'], _count: true, _max: { endedAt: true }, _sum: { eventCount: true } });
  const caps: [keyof (typeof ADAPTERS)[number]['capabilities'], string][] = [['toolCalls', 'Tool calls'], ['toolResults', 'Tool results'], ['thinking', 'Thinking'], ['subagents', 'Subagents'], ['fileSnapshots', 'File snapshots'], ['todos', 'Todos'], ['gitMetadata', 'Git metadata']];
  return (
    <div className="space-y-6">
      <PageHeader title={t.agents} subtitle="Every AI coding agent's work in one log. Agents with readable history files are imported automatically; the rest are connected through hooks, OpenTelemetry or MCP." actions={<LinkButton href="/import" variant="primary">Import sessions</LinkButton>} />
      <Panel title="Live connections">
        <ConnectedAgents />
      </Panel>
      <h2 className="pt-2 text-sm font-semibold uppercase tracking-wider text-slate-500">Imported from their own files</h2>
      <div className="grid gap-4 lg:grid-cols-2">
        {ADAPTERS.map((a) => {
          const c = counts.find((x) => x.agent === a.id);
          return (
            <div key={a.id} className="rounded-xl border border-border bg-card p-4">
              <div className="flex items-center gap-2">
                <span className={`font-semibold ${AGENT_COLORS[a.id]}`}>{a.label}</span>
                <Pill className={a.capabilities.maturity === 'verified' ? 'border-success/30 text-success' : a.capabilities.maturity === 'experimental' ? 'border-warning/30 text-warning' : 'border-cyan/30 text-cyan'}>{a.capabilities.maturity.replace(/-/g, ' ')}</Pill>
                <span className="ms-auto text-xs text-muted-foreground">{fmtNum(c?._count)} sessions · {fmtNum(c?._sum.eventCount)} events · last {ago(c?._max.endedAt)}</span>
              </div>
              <div className="mt-1 font-mono text-[11px] text-muted-foreground">{a.defaultRoots().join(' · ')}</div>
              <p className="mt-2 text-sm text-slate-400">{a.capabilities.notes}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {caps.map(([k, l]) => <span key={k} className="inline-flex items-center gap-1 text-xs text-slate-300">{a.capabilities[k] ? <Check className="size-3.5 text-success" /> : <Minus className="size-3.5 text-slate-600" />}{l}</span>)}
              </div>
            </div>
          );
        })}
      </div>
      <Panel title="Any other tool">
        <p className="mb-2 text-sm text-muted-foreground">Anything that can make an HTTP request can log into DevContinuity. Send the local token from <code>data/.api-token</code> as a Bearer token.</p>
        <div className="rounded-md bg-black/40 p-2.5 font-mono text-xs text-slate-300">POST http://localhost:3210/api/ingest/event<br />{'{ "agent": "aider", "session": "s1", "cwd": "/path/to/project", "events": [ { "kind": "prompt", "text": "add tests" }, { "kind": "tool_result", "tool": "edit", "file": "/path/to/project/t.py" }, { "kind": "assistant", "text": "Done." } ] }'}</div>
        <p className="mt-2 text-xs text-muted-foreground">Kinds: prompt, assistant, thinking, tool_call, tool_result, error, usage, summary. OpenTelemetry exporters can post JSON logs to <code>/api/otlp/v1/logs</code>.</p>
      </Panel>
      <ClaudeReadiness />
      <AgentPathsSettings />
      <McpSkillsPanel />
      <Panel title="Command line">
        <div className="space-y-1 font-mono text-xs text-slate-300">
          <div>npm run dc -- resume --project &lt;name&gt; --agent codex</div>
          <div>npm run dc -- resume --session &lt;id&gt; --agent opencode --out RESUME.md</div>
          <div>npm run dc -- handoff --project &lt;name&gt; --agent claude-code --drop-in</div>
          <div>npm run dc -- search &quot;payment webhook&quot;</div>
        </div>
      </Panel>
    </div>
  );
}
