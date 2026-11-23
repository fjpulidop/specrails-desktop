import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowUp, Info } from 'lucide-react'
import { Button } from '../../../components/ui/button'
import { Popover } from '../../../components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../components/ui/tooltip'
import { RunStatePill } from '../../../components/ui/run-state/run-state-pill'
import { RunStateGlyph } from '../../../components/ui/run-state/run-state-glyph'
import { isMacKeyboard, keyboardLabel } from '../../../lib/keyboard-label'
import { repositoryApiBase } from '../../projects/lib/project-repositories'
import type { RuntimeRun } from '../lib/agent-runtime'

type Steering = NonNullable<RuntimeRun['steering']>

/**
 * Instructions matter while a later agent turn can still read them, or when
 * some were already sent. A finished run with none has nothing to show.
 */
export function steeringVisible(run: RuntimeRun): boolean {
  if (run.engineVersion !== 2 || !run.steering) return false
  const { pending, consumed, receipts } = run.steering
  if (pending > 0 || consumed > 0 || receipts.length > 0) return true
  return run.active || run.canResume
}

/** A run that settled can no longer read new instructions. */
function steeringClosed(run: RuntimeRun): boolean {
  return run.completion != null || ['succeeded', 'cancelled'].includes(run.status)
}

/** The composer is offered exactly while Core can still deliver new instructions. */
export function steeringAcceptsInstructions(run: RuntimeRun): boolean {
  return steeringVisible(run) && !steeringClosed(run)
}

/** True when the run has sent instructions to list (the receipts chip). */
export function steeringHasReceipts(run: RuntimeRun): boolean {
  if (!steeringVisible(run)) return false
  const { pending, consumed, receipts } = run.steering!
  return pending > 0 || consumed > 0 || receipts.length > 0
}

/**
 * Run instructions: a compact composer (one auto-growing line, ⌘↵ / Ctrl+↵ to
 * send) beside a chip with what was already sent. A settled run shows only the
 * chip, read-only; a run without instructions shows nothing.
 */
export function RuntimeSteering(props: { projectId: string; run: RuntimeRun; onAccepted(): void; className?: string }) {
  if (!steeringVisible(props.run)) return null
  return <SteeringComposer key={`${props.projectId}:${props.run.runId}`} {...props} />
}

/** The read-only chip on its own (a settled run in the run window's header). */
export function RuntimeSteeringChip({ run }: { run: RuntimeRun }) {
  if (!steeringHasReceipts(run)) return null
  return <ReceiptsChip steering={run.steering!} />
}

const MAX_LINES_PX = 160

