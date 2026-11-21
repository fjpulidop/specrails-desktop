/**
 * Pause state per run as the card's run-log chips measure it; updates only
 * when a run's pause flags actually change.
 */
import type { RunQuestion } from '../../../../components/run-question/run-question'
import { useCallback, useState } from 'react'

export interface RunPauseVitals { paused: boolean; pausedReason: string | null; budgetPaused?: boolean; question?: RunQuestion | null }

export function usePausedRuns() {
  const [pausedRuns, setPausedRuns] = useState<Record<string, RunPauseVitals>>({})
  const onChipVitals = useCallback((runId: string, vitals: RunPauseVitals) => {
    setPausedRuns((prev) => {
      const current = prev[runId]
      if (current?.paused === vitals.paused && current?.pausedReason === vitals.pausedReason && current?.budgetPaused === vitals.budgetPaused && (current?.question ?? null) === (vitals.question ?? null)) return prev
      return { ...prev, [runId]: vitals }
    })
  }, [])
  return { pausedRuns, onChipVitals }
}
