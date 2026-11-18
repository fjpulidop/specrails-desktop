/**
 * Builder mode (reskin-project-builder-into-agent-panel D1): the day-0 Project
 * Builder rides the agent surfaces as a SKIN. While active, the panel/mission
 * surface render the builder session (blueprint transport) and the normal
 * agent chrome is hidden — never unmounted, so queues, pinned cards, and live
 * streams survive the mode untouched.
 */
import { useCallback, useRef, useState, type MutableRefObject } from 'react'
import type { UiMode } from '../../../../context/UiModeContext'
import { useBuilderSession, type BuilderSession } from '../../../builder/hooks/useBuilderSession'

export function useBuilderMode(opts: {
  builderActiveRef: MutableRefObject<boolean>
  secondaryWindow: boolean
  fixedConversationId: string | undefined
  uiMode: UiMode
  open: () => void
}) {
  const { builderActiveRef, secondaryWindow, fixedConversationId, uiMode, open } = opts
  const [builderActive, setBuilderActive] = useState(false)
  const builderSessionRef = useRef<BuilderSession | null>(null)
  const exitBuilderMode = useCallback(() => {
    builderActiveRef.current = false
    builderSessionRef.current?.abortAndReset()
    setBuilderActive(false)
  }, [])
  const builderSession = useBuilderSession(builderActive, { onFinished: exitBuilderMode })
  builderSessionRef.current = builderSession
  const enterBuilderMode = useCallback(() => {
    if (secondaryWindow || fixedConversationId) return
    builderActiveRef.current = true
    setBuilderActive(true)
    // Board mode: the builder lives in the floating panel — summon it. Agent
    // Mode suppresses the panel; the mission surface takes the builder skin.
    if (uiMode !== 'agent') open()
  }, [uiMode, open, secondaryWindow, fixedConversationId])

  return { builderActive, builderSession, enterBuilderMode, exitBuilderMode }
}
