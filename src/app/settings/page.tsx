import { SettingsForm } from '@/components/dc/panels';
import { AdvancedSettings, AgentPathsSettings, ProvidersSettings, RemoteSettings } from '@/components/dc/settings-ui';
import { KV, PageHeader, Panel, Tabs } from '@/components/dc/ui';
import { APP_VERSION, dataDir } from '@/server/config';
import { ensureDb, prisma } from '@/server/db';
import { getT } from '@/lib/server-i18n';
import { FeaturesSettings } from '@/components/dc/live-ui';
import { FallbackAgentSetting } from '@/components/dc/limit-handoff';
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
      <Tabs base="/settings" active={tab} tabs={[{ id: 'ai', label: t.stAi }, { id: 'general', label: t.stGeneral }, { id: 'agents', label: t.stAgents }, { id: 'features', label: t.stFeatures }, ...(aiOrg ? [{ id: 'org', label: t.stOrg }] : []), { id: 'remote', label: t.stRemote }, { id: 'security', label: t.stSecurity }]} />
      {tab === 'ai' && <ProvidersSettings projects={projects} />}
      {tab === 'general' && <SettingsForm />}
      {tab === 'agents' && (
        <div className="space-y-6">
          <FallbackAgentSetting />
          <AgentPathsSettings />
        </div>
      )}
      {tab === 'features' && <FeaturesSettings />}
      {tab === 'org' && <AdvancedSettings />}
      {tab === 'remote' && <RemoteSettings />}
      {tab === 'security' && (
        <Panel title={t.stSecurityTitle}>
          <KV items={[
            [t.stVersion, APP_VERSION],
            [t.stDataFolder, <span key="d" className="font-mono text-xs" dir="ltr">{dataDir()}</span>],
            [t.stNetwork, t.stNetworkV],
            [t.stApi, t.stApiV],
            [t.stOriginals, t.stOriginalsV],
            [t.stSecrets, t.stSecretsV],
            ...(aiOrg ? [[t.stOrgName, t.stOrgV] as [string, string]] : []),
            [t.stCommands, t.stCommandsV],
            [t.stGit, t.stGitV],
            [t.stAudit, t.stAuditV],
            [t.stTelemetry, t.stTelemetryV],
          ]} />
        </Panel>
      )}
    </div>
  );
}
