import { forwardRef, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown, ChevronRight, ClipboardCheck, Compass, Cpu, Eye, GitBranch, Hammer, Repeat, ShieldCheck, Server, Terminal, Wrench, type LucideIcon } from 'lucide-react'

/** The implement phases in execution order — the stepper and the cards share this list. */
export const PIPELINE_PHASES = ['architect', 'developer', 'verification', 'fixer', 'reviewer', 'verifier', 'decider'] as const
export type PipelinePhase = (typeof PIPELINE_PHASES)[number]

/**
 * `core` = the implement run itself (architect → developer → verification ⇄ fixer → reviewer);
 * `loop` = the AI steps of the rail's factory loop that wraps the run (verify → decide → fix)
 * and of custom loops. Two different things — rendered as two groups.
 */
export type PipelinePhaseGroup = 'core' | 'loop'
export const PHASE_GROUP: Record<PipelinePhase, PipelinePhaseGroup> = {
  architect: 'core', developer: 'core', verification: 'core', fixer: 'core', reviewer: 'core', verifier: 'loop', decider: 'loop',
}
export const PHASE_GROUP_IDS = ['core', 'loop'] as const
/** The phases of each group, in execution order (numbering restarts per group). */
export const PHASE_GROUPS: Record<PipelinePhaseGroup, readonly PipelinePhase[]> = {
  core: PIPELINE_PHASES.filter((phase) => PHASE_GROUP[phase] === 'core'),
  loop: PIPELINE_PHASES.filter((phase) => PHASE_GROUP[phase] === 'loop'),
}
/** 1-based position of a phase within its group — the number the stepper and the cards show. */
export function phaseNumber(phase: PipelinePhase): number {
  return PHASE_GROUPS[PHASE_GROUP[phase]].indexOf(phase) + 1
}

export const PHASE_ICONS: Record<PipelinePhase, LucideIcon> = {
  architect: Compass, developer: Hammer, verification: ShieldCheck, fixer: Wrench, reviewer: Eye, verifier: ClipboardCheck, decider: GitBranch,
}

/** What runs a phase — derived live from the (possibly unsaved) form state. */
export type PhaseEngine =
  | { kind: 'ai'; label: string; model?: string | null; effort?: string | null; local?: boolean }
  | { kind: 'host'; command?: string | null }
  | { kind: 'inherit' }
  /** The fixer without its own engine: correction rounds stay on the developer. */
  | { kind: 'inherit-developer' }

export interface PipelineStep { id: PipelinePhase; engine: PhaseEngine }

/** `provider · model[ · effort]`, `Host · <command>`, `Inherits primary` or `Inherits developer`. */
export function EngineChip({ engine, className = '' }: { engine: PhaseEngine; className?: string }) {
  const { t } = useTranslation('agentRuntime')
  const base = `inline-flex max-w-full items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] leading-4 ${className}`
  if (engine.kind === 'inherit' || engine.kind === 'inherit-developer') {
    return <span data-testid="engine-chip" className={`${base} border-border/60 bg-muted/40 text-muted-foreground`}>{t(engine.kind === 'inherit' ? 'pipeline.inherits' : 'pipeline.inheritsDeveloper')}</span>
  }
  if (engine.kind === 'host') {
    return <span data-testid="engine-chip" className={`${base} border-accent-info/30 bg-accent-info/10 text-accent-info`}>
      <Terminal className="h-3 w-3 shrink-0 opacity-80" aria-hidden />
      <span className="truncate">{t('pipeline.host')} · <span className="font-mono">{engine.command || t('pipeline.noCommand')}</span></span>
    </span>
  }
  const parts = [engine.label, engine.model, engine.effort].filter((part): part is string => !!part)
  const Icon = engine.local ? Server : Cpu
  return <span data-testid="engine-chip" className={`${base} border-accent-primary/30 bg-accent-primary/10 text-accent-primary`}>
    <Icon className="h-3 w-3 shrink-0 opacity-80" aria-hidden />
    <span className="truncate">{parts.join(' · ')}</span>
  </span>
}

