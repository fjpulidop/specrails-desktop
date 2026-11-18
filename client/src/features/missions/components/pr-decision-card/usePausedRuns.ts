/**
 * Pause state per run as the card's run-log chips measure it; updates only
 * when a run's pause flags actually change.
 */
import { useCallback, useState } from 'react'

export interface RunPauseVitals { paused: boolean; pausedReason: string | null; budgetPaused?: boolean }

export function usePausedRuns() {
  const [pausedRuns, setPausedRuns] = useState<Record<string, RunPauseVitals>>({})
  const onChipVitals = useCallback((runId: string, vitals: RunPauseVitals) => {
    setPausedRuns((prev) => {
      const current = prev[runId]
      if (current?.paused === vitals.paused && current?.pausedReason === vitals.pausedReason && current?.budgetPaused === vitals.budgetPaused) return prev
      return { ...prev, [runId]: vitals }
    })
  }, [])
  return { pausedRuns, onChipVitals }
}
