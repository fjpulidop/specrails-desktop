import { useEffect, useState } from 'react'
import { subscribe, getMarks, type SessionMarks } from '../../../../lib/command-mark-store'

interface Props {
  sessionId: string
}

/**
 * Passive overlay rendering one marker per prompt-start mark visible in the
 * scrollback. Hidden when there are no marks yet (shell integration disabled
 * or shim never bootstrapped).
 */
export function PromptGutter({ sessionId }: Props) {
  const [marks, setMarks] = useState<SessionMarks>(() => getMarks(sessionId))
  useEffect(() => subscribe(sessionId, setMarks), [sessionId])
  if (marks.promptRows.length === 0) return null
  return (
    <div
      aria-hidden="true"
      data-prompt-gutter
      className="absolute left-0 top-0 bottom-0 w-1 pointer-events-none z-10"
    >
      {/* Visual is intentionally minimal — actual row-level rendering would need
          xterm decorations. For now we surface a thin coloured strip when there
          are completed commands so users have a visual cue. */}
      <div
        className="absolute top-0 left-0 bottom-0 w-full"
        style={{
          backgroundImage: 'linear-gradient(to bottom, rgba(189,147,249,0.2), rgba(189,147,249,0.05))',
        }}
      />
    </div>
  )
}