/** Slim group label (title + hint) shared by the stepper and the card list. */
export function PhaseGroupHeading({ group, className = '' }: { group: PipelinePhaseGroup; className?: string }) {
  const { t } = useTranslation('agentRuntime')
  const loop = group === 'loop'
  return <div className={`space-y-0.5 ${className}`} data-testid={`phase-group-heading-${group}`}>
    <div className="flex flex-wrap items-center gap-1.5">
      {loop && <Repeat className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />}
      <span className={`text-xs font-semibold ${loop ? 'text-muted-foreground' : 'text-foreground'}`}>{t(`pipeline.groups.${group}.title`)}</span>
      {loop && <span className="inline-flex h-4 items-center rounded border border-border/60 bg-muted/40 px-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{t('pipeline.groups.loop.chip')}</span>}
    </div>
    <p className="text-[11px] leading-4 text-muted-foreground">{t(`pipeline.groups.${group}.hint`)}</p>
  </div>
}

/**
 * Stepper of the implement phases in execution order, rendered as two groups
 * (core pipeline · loop steps), each with its own heading and step row. Each
 * step is a button that selects (scrolls to + expands) the matching card.
 */
export function PipelineStepper({ steps, active, onSelect }: {
  steps: readonly PipelineStep[]
  active: PipelinePhase | null
  onSelect: (phase: PipelinePhase) => void
}) {
  const { t } = useTranslation('agentRuntime')
  return <div className="flex flex-col gap-3 lg:flex-row lg:items-stretch" data-testid="pipeline-stepper">
    {PHASE_GROUP_IDS.map((group, groupIndex) => {
      const groupSteps = steps.filter((step) => PHASE_GROUP[step.id] === group)
      const loop = group === 'loop'
      return <div key={group} className="contents">
        {groupIndex > 0 && <div className="flex items-center gap-2 lg:flex-col lg:justify-center lg:gap-1 lg:px-1" aria-hidden data-testid="phase-group-divider">
          <span className="h-px flex-1 bg-border lg:h-auto lg:w-px lg:flex-1" />
          <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70 lg:[writing-mode:vertical-rl]">{t('pipeline.groups.loop.chip')}</span>
          <span className="h-px flex-1 bg-border lg:h-auto lg:w-px lg:flex-1" />
        </div>}
        <section
          aria-labelledby={`pipeline-group-${group}-title`}
          data-testid={`pipeline-group-${group}`}
          className={`min-w-0 space-y-2 rounded-lg border p-2.5 ${loop ? 'border-dashed border-border/70 bg-muted/20' : 'border-accent-primary/25 bg-accent-primary/5'}`}
        >
          <h4 id={`pipeline-group-${group}-title`} className="sr-only">{t(`pipeline.groups.${group}.title`)}</h4>
          <PhaseGroupHeading group={group} />
          <ol className="flex flex-wrap items-stretch gap-y-2" aria-label={t(`pipeline.groups.${group}.title`)}>
            {groupSteps.map((step, index) => {
              const Icon = PHASE_ICONS[step.id]
              const isActive = step.id === active
              return <li key={step.id} className="flex min-w-0 items-center">
                <button
                  type="button"
                  aria-current={isActive ? 'step' : undefined}
                  aria-label={`${index + 1}. ${t(`pipeline.phases.${step.id}.name`)}`}
                  onClick={() => onSelect(step.id)}
                  className={`group flex w-44 min-w-0 flex-col gap-1.5 rounded-lg border p-2.5 text-left transition-colors ${isActive ? 'border-primary/40 bg-primary/10 shadow-sm ring-1 ring-primary/40' : loop ? 'border-border/70 bg-background/40 hover:bg-muted/60' : 'border-border bg-background/60 hover:bg-muted/60'}`}
                >
                  <span className="flex items-center gap-2">
                    <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold ${isActive ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground group-hover:text-foreground'}`}>{index + 1}</span>
                    <Icon className={`h-3.5 w-3.5 shrink-0 ${isActive ? 'text-primary' : 'text-muted-foreground'}`} aria-hidden />
                    <span className={`truncate text-xs font-medium ${loop && !isActive ? 'text-foreground/80' : ''}`}>{t(`pipeline.phases.${step.id}.name`)}</span>
                  </span>
                  <span className="line-clamp-2 text-[11px] leading-4 text-muted-foreground">{t(`pipeline.phases.${step.id}.purpose`)}</span>
                  <EngineChip engine={step.engine} />
                </button>
                {index < groupSteps.length - 1 && <span className="flex w-5 shrink-0 items-center justify-center text-muted-foreground/60" aria-hidden>
                  <ChevronRight className="h-3.5 w-3.5" />
                </span>}
              </li>
            })}
          </ol>
        </section>
      </div>
    })}
  </div>
}

/**
 * Collapsible per-phase configuration card. The `<legend>` carries the phase
 * name for a11y (the card is a `group` named after the phase); the visible
 * header is the toggle and repeats the stepper's number + engine chip.
 */
export const PhaseCard = forwardRef<HTMLFieldSetElement, {
  phase: PipelinePhase
  engine: PhaseEngine
  open: boolean
  active: boolean
  onToggle: () => void
  children: ReactNode
}>(function PhaseCard({ phase, engine, open, active, onToggle, children }, ref) {
  const { t } = useTranslation('agentRuntime')
  const index = phaseNumber(phase)
  const Icon = PHASE_ICONS[phase]
  const name = t(`pipeline.phases.${phase}.name`)
  const bodyId = `pipeline-phase-${phase}-body`
  return <fieldset ref={ref} id={`pipeline-phase-${phase}`} data-testid={`phase-card-${phase}`} className={`scroll-mt-4 rounded-lg border transition-shadow ${active ? 'border-primary/40 ring-1 ring-primary/30' : 'border-border'}`}>
    <legend className="sr-only">{name}</legend>
    <button
      type="button"
      aria-expanded={open}
      aria-controls={bodyId}
      aria-label={`${open ? t('pipeline.collapse') : t('pipeline.open')}: ${index}. ${name}`}
      onClick={onToggle}
      className="flex w-full flex-wrap items-center gap-2 rounded-t-lg px-3 py-2 text-left hover:bg-muted/40"
    >
      <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold ${active ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}`}>{index}</span>
      <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <span className="text-xs font-medium">{name}</span>
      <span className="hidden text-[11px] text-muted-foreground sm:inline">— {t(`pipeline.phases.${phase}.purpose`)}</span>
      <span className="ml-auto flex items-center gap-2">
        <EngineChip engine={engine} />
        <ChevronDown className={`h-3.5 w-3.5 text-muted-foreground transition-transform ${open ? '' : '-rotate-90'}`} aria-hidden />
      </span>
    </button>
    <div id={bodyId} hidden={!open} className="space-y-2 px-3 pb-3">{children}</div>
  </fieldset>
})
