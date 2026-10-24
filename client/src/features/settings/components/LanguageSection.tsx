import { useTranslation } from 'react-i18next'
import { useLanguageOptional } from '../context/LanguageContext'
import { LanguagePickerGrid } from './pickers/LanguagePickerGrid'
import { SettingsCard } from './SettingsCard'

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
    <SettingsCard title={t('language.title')} description={t('language.description')}>
      <LanguagePickerGrid />
    </SettingsCard>
  )
}
