import { useTranslation } from 'react-i18next'
import { useThemeOptional } from '../context/ThemeContext'
import { ThemePickerGrid } from './pickers/ThemePickerGrid'

/**
 * Desktop-wide theme picker. Renders the shared `ThemePickerGrid` under the
 * Appearance heading; the grid owns selection, optimistic apply, and
 * revert-on-failure.
 */
export function AppearanceSection() {
  const { t: tr } = useTranslation('settings')
  const ctx = useThemeOptional()
  // No provider mounted — graceful no-op (only happens in unit tests that
  // exercise GlobalSettingsPage in isolation without ThemeProvider).
  if (!ctx) return null

  return (
    <div className="space-y-2">
      <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
        {tr('appearance.heading')}
      </h3>
      <ThemePickerGrid />
    </div>
  )
}
