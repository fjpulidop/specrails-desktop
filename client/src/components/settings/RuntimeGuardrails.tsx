import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, Compass, Hammer, ShieldCheck, Terminal, type LucideIcon } from 'lucide-react'
import { cn } from '../../lib/utils'
import { repositoryApiBase } from '../../lib/project-repositories'
import { GUARDRAIL_PHASES, isGuardrailsCatalogResponse, setGuardrail, type GuardrailDescriptor, type GuardrailPhase } from '../../lib/agent-runtime'

const PHASE_ICONS: Record<GuardrailPhase, LucideIcon> = { architect: Compass, developer: Hammer, host: Terminal }

type CatalogState =
  | { status: 'loading' }
  | { status: 'ready'; supported: boolean; catalog: GuardrailDescriptor[] }
  | { status: 'unsupported' }

/**
 * The compact-runtime guardrails: process rules the host applies around local
 * models. Rendered as a 7th collapsible block after the phase cards. The
 * catalog comes from Core (a newer Core may add ids this build has no copy
 * for — those render with the id as title); the switches live in the SAME
 * runtime config the section's Save persists, storing only `false` entries.
 */
export function RuntimeGuardrails({ projectId, guardrails, onChange }: {
  projectId: string
  guardrails: Record<string, boolean> | undefined
  onChange: (next: Record<string, boolean> | undefined) => void
}) {
  const { t, i18n } = useTranslation('agentRuntime')
  const [open, setOpen] = useState(true)
  const [state, setState] = useState<CatalogState>({ status: 'loading' })

  useEffect(() => {
    let cancelled = false
    setState({ status: 'loading' })
    fetch(`${repositoryApiBase(projectId)}/agent-runtime/guardrails`, { cache: 'no-store' }).then(async (response) => {
      if (!response.ok) throw new Error('guardrails')
      const data = await response.json() as unknown
      if (!isGuardrailsCatalogResponse(data)) throw new Error('guardrails')
      if (!cancelled) setState({ status: 'ready', supported: data.supported, catalog: data.catalog })
    }).catch(() => { if (!cancelled) setState({ status: 'unsupported' }) })
    return () => { cancelled = true }
  }, [projectId])

  const catalog = state.status === 'ready' ? state.catalog : []
  const supported = state.status === 'ready' && state.supported
  const offCount = catalog.filter((item) => guardrails?.[item.id] === false).length
  const total = catalog.length
  const known = (id: string) => i18n.exists(`agentRuntime:guardrails.items.${id}.title`)
  const bodyId = 'pipeline-guardrails-body'

  return <fieldset id="pipeline-guardrails" data-testid="phase-card-guardrails" className="scroll-mt-4 rounded-lg border border-border transition-shadow">
    <legend className="sr-only">{t('guardrails.title')}</legend>
    <button
      type="button"
      aria-expanded={open}
      aria-controls={bodyId}
      aria-label={`${open ? t('pipeline.collapse') : t('pipeline.open')}: ${t('guardrails.title')}`}
      onClick={() => setOpen((value) => !value)}
      className="flex w-full flex-wrap items-center gap-2 rounded-t-lg px-3 py-2 text-left hover:bg-muted/40"
    >
      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent-success/15 text-accent-success">
        <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
      </span>
      <span className="text-xs font-medium">{t('guardrails.title')}</span>
      <span className="ml-auto flex items-center gap-2">
        {state.status === 'ready' && supported && <span data-testid="guardrails-active" className={cn('inline-flex items-center rounded-md border px-1.5 py-0.5 text-[11px] leading-4', offCount ? 'border-accent-warning/40 bg-accent-warning/10 text-accent-warning' : 'border-accent-success/30 bg-accent-success/10 text-accent-success')}>
          {t('guardrails.active', { on: total - offCount, total })}
        </span>}
        <ChevronDown className={`h-3.5 w-3.5 text-muted-foreground transition-transform ${open ? '' : '-rotate-90'}`} aria-hidden />
      </span>
    </button>
    <div id={bodyId} hidden={!open} className="space-y-3 px-3 pb-3">
      <p className="text-xs text-muted-foreground">{t('guardrails.intro')}</p>
      {state.status === 'loading' && <p role="status" className="text-xs text-muted-foreground">{t('loading')}</p>}
      {(state.status === 'unsupported' || (state.status === 'ready' && !supported)) &&
        <p role="status" className="rounded-md border border-accent-warning/40 p-3 text-xs text-accent-warning">{t('guardrails.unsupported')}</p>}
      {state.status === 'ready' && <fieldset disabled={!supported} className="space-y-3 disabled:opacity-60">
        {offCount > 0 && <div className="flex justify-end">
          <button type="button" className="text-[11px] text-accent-primary underline-offset-2 hover:underline" onClick={() => onChange(undefined)}>{t('guardrails.reset')}</button>
        </div>}
        {GUARDRAIL_PHASES.map((phase) => {
          const items = catalog.filter((item) => item.phase === phase)
          if (!items.length) return null
          const Icon = PHASE_ICONS[phase]
          return <div key={phase} className="space-y-2" data-testid={`guardrails-phase-${phase}`}>
            <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              <Icon className="h-3.5 w-3.5" aria-hidden />{t(`guardrails.phases.${phase}`)}
            </p>
            <ul className="divide-y divide-border/60 rounded-md border border-border/60">
              {items.map((item) => {
                const enabled = guardrails?.[item.id] !== false
                const title = known(item.id) ? t(`guardrails.items.${item.id}.title`) : item.id
                const description = known(item.id) ? t(`guardrails.items.${item.id}.description`) : t('guardrails.unknown')
                const why = known(item.id) ? t(`guardrails.items.${item.id}.why`) : null
                const labelId = `guardrail-${item.id}-title`
                return <li key={item.id} className="flex items-start gap-3 px-3 py-2">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={enabled}
                    aria-labelledby={labelId}
                    data-testid={`guardrail-${item.id}`}
                    onClick={() => onChange(setGuardrail(guardrails, item.id, !enabled))}
                    className={cn('relative mt-0.5 inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors', enabled ? 'bg-accent-primary/70' : 'bg-muted-foreground/30')}
                  >
                    <span className={cn('absolute h-3 w-3 rounded-full bg-background shadow transition-transform', enabled ? 'translate-x-3.5' : 'translate-x-0.5')} />
                  </button>
                  <div className="min-w-0 flex-1">
                    <p id={labelId} className={cn('text-xs font-medium', !enabled && 'text-muted-foreground line-through decoration-muted-foreground/50')}>{title}</p>
                    <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">{description}</p>
                    {why && <p className="mt-0.5 text-[10px] italic leading-4 text-muted-foreground/70">{why}</p>}
                  </div>
                </li>
              })}
            </ul>
          </div>
        })}
      </fieldset>}
    </div>
  </fieldset>
}
