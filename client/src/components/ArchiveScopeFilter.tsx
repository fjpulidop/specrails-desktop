import { useTranslation } from 'react-i18next'
import type { ArchiveScope } from '../features/missions/lib/agent-api'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'

const SCOPES: readonly ArchiveScope[] = ['active', 'archived', 'all']

/**
 * The missions sidebar's archive scope. The app's own select (Radix popover,
 * themed like every other dropdown), never the OS menu a native `<select>` opens.
 */
export function ArchiveScopeFilter({ value, onChange }: { value: ArchiveScope; onChange: (scope: ArchiveScope) => void }) {
  const { t } = useTranslation('nav')
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        if ((SCOPES as readonly string[]).includes(next)) onChange(next as ArchiveScope)
      }}
    >
      <SelectTrigger
        aria-label={t('missionArchive.label')}
        data-testid="mission-archive-scope"
        className="h-6 w-auto min-w-0 gap-1 border-border px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="end">
        {SCOPES.map((scope) => (
          <SelectItem key={scope} value={scope}>{t(`missionArchive.${scope}`)}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
