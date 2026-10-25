import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, CircleDot, Film } from 'lucide-react'
import { Button } from '../../../components/ui/button'
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../../components/ui/dialog'
import { RECORDED_LINES, RECORDED_LINE_INTERVAL_MS, RECORDED_PACKET } from '../lib/recorded-run'

function prefersReducedMotion(): boolean {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches } catch { return false }
}

interface RecordedRunDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * "Watch a recorded run": a bundled recording of a finished sample run, replayed
 * when no AI provider is ready. It ends at the Review packet a real run stops at.
 * It is labelled a recording throughout; nothing runs and nothing is billed.
 */
export function RecordedRunDialog({ open, onOpenChange }: RecordedRunDialogProps) {
  const { t } = useTranslation('onboarding')
  const [shown, setShown] = useState(0)
  const [round, setRound] = useState(0)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    if (!open) { setShown(0); return }
    if (prefersReducedMotion()) { setShown(RECORDED_LINES.length); return }
    setShown(0)
    timer.current = setInterval(() => {
      setShown((n) => {
        if (n + 1 >= RECORDED_LINES.length && timer.current) { clearInterval(timer.current); timer.current = null }
        return Math.min(n + 1, RECORDED_LINES.length)
      })
    }, RECORDED_LINE_INTERVAL_MS)
    return () => { if (timer.current) { clearInterval(timer.current); timer.current = null } }
  }, [open, round])

  const finished = shown >= RECORDED_LINES.length
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="wide" data-testid="recorded-run-dialog">
        <DialogHeader icon={<Film />}>
          <DialogTitle>{t('recording.title')}</DialogTitle>
          <DialogDescription>{t('recording.description')}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <p className="inline-flex items-center gap-1.5 rounded-pill border border-border/40 bg-muted/30 px-2.5 py-1 text-caption text-muted-foreground" data-testid="recording-badge">
            <CircleDot className="size-3 text-accent-warning" aria-hidden />
            {t('recording.badge')}
          </p>
          <ol role="log" aria-live="polite" aria-label={t('recording.logLabel')} className="space-y-1 rounded-card border border-border/40 bg-muted/20 p-3 font-mono text-caption" data-testid="recording-log">
            {RECORDED_LINES.slice(0, shown).map((line) => (
              <li key={line.id} className="flex gap-2">
                <span className="tabular-nums text-muted-foreground">{line.timestamp}</span>
                <span className={line.marker === '✓' ? 'text-accent-success' : 'text-accent-primary'} aria-hidden>{line.marker}</span>
                <span className="text-foreground">{t(`recording.lines.${line.key}`)}</span>
              </li>
            ))}
          </ol>
          {finished && (
            <section aria-label={t('recording.packet.title')} className="space-y-2 rounded-card border border-border/40 bg-card p-3" data-testid="recording-packet">
              <h3 className="text-strong">{t('recording.packet.title')}</h3>
              <p className="text-body text-muted-foreground">{t('recording.packet.summary', { tests: RECORDED_PACKET.tests, confidence: RECORDED_PACKET.confidence })}</p>
              <ul className="space-y-0.5 font-mono text-caption">
                {RECORDED_PACKET.files.map((file) => (
                  <li key={file.path} className="flex items-center gap-2">
                    <Check className="size-3 text-accent-success" aria-hidden />
                    <span className="text-foreground">{file.path}</span>
                    <span className="tabular-nums text-accent-success">+{file.added}</span>
                    <span className="tabular-nums text-destructive">−{file.removed}</span>
                  </li>
                ))}
              </ul>
              <p className="text-caption text-muted-foreground">{t('recording.packet.decision')}</p>
            </section>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setRound((r) => r + 1)} data-testid="recording-replay">{t('recording.replay')}</Button>
          <Button onClick={() => onOpenChange(false)}>{t('recording.close')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
