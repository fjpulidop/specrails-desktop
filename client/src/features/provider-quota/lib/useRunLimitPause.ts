import { useEffect, useId, useState } from 'react'
import { useSharedWebSocket } from '../../../hooks/useSharedWebSocket'
import { readLimitPause, type LimitPause } from './limit-pause'

/**
 * The usage-limit pause of one loop run: seeded from the job row
 * (`loopPauseLimit`), then kept live by `loop.run_paused` (limit kind),
 * `loop.limit_pause` (automatic resume toggled) and `loop.run_resumed`.
 */
export function useRunLimitPause(runId: string | null | undefined, initial: unknown) {
  const [limit, setLimit] = useState<LimitPause | null>(() => readLimitPause(initial))
  const initialKey = JSON.stringify(initial ?? null)
  useEffect(() => { setLimit(readLimitPause(initial)) }, [initialKey]) // eslint-disable-line react-hooks/exhaustive-deps
  const { registerHandler, unregisterHandler } = useSharedWebSocket()
  const uid = useId()
  useEffect(() => {
    if (!runId) return
    const id = `run-limit-pause-${runId}-${uid}`
    registerHandler(id, (data: unknown) => {
      const msg = data as { type?: string; loopRunId?: string; pauseKind?: string; limit?: unknown } | null
      if (!msg || msg.loopRunId !== runId) return
      if (msg.type === 'loop.run_paused') setLimit(msg.pauseKind === 'limit_paused' ? readLimitPause(msg.limit) : null)
      else if (msg.type === 'loop.limit_pause') setLimit(readLimitPause(msg.limit))
      else if (msg.type === 'loop.run_resumed' || msg.type === 'loop.run_completed') setLimit(null)
    })
    return () => unregisterHandler(id)
  }, [runId, uid, registerHandler, unregisterHandler])
  return [limit, setLimit] as const
}
