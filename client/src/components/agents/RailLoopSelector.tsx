import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Workflow } from 'lucide-react'
import { loopsApi, type LoopDefinition } from '../../lib/loops-api'
import { loopNeedsTicket } from '../../lib/loop-ticket-need'
import { FACTORY_RAIL_LOOPS } from '../../lib/rail-loops'

/**
 * Unified Loop picker for the rail header (rails-as-loops). Lists the built-in
 * FACTORY loops (Implement / Batch / Ultracode — what used to be the rail modes;
 * defined client-side so they work even when the Loops section is off) plus, when
 * the Loops section is enabled, the user's PUBLISHED custom loops. Selecting a
 * loop drives the rail; the parent derives the legacy `mode` from the chosen id.
 */
export function RailLoopSelector({
  value,
  onChange,
  ultracodeAvailable = true,
  loopsEnabled = true,
}: {
  value: string | null | undefined
  onChange: (loopId: string) => void
  /** Offer the Claude-only Ultracode built-in (hidden on non-Claude rails). */
  ultracodeAvailable?: boolean
  /** Fetch + offer the user's custom published loops (Loops section feature). */
  loopsEnabled?: boolean
}) {
  const { t } = useTranslation('dashboard')
  const [published, setPublished] = useState<LoopDefinition[]>([])

  useEffect(() => {
    if (!loopsEnabled) return
    let cancelled = false
    loopsApi
      .list()
      // Only spec-driven loops belong on a rail (the rail feeds the spec).
      // Standalone loops are launched from the Loops page "Run" instead.
      .then((ls) => { if (!cancelled) setPublished(ls.filter((l) => l.status === 'published' && loopNeedsTicket(l.graph))) })
      .catch(() => { /* leave empty; built-in loops still available */ })
    return () => { cancelled = true }
  }, [loopsEnabled])

  const builtIn = FACTORY_RAIL_LOOPS.filter(
    (f) => (ultracodeAvailable || !f.claudeOnly) && (loopsEnabled || !f.requiresLoops),
  )

  return (
    <div
      className="inline-flex items-center"
      title={t('railControls.loopTitle')}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <Workflow className="w-3 h-3 text-muted-foreground mr-1" />
      <select
        value={value ?? ''}
        aria-label={t('railControls.loop')}
        data-testid="rail-loop-selector"
        onChange={(e) => onChange(e.target.value)}
        className="h-5 text-[10px] rounded border border-border/50 bg-transparent text-muted-foreground hover:text-foreground pr-4 pl-1 focus:outline-none focus:ring-1 focus:ring-primary/40 max-w-[160px]"
      >
        <option value="" disabled>{t('railControls.pickLoop')}</option>
        <optgroup label={t('railControls.builtInLoops')}>
          {builtIn.map((f) => (
            <option key={f.id} value={f.id}>{t(f.labelKey)}</option>
          ))}
        </optgroup>
        {published.length > 0 && (
          <optgroup label={t('railControls.customLoops')}>
            {published.map((l) => (
              <option key={l.id} value={l.id}>{l.name}</option>
            ))}
          </optgroup>
        )}
      </select>
    </div>
  )
}
