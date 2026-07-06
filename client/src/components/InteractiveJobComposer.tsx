import { useEffect, useId, useReducer, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { CheckCircle2, Hourglass, Loader2, Send } from 'lucide-react'
import { getApiBase } from '../lib/api'
import { API_ORIGIN } from '../lib/origin'
import { cn } from '../lib/utils'
import { Button } from './ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'
import { useSharedWebSocket } from '../hooks/useSharedWebSocket'

/** Running SUM of every completed turn's REAL usage (from job.turn_done /
 *  job.finalized — never an estimate). */
export interface InteractiveJobTotals {
  tokens_in: number
  tokens_out: number
  tokens_cache_read: number
  tokens_cache_create: number
  total_cost_usd: number
  num_turns: number
}

export interface InteractiveJobComposerProps {
  jobId: string
  /** Explicit project scope (agent-chat ref chips open jobs from the mission's
   *  pinned project, which may differ from the active one). Defaults to the
   *  active project via `getApiBase()`. */
  projectId?: string
  /** Settle mode of the resident session, from GET /jobs/:id:
   *  - 'finalize' (freestyle): the session idles until the human clicks
   *    Finalize — the button keeps its pre-extraction semantics untouched.
   *  - 'auto' (implement / loops / everything else): the job settles itself on
   *    quiescence — steering is optional, "wrap up now" is a quiet secondary.
   *  Absent/null falls back to 'finalize' (legacy payloads / orphan rows). */
  settleMode?: 'finalize' | 'auto' | null
  /** Whether a resident session is accepting turns RIGHT NOW (loop ai-step
   *  sessions come and go mid-run; QueueManager sessions live for the whole
   *  job). Live flips ride the `job.interactive` WS event. Default true. */
  initialAcceptingTurns?: boolean
  /** 'loop-step' relabels wrap-up to settling the CURRENT step (the loop
   *  advances) and turns a 409 between steps into a gentle waiting state. */
  kind?: 'job' | 'loop-step'
  /** Surface skin: 'page' (board Job Detail) | 'glass' (mission-mode modal). */
  variant?: 'page' | 'glass'
  /** Fired when job.finalized arrives so the parent can refetch the job row. */
  onFinalized?: () => void
}

interface ComposerState {
  streaming: boolean
  /** Prompts accepted while a turn streams — they run after it, in order. */
  queued: number
  totals: InteractiveJobTotals | null
  /** False while a loop run sits between ai-steps (no resident session). */
  accepting: boolean
  finalizing: boolean
}

type ComposerAction =
  | { type: 'turn-user'; queued: boolean }
  | { type: 'turn-done'; totals: InteractiveJobTotals }
  | { type: 'finalized'; totals: InteractiveJobTotals | null }
  | { type: 'accepting'; accepting: boolean }
  | { type: 'finalize-request' }
  | { type: 'finalize-reject' }
  | { type: 'blocked' }

function reducer(state: ComposerState, action: ComposerAction): ComposerState {
  switch (action.type) {
    case 'turn-user':
      // A prompt was accepted — a turn is (or will be) streaming; an accept
      // also proves a session is resident (self-heals a stale waiting state).
      return { ...state, streaming: true, accepting: true, queued: action.queued ? state.queued + 1 : state.queued }
    case 'turn-done': {
      // When prompts are queued the server feeds the next one immediately —
      // the session never goes idle between them, so streaming stays on.
      const queued = Math.max(0, state.queued - 1)
      return { ...state, totals: action.totals, queued, streaming: state.queued > 0 }
    }
    case 'finalized':
      return { ...state, streaming: false, finalizing: false, accepting: false, queued: 0, totals: action.totals ?? state.totals }
    case 'accepting':
      return action.accepting
        ? { ...state, accepting: true }
        : { ...state, accepting: false, streaming: false, queued: 0 }
    case 'finalize-request':
      return { ...state, finalizing: true }
    case 'finalize-reject':
      return { ...state, finalizing: false }
    case 'blocked':
      // 409 — no resident session (loop between steps). Gentle, not an error.
      return { ...state, accepting: false, streaming: false }
    default:
      return state
  }
}

interface WsHandlers {
  registerHandler: (id: string, fn: (msg: unknown) => void) => void
  unregisterHandler: (id: string) => void
}

/** Graceful variant of useSharedWebSocket: trees without a provider (and unit
 *  tests that never mount one) get null — the composer simply renders without
 *  live updates instead of crashing. The hook call itself is unconditional, so
 *  the rules of hooks hold; only its provider-missing throw is absorbed. */
function useSharedWebSocketOptional(): WsHandlers | null {
  try {
    return useSharedWebSocket()
  } catch {
    return null
  }
}

/**
 * In-job agent composer — the single interactive-session control for every
 * surface that renders a job log (board Job Detail page, mission-mode
 * JobDetailModal). Owns the ready/working pill, the live turns·cost line, the
 * queued-turn indicator, the settle action (Finalize / wrap-up per settle
 * mode) and the send box; subscribes itself to the job.turn_* / job.finalized
 * / job.interactive WS events so parents only decide WHERE it mounts.
 */
export function InteractiveJobComposer({
  jobId,
  projectId,
  settleMode,
  initialAcceptingTurns,
  kind = 'job',
  variant = 'page',
  onFinalized,
}: InteractiveJobComposerProps) {
  const { t } = useTranslation('jobs')
  const mode: 'finalize' | 'auto' = settleMode ?? 'finalize'
  // Call-time so the default path keeps getApiBase()'s lazy resolution.
  const apiBase = () => (projectId ? `${API_ORIGIN}/api/projects/${projectId}` : getApiBase())
  const [state, dispatch] = useReducer(reducer, {
    streaming: false,
    queued: 0,
    totals: null,
    accepting: initialAcceptingTurns ?? true,
    finalizing: false,
  })
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Parent refetches are authoritative snapshots — reconcile the availability
  // flag when a fresh GET /jobs/:id lands (WS flips keep it live in between).
  useEffect(() => {
    if (initialAcceptingTurns !== undefined) {
      dispatch({ type: 'accepting', accepting: initialAcceptingTurns })
    }
  }, [initialAcceptingTurns])

  const onFinalizedRef = useRef(onFinalized)
  onFinalizedRef.current = onFinalized

  // ── Self-owned WS subscription (filtered by jobId — unique per job) ────────
  const wsCtx = useSharedWebSocketOptional()
  const uid = useId()
  useEffect(() => {
    if (!wsCtx) return
    const handlerId = `interactive-composer-${jobId}-${uid}`
    const handler = (data: unknown): void => {
      const msg = data as { type?: string; jobId?: string } & Record<string, unknown>
      if (msg.jobId !== jobId) return
      if (msg.type === 'job.turn_user') {
        dispatch({ type: 'turn-user', queued: !!msg.queued })
      } else if (msg.type === 'job.turn_done') {
        dispatch({ type: 'turn-done', totals: msg.totals as InteractiveJobTotals })
      } else if (msg.type === 'job.finalized') {
        dispatch({ type: 'finalized', totals: (msg.totals as InteractiveJobTotals | undefined) ?? null })
        onFinalizedRef.current?.()
      } else if (msg.type === 'job.interactive') {
        dispatch({ type: 'accepting', accepting: !!msg.acceptingTurns })
      }
    }
    wsCtx.registerHandler(handlerId, handler)
    return () => wsCtx.unregisterHandler(handlerId)
  }, [wsCtx, jobId, uid])

  // Loop runs sit between steps with no resident session; a plain job with
  // accepting=false is either finalizing or about to unmount — never blocked.
  const waiting = kind === 'loop-step' && !state.accepting

  async function handleSend(): Promise<void> {
    const body = text.trim()
    if (!body || sending || waiting) return
    setSending(true)
    try {
      const res = await fetch(`${apiBase()}/jobs/${jobId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: body }),
      })
      if (res.ok) {
        setText('')
        requestAnimationFrame(() => textareaRef.current?.focus())
      } else if (res.status === 409 && kind === 'loop-step') {
        // Between steps — keep the drafted text and show the waiting state.
        dispatch({ type: 'blocked' })
      } else {
        const data = await res.json().catch(() => ({})) as { error?: string }
        toast.error(t('detail.toast.sendFailed'), { description: data.error })
      }
    } catch {
      toast.error(t('detail.toast.networkError'))
    } finally {
      setSending(false)
    }
  }

  async function handleFinalize(): Promise<void> {
    if (state.finalizing) return
    dispatch({ type: 'finalize-request' })
    try {
      const res = await fetch(`${apiBase()}/jobs/${jobId}/finalize`, { method: 'POST' })
      if (res.ok) {
        toast.success(
          mode === 'finalize'
            ? t('detail.toast.finalizeScheduled')
            : kind === 'loop-step'
              ? t('detail.toast.wrapUpStepScheduled')
              : t('detail.toast.wrapUpScheduled'),
        )
        // The authoritative settled state arrives via the job.finalized WS event.
      } else if (res.status === 409 && kind === 'loop-step') {
        dispatch({ type: 'blocked' })
        dispatch({ type: 'finalize-reject' })
      } else {
        const data = await res.json().catch(() => ({})) as { error?: string }
        toast.error(t('detail.toast.finalizeFailed'), { description: data.error })
        dispatch({ type: 'finalize-reject' })
      }
    } catch {
      toast.error(t('detail.toast.networkError'))
      dispatch({ type: 'finalize-reject' })
    }
  }

  const sendDisabled = sending || waiting || !text.trim()
  const workingLabel = t('detail.interactive.working')

  return (
    <div
      data-testid="interactive-job-composer"
      className={cn(
        'shrink-0 border-t px-3 py-2 space-y-1.5',
        'motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 motion-safe:duration-300',
        variant === 'glass' ? 'border-border/30 bg-surface/30' : 'border-border/40 bg-surface/40',
      )}
    >
      {/* Status row: state pill · queued indicator · live totals · settle action */}
      <div className="flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
        <span className="flex min-w-0 items-center gap-2">
          {waiting ? (
            <span className="inline-flex items-center gap-1.5">
              <Hourglass className="h-3 w-3 motion-safe:animate-pulse" />
              {t('detail.interactive.waitingForStepShort')}
            </span>
          ) : state.streaming ? (
            <span className="inline-flex items-center gap-1.5">
              <Loader2 className="h-3 w-3 animate-spin text-accent-primary" />
              <span className="relative">
                {workingLabel}
                <span aria-hidden className="title-shimmer pointer-events-none absolute inset-0">
                  {workingLabel}
                </span>
              </span>
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-accent-success motion-safe:animate-pulse" />
              {t('detail.interactive.ready')}
            </span>
          )}
          {state.queued > 0 && (
            <span className="rounded-full border border-accent-info/30 bg-accent-info/10 px-1.5 py-px text-[10px] tabular-nums text-accent-info motion-safe:animate-in motion-safe:fade-in">
              {t('detail.interactive.queued', { count: state.queued })}
            </span>
          )}
        </span>
        <span className="flex shrink-0 items-center gap-3">
          {state.totals && (
            <span className="tabular-nums">
              {t('detail.interactive.liveTotals', {
                turns: state.totals.num_turns,
                cost: state.totals.total_cost_usd.toFixed(4),
              })}
            </span>
          )}
          {mode === 'finalize' ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void handleFinalize()}
                  disabled={state.finalizing}
                  className="h-7 border-accent-success/40 text-accent-success hover:bg-accent-success/10"
                >
                  <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" />
                  {state.finalizing ? t('detail.finalizing') : t('detail.finalizeJob')}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('detail.finalizeJobTooltip')}</TooltipContent>
            </Tooltip>
          ) : (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => void handleFinalize()}
                  disabled={state.finalizing || waiting}
                  className={cn(
                    'text-[11px] underline-offset-2 transition-colors',
                    waiting
                      ? 'cursor-not-allowed text-muted-foreground/40'
                      : 'text-muted-foreground hover:text-accent-success hover:underline',
                  )}
                >
                  {state.finalizing
                    ? t('detail.interactive.wrappingUp')
                    : kind === 'loop-step'
                      ? t('detail.interactive.wrapUpStep')
                      : t('detail.interactive.wrapUp')}
                </button>
              </TooltipTrigger>
              <TooltipContent>
                {kind === 'loop-step'
                  ? t('detail.interactive.wrapUpStepTooltip')
                  : t('detail.interactive.wrapUpTooltip')}
              </TooltipContent>
            </Tooltip>
          )}
        </span>
      </div>

      {/* Quiet mode hint: auto jobs finish themselves; between loop steps the
          waiting explainer replaces it. Finalize mode needs no hint (the button
          IS the contract, unchanged). */}
      {mode === 'auto' && (
        <p className="text-[11px] leading-snug text-muted-foreground/60">
          {waiting ? t('detail.interactive.waitingForStep') : t('detail.interactive.autoHint')}
        </p>
      )}

      {/* Send box */}
      <div className="flex items-end gap-2">
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends (Shift+Enter = newline); Cmd/Ctrl+Enter always sends.
            if (e.key === 'Enter' && (!e.shiftKey || e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              void handleSend()
            }
          }}
          rows={2}
          placeholder={waiting ? t('detail.interactive.waitingForStepShort') : t('detail.interactive.placeholder')}
          aria-label={t('detail.interactive.placeholder')}
          disabled={waiting}
          className={cn(
            'flex-1 resize-none rounded-md border border-border/50 bg-background px-2.5 py-1.5 text-sm transition-opacity focus:outline-none focus:ring-2 focus:ring-ring',
            waiting && 'opacity-60',
          )}
        />
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="shrink-0">
              <Button
                size="sm"
                onClick={() => void handleSend()}
                disabled={sendDisabled}
                className="h-9"
              >
                <Send className="mr-1.5 h-3.5 w-3.5" />
                {t('detail.interactive.send')}
              </Button>
            </span>
          </TooltipTrigger>
          {sendDisabled && !sending && (
            <TooltipContent>
              {waiting ? t('detail.interactive.sendDisabledWaiting') : t('detail.interactive.sendDisabledEmpty')}
            </TooltipContent>
          )}
        </Tooltip>
      </div>
    </div>
  )
}
