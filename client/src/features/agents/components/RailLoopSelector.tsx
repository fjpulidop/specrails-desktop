import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Workflow } from 'lucide-react'
import { loopsApi, type LoopDefinition } from '../../loops/lib/loops-api'
import { railRunnableCustomLoops } from '../../loops/lib/loop-ticket-need'
import { FACTORY_RAIL_LOOPS } from '../../rails/lib/rail-loops'
import { HelpHint } from '../../../components/HelpHint'

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
  recommendedId = null,
}: {
  disabled?: boolean
  /** Spec triage recommendation (launch-triage): its option is marked as recommended. */
  recommendedId?: string | null
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
        setPublished(railRunnableCustomLoops(ls))
        setBuiltinRows(new Map(ls.filter((l) => l.builtinId).map((l) => [l.builtinId!, l])))
      })
      .catch(() => { /* leave empty; built-in loops still available */ })
    return () => { cancelled = true }
  }, [loopsEnabled])

  const withRecommendation = (label: string, id: string): string =>
    id === recommendedId ? t('railControls.recommendedOption', { label }) : label

  const builtIn = FACTORY_RAIL_LOOPS.filter(
    (f) => (freestyleAvailable || !f.requiresFreestyle) && (loopsEnabled || !f.requiresLoops),
  )

  // One line on what the picked loop does: the factory text, else the loop's own description.
  const factory = builtIn.find((f) => f.id === value)
  const description = factory
    ? (builtinRows.get(factory.id)?.builtinModified ? builtinRows.get(factory.id)!.description : null) ?? t(factory.descriptionKey)
    : published.find((l) => l.id === value)?.description ?? null

  return (
    <div className="flex min-w-0 flex-col gap-0.5">
    <div
      className="inline-flex items-center"
      title={recommendedId && value === recommendedId ? `${t('railControls.loopTitle')} · ${t('railControls.recommended')}` : t('railControls.loopTitle')}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <Workflow className="w-3 h-3 text-muted-foreground mr-1" />
      <HelpHint topic="railLoops" className="mr-0.5 size-5" />
      <select
        value={value ?? ''}
        disabled={disabled}
        aria-label={t('railControls.loop')}
        data-testid="rail-loop-selector"
        data-recommended={recommendedId && value === recommendedId ? 'true' : undefined}
        onChange={(e) => onChange(e.target.value)}
        className={`h-6 text-caption rounded border bg-transparent hover:text-foreground pr-4 pl-1 focus:outline-none focus:ring-1 focus:ring-primary/40 max-w-[160px] ${recommendedId && value === recommendedId ? 'border-accent-info/50 text-accent-info' : 'border-border/50 text-muted-foreground'}`}
      >
        <option value="" disabled>{t('railControls.pickLoop')}</option>
        <optgroup label={t('railControls.builtInLoops')}>
          {builtIn.map((f) => (
            <option key={f.id} value={f.id}>{withRecommendation(builtinRows.get(f.id)?.builtinModified ? builtinRows.get(f.id)!.name : t(f.labelKey), f.id)}</option>
          ))}
        </optgroup>
        {published.length > 0 && (
          <optgroup label={t('railControls.customLoops')}>
            {published.map((l) => (
              <option key={l.id} value={l.id}>{withRecommendation(l.name, l.id)}</option>
            ))}
          </optgroup>
        )}
      </select>
    </div>
    {description ? <p className="max-w-[200px] truncate text-caption text-muted-foreground" title={description} data-testid="rail-loop-description">{description}</p> : null}
    </div>
  )
}
