import { SettingsForm } from '@/components/dc/panels';
import { AdvancedSettings, AgentPathsSettings, ProvidersSettings, RemoteSettings } from '@/components/dc/settings-ui';
import { KV, PageHeader, Panel, Tabs } from '@/components/dc/ui';
import { APP_VERSION, dataDir } from '@/server/config';
import { ensureDb, prisma } from '@/server/db';
import { getT } from '@/lib/server-i18n';
import { FeaturesSettings } from '@/components/dc/live-ui';
import { aiOrgEnabled } from '@/server/features';

export const dynamic = 'force-dynamic';

export default async function SettingsPage({ searchParams }: PageProps<'/settings'>) {
  await ensureDb();
  const { t } = await getT();
  const sp = await searchParams;
  const tab = typeof sp.tab === 'string' ? sp.tab : 'ai';
  const aiOrg = await aiOrgEnabled();
  const projects = await prisma().project.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true } });
  return (
    <div className="space-y-6">
      <PageHeader title={t.settings} />
      <Tabs base="/settings" active={tab} tabs={[{ id: 'ai', label: 'AI providers, routes & budget' }, { id: 'general', label: 'AI consent & folders' }, { id: 'agents', label: 'Agents' }, { id: 'features', label: 'Features' }, ...(aiOrg ? [{ id: 'org', label: 'Organization limits' }] : []), { id: 'remote', label: 'Phone access' }, { id: 'security', label: 'Security' }]} />
      {tab === 'ai' && <ProvidersSettings projects={projects} />}
      {tab === 'general' && <SettingsForm />}
      {tab === 'agents' && <AgentPathsSettings />}
      {tab === 'features' && <FeaturesSettings />}
      {tab === 'org' && <AdvancedSettings />}
      {tab === 'remote' && <RemoteSettings />}
      {tab === 'security' && (
        <Panel title="Security & privacy">
          <KV items={[
            ['Version', APP_VERSION],
            ['Data folder', <span key="d" className="font-mono text-xs">{dataDir()}</span>],
            ['Network', 'Local only by default. Remote (phone) access requires a configured hostname plus a verified Cloudflare Access login, and is read-only unless you allow phone approvals.'],
            ['API', 'Every API call needs the local token (HttpOnly SameSite=Strict cookie or Bearer token in data/.api-token). Cross-origin requests are rejected.'],
            ['Original files', 'Agent data is read once into safe copies; never modified, moved, renamed or deleted.'],
            ['Secrets', 'Provider keys and backup passphrases are AES-256-GCM encrypted with a Windows DPAPI-protected key. Secrets are redacted before storage, export, handoff or AI calls. Credential files are never read.'],
            ['AI organization', 'Workers only write inside their own sandbox worktrees (data/worktrees). Merges, pushes, PRs, deployments and client messages always need your approval. Kill switch stops everything.'],
            ['Commands', 'Only allow-listed test/build commands run (on your click, by L2 roles in sandboxes, or by your schedules). Commands from imported transcripts are never executed.'],
            ['Git', 'Never reset, clean, force-push or delete branches. Read-only inspection everywhere else.'],
            ['Audit', 'Every action is recorded in an append-only audit log (Live Activity page).'],
            ['Telemetry', 'None. Nothing is uploaded unless you enable AI, or configure a cloud backup.'],
          ]} />
        </Panel>
      )}
    </div>
  );
}
