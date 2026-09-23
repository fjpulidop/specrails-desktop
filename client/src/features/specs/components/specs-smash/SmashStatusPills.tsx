import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'

import type { SmashStage } from '../../context/SmashTrackerContext'

/**
 * Status pill stack rendered while a SMASH spawn is in flight against a
 * ticket. Mirrors ExploreStatusPills: each pill stays visible for at least
 * MIN_DISPLAY_MS to prevent flicker on fast turns.
 */

const MIN_DISPLAY_MS = 150

const STAGE_ORDER: Record<SmashStage, number> = {
  analyzing: 0,
  identifying: 1,
  ordering: 2,
}

const STAGE_LABEL_KEY: Record<SmashStage, string> = {
  analyzing: 'smash.stage.analyzing',
  identifying: 'smash.stage.identifying',
  ordering: 'smash.stage.ordering',
}

export interface SmashStatusPillsProps {
  /** Current stage as reported by `useSmashInflight`. `null` unmounts. */
  stage: SmashStage | null
  /** Test seam — overrides MIN_DISPLAY_MS. */
  minDisplayMs?: number
}

export function SmashStatusPills({ stage, minDisplayMs = MIN_DISPLAY_MS }: SmashStatusPillsProps) {
  const { t } = useTranslation('activity')
  const [displayed, setDisplayed] = useState<SmashStage | null>(stage)
  const lastChangeRef = useRef<number>(Date.now())
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (stage === displayed) return
    const since = Date.now() - lastChangeRef.current
    const wait = Math.max(0, minDisplayMs - since)
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      setDisplayed(stage)
      lastChangeRef.current = Date.now()
      timerRef.current = null
    }, wait)
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [stage, displayed, minDisplayMs])

  if (!displayed) return null
  const idx = STAGE_ORDER[displayed]

  return (
    <div
      className="flex items-center gap-2 px-3 py-2 rounded-md border border-accent-highlight/40 bg-accent-highlight/10 text-sm text-foreground"
      role="status"
      aria-live="polite"
      data-testid="smash-status-pills"
    >
      <Loader2 className="h-4 w-4 animate-spin text-accent-highlight" aria-hidden />
      <div className="flex items-center gap-1.5">
        {(['analyzing', 'identifying', 'ordering'] as SmashStage[]).map((s) => {
          const reached = STAGE_ORDER[s] <= idx
          const active = s === displayed
          return (
            <span
              key={s}
              className={[
                'inline-block w-1.5 h-1.5 rounded-full transition-all',
                reached ? 'bg-accent-highlight' : 'bg-muted',
                active ? 'scale-125' : 'scale-100',
              ].join(' ')}
              aria-hidden
            />
          )
        })}
      </div>
      <span className="font-medium">{t(STAGE_LABEL_KEY[displayed])}</span>
    </div>
  )
}
