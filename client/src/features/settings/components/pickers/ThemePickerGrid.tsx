import { Check } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useThemeOptional } from '../../context/ThemeContext'
import { THEME_IDS, THEMES, type ThemeId } from '../../lib/themes'

import { notifyError } from '../../../../lib/notify-error'
/**
 * Theme card grid shared by the Settings Appearance section and the
 * onboarding wizard. One card per built-in theme — rendered from the
 * `THEME_IDS` registry so adding a theme requires zero changes here. Click
 * to apply optimistically and persist to the server. Failure reverts to the
 * previously active theme. No live preview on hover (intentional v1
 * decision — see openspec/changes/add-hub-theme-system/design.md D7).
 */
export function ThemePickerGrid() {
  const { t: tr } = useTranslation('settings')
  const ctx = useThemeOptional()
  // No provider mounted — graceful no-op (only happens in unit tests that
  // exercise the host surface in isolation without ThemeProvider).
  if (!ctx) return null
  const { themeId, setTheme, isUpdating } = ctx

  async function handleSelect(id: ThemeId): Promise<void> {
    if (id === themeId) return
    try {
      await setTheme(id)
    } catch (err) {
      notifyError(tr('appearance.updateFailed'), {
        detail: err instanceof Error ? err.message : undefined,
        retry: () => void handleSelect(id),
      })
    }
  }

  return (
    <div
      className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2"
      role="radiogroup"
      aria-label={tr('appearance.themeGroupLabel')}
    >
      {THEME_IDS.map((id) => {
        const t = THEMES[id]
        const selected = id === themeId
        return (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={isUpdating}
            onClick={() => void handleSelect(id)}
            className={
              'group relative overflow-hidden rounded-card border text-left transition-all ' +
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/60 ' +
              'disabled:opacity-60 disabled:cursor-not-allowed ' +
              (selected
                ? 'border-accent-primary ring-1 ring-accent-primary shadow-[0_0_0_1px_var(--color-accent-primary)] '
                : 'border-border hover:border-accent-primary/40 hover:shadow-2 ')
            }
            data-testid={`theme-card-${id}`}
            data-selected={selected ? 'true' : 'false'}
          >
            {/* Live mini rail: the theme's own track, lamps and travelling pill */}
            <div
              className="relative h-20 w-full"
              style={{
                background:
                  `linear-gradient(135deg, ${t.previewSwatches.background} 0%, ${t.previewSwatches.background} 60%, color-mix(in srgb, ${t.previewSwatches.accents[0]} 18%, ${t.previewSwatches.background}) 100%)`,
              }}
              aria-hidden="true"
              data-testid={`theme-rail-${id}`}
            >
              <span
                className="absolute left-3 right-3 top-[38%] h-px"
                style={{ background: `color-mix(in srgb, ${t.previewSwatches.foreground} 22%, transparent)` }}
              />
              <span
                className="absolute top-[38%] h-1.5 w-8 -translate-y-1/2 rounded-full"
                style={{
                  left: '42%',
                  background: `linear-gradient(90deg, ${t.previewSwatches.accents[0]}, ${t.previewSwatches.railEnd ?? t.previewSwatches.accents[1]})`,
                }}
              />
              {[12, 50, 88].map((at, i) => (
                <span
                  key={at}
                  className="absolute top-[38%] h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full"
                  style={{
                    left: `${at}%`,
                    background: i === 0 ? t.status.completed : i === 1 ? t.status.running : t.status.queued,
                    boxShadow: `0 0 0 2px ${t.previewSwatches.background}`,
                  }}
                />
              ))}
              <div className="absolute bottom-2 left-3 flex items-center gap-1">
                {t.previewSwatches.accents.map((c, i) => (
                  <span key={i} className="h-2 w-2 rounded-full ring-1 ring-black/10" style={{ background: c }} />
                ))}
              </div>
            </div>
            {/* Body */}
            <div className="p-3 space-y-1 bg-card">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs font-semibold">{t.displayName}</p>
                {selected && (
                  <Check
                    className="w-3.5 h-3.5 text-accent-primary shrink-0"
                    aria-label={tr('appearance.currentlyActive')}
                  />
                )}
              </div>
              <p className="text-xs text-muted-foreground leading-tight">
                {tr(`appearance.taglines.${id}`, { defaultValue: t.tagline })}
              </p>
            </div>
          </button>
        )
      })}
    </div>
  )
}
