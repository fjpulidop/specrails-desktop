import { useTranslation } from 'react-i18next'
import { useLanguageOptional } from '../context/LanguageContext'
import { LanguagePickerGrid } from './pickers/LanguagePickerGrid'

/**
 * Desktop-wide language picker. Renders the shared `LanguagePickerGrid`
 * under the Language heading; the grid owns selection, hot-switching, and
 * revert-on-failure.
 */
export function LanguageSection() {
  const { t } = useTranslation('settings')
  const ctx = useLanguageOptional()
  // No provider mounted — graceful no-op (unit tests rendering the settings
  // page in isolation).
  if (!ctx) return null

  return (
    <div className="space-y-2">
      <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
        {t('language.title')}
      </h3>
      <p className="text-[11px] text-muted-foreground">{t('language.description')}</p>
      <LanguagePickerGrid />
    </div>
  )
}
