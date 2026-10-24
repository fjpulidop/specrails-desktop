import { useTranslation } from 'react-i18next'
import { Sparkles } from 'lucide-react'
import { BuilderHalo } from '../../builder/components/project-builder/BuilderHalo'
import { setEffectsPrefs, useEffectsPrefs } from '../lib/effects-prefs'
import { Switch } from '../../../components/ui/switch'
import { SettingsCard } from './SettingsCard'

// Settings ▸ Effects: app-level visual flourishes. Each row is a switch plus
// a LIVE preview so the user sees exactly what they are turning on or off.

export function EffectsSection() {
  const { t } = useTranslation('settings')
  const prefs = useEffectsPrefs()

  return (
    <SettingsCard title={t('effects.heading')} description={t('effects.description')} data-testid="effects-section">

        <div className="flex items-start gap-3">
          <Switch
            checked={prefs.agentThinkingHalo}
            onCheckedChange={(next) => setEffectsPrefs({ agentThinkingHalo: next })}
            aria-labelledby="effects-thinking-halo-label"
            className="mt-0.5"
            data-testid="effects-thinking-halo-toggle"
          />
          <div className="min-w-0 flex-1">
            <p id="effects-thinking-halo-label" className="flex items-center gap-1.5 text-xs font-medium">
              <Sparkles className="h-3.5 w-3.5 text-accent-primary" aria-hidden />
              {t('effects.thinkingHalo.label')}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">{t('effects.thinkingHalo.description')}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{t('effects.reducedMotion')}</p>

            {/* Live preview: a composer-shaped box wearing the halo. */}
            <div className="mt-3">
              <p className="mb-1.5 text-xs font-medium text-muted-foreground">{t('effects.preview')}</p>
              <div className="relative max-w-sm rounded-xl border border-border/60 bg-background/60 px-3 py-2" data-testid="effects-thinking-halo-preview" data-active={prefs.agentThinkingHalo}>
                <BuilderHalo active={prefs.agentThinkingHalo} radius="0.75rem" inset={-3} fadeInMs={450} fadeOutMs={800} />
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="inline-flex gap-0.5" aria-hidden>
                    <span className="h-1 w-1 motion-safe:animate-pulse rounded-full bg-accent-primary" />
                    <span className="h-1 w-1 motion-safe:animate-pulse rounded-full bg-accent-primary [animation-delay:150ms]" />
                    <span className="h-1 w-1 motion-safe:animate-pulse rounded-full bg-accent-primary [animation-delay:300ms]" />
                  </span>
                  {t('effects.previewThinking')}
                </div>
              </div>
            </div>
          </div>
        </div>
    </SettingsCard>
  )
}
