import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { subscribe, getMarks } from '../../../../lib/command-mark-store'

interface Props {
  sessionId: string
}

/**
 * Inline badge showing the elapsed wall-clock time for the currently running
 * command. Appears once the command has been running for ≥500ms; updates at 1Hz
 * until the post-exec mark arrives.
 */
export function CommandTimingBadge({ sessionId }: Props) {
  const { t } = useTranslation('terminal')
  const [openStart, setOpenStart] = useState<number | null>(getMarks(sessionId).openPreExec?.startedAt ?? null)
  const [now, setNow] = useState(Date.now())
  useEffect(() => subscribe(sessionId, (m) => setOpenStart(m.openPreExec?.startedAt ?? null)), [sessionId])
  useEffect(() => {
    if (openStart == null) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [openStart])
  if (openStart == null) return null
  const elapsed = now - openStart
  if (elapsed < 500) return null
  return (
    <div className="absolute top-2 left-2 px-2 py-0.5 rounded text-xs font-mono bg-[#44475a] text-[#f8f8f2] z-10 pointer-events-none">
      {formatElapsed(elapsed, t)}
    </div>
  )
}

function formatElapsed(ms: number, t: TFunction): string {
  if (ms < 60_000) return t('terminal:duration.seconds', { seconds: (ms / 1000).toFixed(1) })
  const m = Math.floor(ms / 60_000)
  const s = Math.floor((ms % 60_000) / 1000)
  return t('terminal:duration.minutesSeconds', { minutes: m, seconds: s })
}
