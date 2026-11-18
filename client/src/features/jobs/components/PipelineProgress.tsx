import { Tooltip, TooltipContent, TooltipTrigger } from '../../../components/ui/tooltip'
import { LiveDot } from '../../../components/ui/live-dot'
import { runStateLook } from '../../../components/ui/run-state/run-state'
import { cn } from '../../../lib/utils'
import type { PhaseDefinition } from '../../../types'
import type { PhaseMap, PhaseState } from '../hooks/usePipeline'
import { phaseRunState } from '../lib/job-run-state'

interface PipelineProgressProps {
  phases: PhaseMap
  phaseDefinitions: PhaseDefinition[]
}

export function PipelineProgress({ phases, phaseDefinitions }: PipelineProgressProps) {
  if (phaseDefinitions.length === 0) return null

  return (
    <div className="flex items-center">
      {phaseDefinitions.map((phaseDef, idx) => {
        const state: PhaseState = phases[phaseDef.key] ?? 'idle'
        const nextState: PhaseState | null =
          idx < phaseDefinitions.length - 1
            ? (phases[phaseDefinitions[idx + 1].key] ?? 'idle')
            : null
        const look = runStateLook(phaseRunState(state))

        return (
          <div key={phaseDef.key} className="flex items-center">
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="flex flex-col items-center gap-1.5 cursor-default px-4">
                  <PhaseNode state={state} />
                  <span className={cn('text-label transition-colors', look.text)}>
                    {phaseDef.label}
                  </span>
                </div>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-[200px]">
                <p className="font-medium">{phaseDef.label}</p>
                <p className="text-muted-foreground mt-0.5">{phaseDef.description}</p>
              </TooltipContent>
            </Tooltip>

            {nextState !== null && (
              <div
                className={cn(
                  'h-px w-12 -mt-5 shrink-0 transition-all duration-200',
                  nextState === 'done' || state === 'done'
                    ? 'bg-accent-success/40'
                    : nextState === 'running'
                      ? 'bg-accent-info/40'
                      : 'bg-border/30',
                )}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}

const NODE_FILL: Record<PhaseState, string> = {
  idle: 'bg-muted/20',
  running: 'bg-accent-info/10 ring-1 ring-accent-info/30',
  done: 'bg-accent-success/10',
  error: 'bg-destructive/10',
}

/** A phase's lamp: the running phase is the pulsing info LiveDot (never a pulsing node); the rest show their state's glyph. */
function PhaseNode({ state }: { state: PhaseState }) {
  const runState = phaseRunState(state)
  const look = runStateLook(runState)
  const Icon = look.icon
  return (
    <div
      data-run-state={runState}
      className={cn('flex items-center justify-center w-10 h-10 rounded-full transition-all duration-200', NODE_FILL[state])}
    >
      {Icon
        ? <Icon aria-hidden className={cn('w-6 h-6', look.text, state === 'idle' && 'opacity-20')} />
        : <LiveDot size="md" dotClassName={look.dot} aria-hidden />}
    </div>
  )
}
