import { useTranslation } from 'react-i18next'
import { Sparkles } from 'lucide-react'
import { BuilderHalo } from '../project-builder/BuilderHalo'
import { setEffectsPrefs, useEffectsPrefs } from '../../lib/effects-prefs'
import { cn } from '../../lib/utils'

// Settings ▸ Effects: app-level visual flourishes. Each row is a switch plus
// a LIVE preview so the user sees exactly what they are turning on or off.

export function EffectsSection() {
  const { t } = useTranslation('settings')
  const prefs = useEffectsPrefs()

  return (
    <div className="space-y-2" data-testid="effects-section">
      <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
        {t('effects.heading')}
      </h3>
      <div className="rounded-md border border-border p-3 space-y-3">
        <p className="text-[10px] text-muted-foreground">{t('effects.description')}</p>

        <div className="flex items-start gap-3">
          <button
            type="button"
            role="switch"
            aria-checked={prefs.agentThinkingHalo}
            onClick={() => setEffectsPrefs({ agentThinkingHalo: !prefs.agentThinkingHalo })}
            className={cn(
              'relative mt-0.5 inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors',
              prefs.agentThinkingHalo ? 'bg-accent-primary/70' : 'bg-muted-foreground/30',
            )}
            data-testid="effects-thinking-halo-toggle"
          >
            <span className={cn('absolute h-3 w-3 rounded-full bg-background shadow transition-transform', prefs.agentThinkingHalo ? 'translate-x-3.5' : 'translate-x-0.5')} />
          </button>
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-1.5 text-xs font-medium">
              <Sparkles className="h-3.5 w-3.5 text-accent-primary" aria-hidden />
              {t('effects.thinkingHalo.label')}
            </p>
            <p className="mt-0.5 text-[10px] text-muted-foreground">{t('effects.thinkingHalo.description')}</p>
            <p className="mt-0.5 text-[10px] text-muted-foreground/80">{t('effects.reducedMotion')}</p>

            {/* Live preview: a composer-shaped box wearing the halo. */}
            <div className="mt-3">
              <p className="mb-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">{t('effects.preview')}</p>
              <div className="relative max-w-sm rounded-xl border border-border/60 bg-background/60 px-3 py-2" data-testid="effects-thinking-halo-preview" data-active={prefs.agentThinkingHalo}>
                <BuilderHalo active={prefs.agentThinkingHalo} radius="0.75rem" inset={-3} fadeInMs={450} fadeOutMs={800} />
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="inline-flex gap-0.5" aria-hidden>
                    <span className="h-1 w-1 animate-pulse rounded-full bg-accent-primary" />
                    <span className="h-1 w-1 animate-pulse rounded-full bg-accent-primary [animation-delay:150ms]" />
                    <span className="h-1 w-1 animate-pulse rounded-full bg-accent-primary [animation-delay:300ms]" />
                  </span>
                  {t('effects.previewThinking')}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
