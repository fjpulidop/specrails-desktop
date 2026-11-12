import { useTranslation } from 'react-i18next'
import type { ArchiveScope } from '../features/missions/lib/agent-api'

export function ArchiveScopeFilter({ value, onChange }: { value: ArchiveScope; onChange: (scope: ArchiveScope) => void }) {
  const { t } = useTranslation('nav')
  return (
    <select
      aria-label={t('missionArchive.label')}
      value={value}
      onChange={(event) => {
        const scope = event.target.value
        if (scope === 'active' || scope === 'archived' || scope === 'all') onChange(scope)
      }}
      className="min-w-0 rounded border border-border bg-background px-1 py-0.5 text-xs text-muted-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
    >
      <option value="active">{t('missionArchive.active')}</option>
      <option value="archived">{t('missionArchive.archived')}</option>
      <option value="all">{t('missionArchive.all')}</option>
    </select>
  )
}
