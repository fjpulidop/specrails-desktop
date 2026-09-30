import { useEffect, useRef, useState } from 'react'
import { useDesktop } from '../../../hooks/useDesktop'
import LoopsPage from '../pages/LoopsPage'
import LoopBuilderPage from '../pages/LoopBuilderPage'

/** Isolated project context: selecting a launch project never changes the main window. */
export function LoopWindowSurface() {
  const { projects, isLoading, setActiveProjectId } = useDesktop()
  const [loopId, setLoopId] = useState(() => new URLSearchParams(window.location.search).get('loopId'))
  const initialized = useRef(false)
  const projectId = new URLSearchParams(window.location.search).get('projectId')
  useEffect(() => {
    if (!isLoading && !initialized.current) {
      initialized.current = true
      setActiveProjectId(projects.some(project => project.id === projectId) ? projectId : null)
    }
  }, [isLoading, projectId, projects, setActiveProjectId])
  return <div className="flex-1 min-h-0 bg-background">
    {loopId ? <LoopBuilderPage key={loopId} loopId={loopId} onExit={() => setLoopId(null)} /> : <LoopsPage onOpenBuilder={setLoopId} />}
  </div>
}