function SteeringComposer({ projectId, run, onAccepted, className }: { projectId: string; run: RuntimeRun; onAccepted(): void; className?: string }) {
  const { t } = useTranslation('agentRuntime')
  const hintId = useId()
  const [draft, setDraft] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [accepted, setAccepted] = useState<{ id: string; acceptedAt: string } | null>(null)
  const pending = useRef<{ text: string; requestId: string } | null>(null)
  const mounted = useRef(true), inFlight = useRef(false)
  const field = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const steering = run.steering!
  const terminal = steeringClosed(run)
  // Accepted but not yet listed by the next poll: count it as queued meanwhile.
  const unlisted = accepted && !steering.receipts.some(receipt => receipt.id === accepted.id) ? 1 : 0

  useLayoutEffect(() => {
    const element = field.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${Math.min(element.scrollHeight, MAX_LINES_PX)}px`
  }, [draft])

  const send = async () => {
    if (inFlight.current || terminal || !draft.trim()) return
    inFlight.current = true; setBusy(true); setError('')
    // A lost HTTP response must not enqueue the same instructions twice.
    if (!pending.current || pending.current.text !== draft) pending.current = { text: draft, requestId: crypto.randomUUID() }
    const request = pending.current
    try {
      const response = await fetch(`${repositoryApiBase(projectId)}/agent-runtime/runs/${encodeURIComponent(run.runId)}/steer`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request),
      })
      const data = await response.json() as { id?: string; acceptedAt?: string; message?: string }
      if (!response.ok) throw new Error(data.message ?? t('steering.failed'))
      if (data.id !== request.requestId || typeof data.acceptedAt !== 'string' || !Number.isFinite(Date.parse(data.acceptedAt))) throw new Error(t('steering.failed'))
      if (mounted.current) {
        setAccepted({ id: data.id, acceptedAt: data.acceptedAt }); setDraft(''); pending.current = null
        onAccepted()
      }
    } catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure.message : t('steering.failed')) }
    finally { inFlight.current = false; if (mounted.current) setBusy(false) }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || event.altKey || event.shiftKey || !(event.metaKey || event.ctrlKey)) return
    event.preventDefault()
    void send()
  }

  const showChip = steeringHasReceipts(run) || unlisted > 0
  const chip = showChip ? <ReceiptsChip steering={steering} extraPending={unlisted} side={terminal ? 'bottom' : 'top'} /> : null
  if (terminal) return chip

  const shortcut = keyboardLabel('⌘↵')
  return (
    <section aria-label={t('steering.title')} data-testid="run-steering" className={className}>
      {error && <p role="alert" className="mb-1.5 text-caption text-destructive">{error}</p>}
      <div className="flex items-end gap-2">
        {chip && <div className="flex h-8 shrink-0 items-center">{chip}</div>}
        <div className="flex min-w-0 flex-1 items-end gap-1 rounded-panel border border-input bg-background py-1 pl-3 pr-1 transition-colors duration-150 focus-within:border-primary/60 focus-within:ring-2 focus-within:ring-primary/20">
          <textarea
            ref={field}
            rows={1}
            value={draft}
            maxLength={20000}
            disabled={busy}
            aria-label={t('steering.label')}
            aria-describedby={hintId}
            aria-keyshortcuts={isMacKeyboard() ? 'Meta+Enter' : 'Control+Enter'}
            placeholder={t('steering.placeholder')}
            onChange={event => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            className="min-h-6 flex-1 resize-none self-center bg-transparent py-0.5 text-body leading-5 outline-none placeholder:text-muted-foreground disabled:opacity-50"
          />
          <span id={hintId} className="sr-only">{t('steering.hint')}</span>
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" aria-label={t('steering.about')} className="inline-flex size-7 shrink-0 items-center justify-center rounded-control text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
                <Info className="size-3.5" aria-hidden />
              </button>
            </TooltipTrigger>
            <TooltipContent className="max-w-72">{t('steering.hint')}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button type="button" size="icon" className="h-7 w-7 shrink-0 rounded-control" aria-label={t('steering.send')} disabled={busy || !draft.trim()} onClick={() => void send()}>
                <ArrowUp className="size-4" aria-hidden />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('steering.send')} <span className="ml-1 text-muted-foreground">{shortcut}</span></TooltipContent>
          </Tooltip>
        </div>
      </div>
      <span role="status" className="sr-only">{unlisted ? t('steering.accepted') : ''}</span>
    </section>
  )
}

function ReceiptsChip({ steering, extraPending = 0, side = 'bottom' }: { steering: Steering; extraPending?: number; side?: 'top' | 'bottom' }) {
  const { t } = useTranslation('agentRuntime')
  const consumed = steering.consumptionReported ? steering.consumed : 0
  const queued = Math.max(steering.pending, steering.consumptionReported ? 0 : steering.receipts.length) + extraPending
  const parts = [
    queued > 0 ? t('steering.queuedCount', { count: queued }) : null,
    consumed > 0 ? t('steering.appliedCount', { count: consumed }) : null,
  ].filter(Boolean)
  const label = parts.length ? parts.join(' · ') : t('steering.queuedCount', { count: steering.receipts.length })
  return (
    <Popover
      side={side}
      align="start"
      width={360}
      label={t('steering.sent')}
      testId="run-steering-receipts"
      trigger={
        <button type="button" aria-label={`${t('steering.sent')}: ${label}`} data-testid="run-steering-chip" className="rounded-pill focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
          <RunStatePill state={queued > 0 ? 'queued' : 'done'} label={<span className="num">{label}</span>} className="cursor-pointer hover:bg-muted/40" />
        </button>
      }
    >
      <div className="min-h-0 overflow-y-auto overscroll-contain p-3">
        <p className="text-label text-foreground">{t('steering.sent')}</p>
        {steering.receipts.length > 0 && (
          <ul className="mt-2 space-y-2.5">
            {steering.receipts.map(receipt => {
              const applied = receipt.status === 'consumed' && steering.consumptionReported
              return (
                <li key={receipt.id} className="flex gap-2">
                  <span className="mt-0.5 shrink-0"><RunStateGlyph state={applied ? 'done' : 'queued'} size="xs" /></span>
                  <div className="min-w-0">
                    <p className="whitespace-pre-wrap break-words text-body">{receipt.preview}</p>
                    <p className="text-caption text-muted-foreground" title={applied ? receipt.consumedAttemptId : undefined}>
                      {t(applied ? 'steering.consumed' : 'steering.pending')} · <time className="num" dateTime={receipt.acceptedAt}>{new Date(receipt.acceptedAt).toLocaleString()}</time>
                    </p>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
        {(steering.receiptsUnavailable || !steering.consumptionReported || steering.truncated) && (
          <div className="mt-2.5 space-y-1 border-t border-border pt-2 text-caption text-muted-foreground">
            {steering.receiptsUnavailable && <p>{t('steering.unavailable')}</p>}
            {!steering.consumptionReported && <p>{t('steering.unreported')}</p>}
            {steering.truncated && <p>{t('steering.truncated')}</p>}
          </div>
        )}
      </div>
    </Popover>
  )
}
