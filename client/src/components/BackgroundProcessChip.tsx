import { useEffect, useState } from 'react'
import { X, Terminal } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip'
import { formatElapsed } from '../lib/format-duration'
import type { BackgroundProcess } from '../types'

export type BackgroundProcessAccent = 'accent-primary' | 'accent-info' | 'accent-highlight'

const accentClass: Record<BackgroundProcessAccent, string> = {
  'accent-primary': 'border-accent-primary/40 bg-accent-primary/10 text-accent-primary',
  'accent-info': 'border-accent-info/40 bg-accent-info/10 text-accent-info',
  'accent-highlight': 'border-accent-highlight/40 bg-accent-highlight/10 text-accent-highlight',
}

export function BackgroundProcessChip({
  process,
  accentVariant,
  onKill,
}: {
  process: BackgroundProcess
  accentVariant: BackgroundProcessAccent
  onKill: (pid: number) => void
}) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [])

  const elapsed = formatElapsed(now - process.startedAt)
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            data-testid="background-process-chip"
            className={`group inline-flex max-w-[220px] items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] transition-colors ${accentClass[accentVariant]}`}
          >
            <Terminal className="h-3 w-3 shrink-0 animate-pulse" />
            <span className="truncate font-medium">{process.command}</span>
            <button
              type="button"
              aria-label={`Kill ${process.command}`}
              title={`Kill ${process.command}`}
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                onKill(process.pid)
              }}
              className="rounded-sm p-0.5 opacity-70 transition-opacity hover:bg-background/60 hover:opacity-100 group-hover:opacity-100"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        </TooltipTrigger>
        <TooltipContent>{elapsed}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
