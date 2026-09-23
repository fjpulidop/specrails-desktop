import { CheckCircle2, Loader2, XCircle, Circle } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../components/ui/tooltip'
import { cn } from '../../../lib/utils'
import type { PhaseDefinition } from '../../../types'
import type { PhaseMap, PhaseState } from '../hooks/usePipeline'

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

        return (
          <div key={phaseDef.key} className="flex items-center">
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="flex flex-col items-center gap-1.5 cursor-default px-4">
                  <PhaseNode state={state} />
                  <span
                    className={cn(
                      'text-xs font-medium transition-colors',
                      state === 'running'
                        ? 'text-blue-400 aurora-light:text-accent-info'
                        : state === 'done'
                          ? 'text-emerald-400 aurora-light:text-accent-success'
                          : state === 'error'
                            ? 'text-red-400 aurora-light:text-destructive'
                            : 'text-muted-foreground/40',
                    )}
                  >
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
                  'h-px w-12 -mt-5 shrink-0 transition-all duration-300',
                  nextState === 'done' || state === 'done'
                    ? 'bg-emerald-500/30 aurora-light:bg-accent-success/40'
                    : nextState === 'running'
                      ? 'bg-blue-400/40 aurora-light:bg-accent-info/40'
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

function PhaseNode({ state }: { state: PhaseState }) {
  return (
    <div
      className={cn(
        'flex items-center justify-center w-10 h-10 rounded-full transition-all duration-300',
        state === 'running'
          ? 'bg-blue-500/10 aurora-light:bg-accent-info/10 ring-1 ring-blue-400/30 aurora-light:ring-accent-info/30 animate-pulse'
          : state === 'done'
            ? 'bg-emerald-500/10 aurora-light:bg-accent-success/10'
            : state === 'error'
              ? 'bg-red-500/10 aurora-light:bg-destructive/10'
              : 'bg-muted/20',
      )}
    >
      {state === 'running' && <Loader2 className="w-6 h-6 text-blue-400 aurora-light:text-accent-info animate-spin" />}
      {state === 'done' && <CheckCircle2 className="w-6 h-6 text-emerald-400 aurora-light:text-accent-success" />}
      {state === 'error' && <XCircle className="w-6 h-6 text-red-400 aurora-light:text-destructive" />}
      {state === 'idle' && <Circle className="w-6 h-6 text-muted-foreground/20" />}
    </div>
  )
}
