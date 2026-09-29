import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Workflow } from 'lucide-react'
import { loopsApi, type LoopDefinition } from '../../loops/lib/loops-api'
import { loopNeedsTicket } from '../../loops/lib/loop-ticket-need'
import { FACTORY_RAIL_LOOPS } from '../../rails/lib/rail-loops'

/**
 * Unified Loop picker for the rail header (rails-as-loops). Lists the built-in
 * FACTORY loops (Implement / Batch / Freestyle — what used to be the rail modes;
 * defined client-side so they work even when the Loops section is off) plus, when
 * the Loops section is enabled, the user's PUBLISHED custom loops. Selecting a
 * loop drives the rail; the parent derives the legacy `mode` from the chosen id.
 * Built-ins are also editable loop rows (`builtinId`); they stay in the built-in
 * group (a renamed built-in shows its row name) and are never listed twice.
 */
export function RailLoopSelector({
  value,
  onChange,
  freestyleAvailable = true,
  loopsEnabled = true,
  disabled = false,
}: {
  disabled?: boolean
  value: string | null | undefined
  onChange: (loopId: string) => void
  /** Offer the provider-owned Freestyle built-in when the adapter supports it. */
  freestyleAvailable?: boolean
  /** Fetch + offer the user's custom published loops (Loops section feature). */
  loopsEnabled?: boolean
}) {
  const { t } = useTranslation('dashboard')
  const [published, setPublished] = useState<LoopDefinition[]>([])
  const [builtinRows, setBuiltinRows] = useState<Map<string, LoopDefinition>>(new Map())

  useEffect(() => {
    if (!loopsEnabled) return
    let cancelled = false
    loopsApi
      .list()
      // Only spec-driven loops belong on a rail (the rail feeds the spec).
      // Standalone loops are launched from the Loops page "Run" instead.
      .then((ls) => {
        if (cancelled) return
        setPublished(ls.filter((l) => !l.builtinId && l.status === 'published' && loopNeedsTicket(l.graph)))
        setBuiltinRows(new Map(ls.filter((l) => l.builtinId).map((l) => [l.builtinId!, l])))
      })
      .catch(() => { /* leave empty; built-in loops still available */ })
    return () => { cancelled = true }
  }, [loopsEnabled])

  const builtIn = FACTORY_RAIL_LOOPS.filter(
    (f) => (freestyleAvailable || !f.requiresFreestyle) && (loopsEnabled || !f.requiresLoops),
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
        disabled={disabled}
        aria-label={t('railControls.loop')}
        data-testid="rail-loop-selector"
        onChange={(e) => onChange(e.target.value)}
        className="h-5 text-[10px] rounded border border-border/50 bg-transparent text-muted-foreground hover:text-foreground pr-4 pl-1 focus:outline-none focus:ring-1 focus:ring-primary/40 max-w-[160px]"
      >
        <option value="" disabled>{t('railControls.pickLoop')}</option>
        <optgroup label={t('railControls.builtInLoops')}>
          {builtIn.map((f) => (
            <option key={f.id} value={f.id}>{builtinRows.get(f.id)?.builtinModified ? builtinRows.get(f.id)!.name : t(f.labelKey)}</option>
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
