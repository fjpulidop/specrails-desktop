import { useTranslation } from 'react-i18next'
import { Switch } from '../../../components/ui/switch'
import { useAttentionPrefs } from '../../../hooks/useAttentionPrefs'
import { useDesktop } from '../../../hooks/useDesktop'
import { ATTENTION_CATEGORIES, type AttentionCategory } from '../../../lib/attention/attention-policy'
import type { AttentionPrefsPatch } from '../../../lib/attention/attention-prefs-store'
import { notifyError } from '../../../lib/notify-error'
import { isTauri } from '../../../lib/tauri-shell'
import { cn } from '../../../lib/utils'
import { SettingAnchor } from './SettingAnchor'
import { SettingsCard } from './SettingsCard'

function ToggleRow({ label, hint, checked, disabled, onChange, testId }: {
  label: string
  hint?: string
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
  testId: string
}) {
  return (
    <div className={cn('flex items-center justify-between gap-3', disabled && 'opacity-60')}>
      <div className="min-w-0">
        <p className="text-label">{label}</p>
        {hint && <p className="text-caption text-muted-foreground">{hint}</p>}
      </div>
      <Switch checked={checked} disabled={disabled} onCheckedChange={onChange} aria-label={label} data-testid={testId} />
    </div>
  )
}

/**
 * Settings ▸ Notifications: what the app tells you about and how (OS
 * notifications when you are away, a toast when you are elsewhere in the app,
 * the Dock badge), per category, plus a per-project mute. Saved app-wide on the
 * server and applied at once in every window.
 */
export function AttentionSettingsSection() {
  const { t } = useTranslation('settings')
  const { prefs, update } = useAttentionPrefs()
  const { projects } = useDesktop()
  const save = (patch: AttentionPrefsPatch): void => {
    update(patch).catch(() => notifyError(t('attention.saveFailed'), { retry: () => save(patch) }))
  }
  const off = !prefs.enabled
  const setCategory = (category: AttentionCategory, value: boolean): void => save({ categories: { [category]: value } })
  const setMuted = (projectId: string, muted: boolean): void => {
    const others = prefs.mutedProjects.filter((id) => id !== projectId)
    save({ mutedProjects: muted ? [...others, projectId] : others })
  }
  const desktop = isTauri()

  return (
    <>
      <SettingAnchor id="notifications">
        <SettingsCard title={t('attention.heading')} description={t('attention.description')} data-testid="attention-settings">
          <ToggleRow label={t('attention.enable')} hint={t('attention.enableHint')} checked={prefs.enabled} onChange={(enabled) => save({ enabled })} testId="attention-enabled" />
          <fieldset className="space-y-2 border-t border-border pt-3" disabled={off}>
            <legend className="mb-1 text-caption text-muted-foreground">{t('attention.categoriesLegend')}</legend>
            {ATTENTION_CATEGORIES.map((category) => (
              <ToggleRow
                key={category}
                label={t(`attention.categories.${category}.label`)}
                hint={t(`attention.categories.${category}.hint`)}
                checked={prefs.categories[category]}
                disabled={off}
                onChange={(value) => setCategory(category, value)}
                testId={`attention-category-${category}`}
              />
            ))}
          </fieldset>
          <div className="space-y-2 border-t border-border pt-3">
            <ToggleRow label={t('attention.sound')} hint={t('attention.soundHint')} checked={prefs.sound} disabled={off} onChange={(sound) => save({ sound })} testId="attention-sound" />
            <ToggleRow
              label={t('attention.dockBadge')}
              hint={desktop ? t('attention.dockBadgeHint') : t('attention.dockBadgeDesktopOnly')}
              checked={prefs.dockBadge}
              onChange={(dockBadge) => save({ dockBadge })}
              testId="attention-dock-badge"
            />
          </div>
        </SettingsCard>
      </SettingAnchor>
      {projects.length > 0 && (
        <SettingsCard title={t('attention.projectsHeading')} description={t('attention.projectsDescription')} data-testid="attention-projects">
          {projects.map((project) => (
            <ToggleRow
              key={project.id}
              label={project.name}
              checked={!prefs.mutedProjects.includes(project.id)}
              disabled={off}
              onChange={(notify) => setMuted(project.id, !notify)}
              testId={`attention-project-${project.id}`}
            />
          ))}
        </SettingsCard>
      )}
    </>
  )
}
