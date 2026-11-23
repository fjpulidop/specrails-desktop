/** The usage-limit pause card of one loop run's job, live (null when the run is not limit-paused). */
import { projectProviders, useDesktop } from '../../../hooks/useDesktop'
import { useRunLimitPause } from '../lib/useRunLimitPause'
import { LimitPauseCard } from './LimitPauseCard'
import { useBubbleAvoid } from '../../../lib/bubble-avoid'

export function RunLimitPause({ projectId, runId, initial, className }: { projectId: string; runId: string; initial: unknown; className?: string }) {
  const [limit, setLimit] = useRunLimitPause(runId, initial)
  // The agent bubble keeps clear of the docked pause card.
  const avoidRef = useBubbleAvoid<HTMLDivElement>()
  const { projects } = useDesktop()
  const project = projects.find((item) => item.id === projectId)
  if (!limit) return null
  return (
    <div ref={avoidRef} className={className}>
      <LimitPauseCard projectId={projectId} runId={runId} limit={limit} providers={project ? projectProviders(project) : []} onChanged={setLimit} />
    </div>
  )
}
