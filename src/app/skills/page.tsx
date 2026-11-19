import { PageHeader } from '@/components/dc/ui';
import { SkillsShop } from '@/components/dc/skills-shop';
import { getT } from '@/lib/server-i18n';

export const dynamic = 'force-dynamic';

export default async function SkillsPage() {
  const { t } = await getT();
  return (
    <div className="space-y-6">
      <PageHeader title={t.skillsShop} subtitle={t.skillsSubtitle} />
      <SkillsShop />
    </div>
  );
}
