import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import {
  Sparkles,
  ArrowLeft,
  Check,
  Loader2,
  ExternalLink,
  AlertTriangle,
  Minus,
  RefreshCw,
  ChevronDown,
  ChevronRight,
} from 'lucide-react'
import { Button } from '../ui/button'
import { useMovableResizableModal } from '../../hooks/useMovableResizableModal'
import { ResizeGrips } from '../ui/ResizeGrips'

/**
 * Detect Tauri-on-Mac so we can reserve ~80px on the left for the native
 * traffic-light controls (close/min/max). Web build returns false → no padding.
 */
function isMacTauriOverlay(): boolean {
  if (typeof window === 'undefined') return false
  if (!('__TAURI_INTERNALS__' in window)) return false
  return /mac/i.test(navigator.platform)
}

export type AiEditUiPhase =
  | 'composing'
  | 'streaming'
  | 'reviewing'
  | 'error'
  | 'applied'

export interface AiEditHistoryTurn {
  role: 'user' | 'assistant' | 'system'
  kind?: string
  content: string
}

export interface AiEditShellProps {
  /** Current high-level state of the flow. */
  uiPhase: AiEditUiPhase
  errorMessage?: string | null
  applyConflict?: 'disk_changed' | 'name_changed' | null

  // ─── Header ──────────────────────────────────────────────────────────────
  /** Tiny uppercase label above the target name, e.g. "AI EDIT". */
  eyebrow: string
  /** Object being refined: agent id, ticket title, etc. Rendered in mono. */
  targetLabel: string
  /** Render targetLabel as code/mono (true for agent ids, false for prose). */
  targetLabelMono?: boolean

  // ─── Hero copy (Composing / Streaming / Error) ───────────────────────────
  /** Big headline for Composing state. */
  headline: string
  /** Big headline while a turn streams. */
  streamingHeadline: string
  /** Anchor copy under the headline; e.g. agent description / ticket title summary. */
  description?: string | null

  // ─── Quick prompt chips ──────────────────────────────────────────────────
  chips?: string[]
  /** Called when a chip is clicked. Caller decides whether to start or send. */
  onChipSubmit?: (text: string) => void

  // ─── Composer slot ───────────────────────────────────────────────────────
  /** The text-input element. Caller owns its state and submit wiring. */
  composer: ReactNode
  /** Row rendered below the composer. Used by tickets for the attachment chip bar. */
  composerAccessory?: ReactNode

  // ─── Streaming mid-state ─────────────────────────────────────────────────
  /** When provided and uiPhase==='streaming', shown in the streaming panel above the cursor. */
  streamingText?: string

  // ─── Reviewing state content ─────────────────────────────────────────────
  history?: AiEditHistoryTurn[]
  /** Diff renderer; caller pre-renders so each consumer keeps its own diff lib. */
  diff?: ReactNode
  /** Filename or label shown in the diff pane header. */
  diffHeaderLabel?: string

  // ─── "View current body" disclosure on Composing ─────────────────────────
  baseBody?: string
  baseBodyDisclosureLabel?: string

  // ─── Applied state UI ────────────────────────────────────────────────────
  /** Custom notice rendered on uiPhase==='applied'. Defaults to a generic success line. */
  appliedNotice?: ReactNode

  // ─── Actions ─────────────────────────────────────────────────────────────
  canApply: boolean
  onApply: () => void
  onForceApply?: () => void
  /** Soft cancel: stop streaming or close. */
  onDiscard: () => void
  /** Hard close: header X + back arrow. */
  onClose: () => void
  /** Optional minimize affordance — when provided, a `—` button appears in
   *  the header. Non-destructive: does NOT cancel the refine spawn or write
   *  to disk. Caller is expected to park the session in the dock. */
  onMinimize?: () => void
  /** Optional secondary action — agents use it for "Open in Studio". */
  secondaryAction?: { label: string; onClick: () => void; icon?: ReactNode }

  // ─── Keyboard ────────────────────────────────────────────────────────────
  /** Receives key events the shell didn't handle internally. */
  onKeyDown?: (e: KeyboardEvent) => void
}

/**
 * Generic full-screen overlay shell for AI Edit experiences.
 *
 * Layout adapts to `uiPhase`:
 * - `composing`/`streaming`/`error`: single centered column with hero, chips, composer.
 * - `reviewing`/`applied`: split — chat history on the left, diff on the right.
 *
 * Owns: layout, header chrome, keyboard shortcuts (⌘⏎/Esc), discard confirmation,
 * focus trap. Delegates: composer rendering, diff rendering, state/actions.
 */
export function AiEditShell(props: AiEditShellProps) {
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const previousFocusRef = useRef<Element | null>(null)
  const { panelRef, panelStyle, headerHandleProps, resizeHandles, isFloating } =
    useMovableResizableModal()

  useEffect(() => {
    previousFocusRef.current = document.activeElement
    return () => {
      const el = previousFocusRef.current
      if (el && el instanceof HTMLElement) el.focus()
    }
  }, [])

  const requestDiscard = useCallback(() => {
    if (props.uiPhase === 'streaming' || props.uiPhase === 'reviewing') {
      setConfirmDiscard(true)
    } else {
      props.onClose()
    }
  }, [props])

  const confirmDiscardAndClose = useCallback(() => {
    setConfirmDiscard(false)
    props.onDiscard()
  }, [props])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        requestDiscard()
        return
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        if (props.uiPhase === 'reviewing' && props.canApply && !props.applyConflict) {
          e.preventDefault()
          props.onApply()
          return
        }
      }
      props.onKeyDown?.(e)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [props, requestDiscard])

  const isFocused =
    props.uiPhase === 'composing' ||
    props.uiPhase === 'streaming' ||
    props.uiPhase === 'error'
  const isSplit = props.uiPhase === 'reviewing' || props.uiPhase === 'applied'

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex p-3 pt-10 sm:p-6 sm:pt-12 bg-black/40 backdrop-blur-sm animate-in fade-in duration-150"
      data-testid="ai-edit-backdrop"
    >
    <div
      ref={panelRef}
      role="dialog"
      aria-modal="true"
      aria-label={`${props.eyebrow} · ${props.targetLabel}`}
      className="m-auto w-full h-full max-w-[1600px] flex flex-col bg-background rounded-xl border border-border/40 shadow-2xl overflow-hidden"
      style={panelStyle}
    >
      <Header
        eyebrow={props.eyebrow}
        targetLabel={props.targetLabel}
        targetLabelMono={props.targetLabelMono ?? true}
        showApply={props.uiPhase === 'reviewing' && props.canApply && !props.applyConflict}
        showDiscard={props.uiPhase !== 'applied'}
        onApply={props.onApply}
        onDiscard={requestDiscard}
        onMinimize={props.onMinimize}
        headerHandleProps={headerHandleProps}
        isFloating={isFloating}
      />

      {isFocused && (
        <FocusedColumn
          uiPhase={props.uiPhase}
          headline={props.uiPhase === 'streaming' ? props.streamingHeadline : props.headline}
          description={props.description}
          chips={props.chips}
          onChipSubmit={props.onChipSubmit}
          streamingText={props.streamingText}
          composer={props.composer}
          composerAccessory={props.composerAccessory}
          history={props.history ?? []}
          baseBody={props.baseBody}
          baseBodyDisclosureLabel={props.baseBodyDisclosureLabel}
          errorMessage={props.errorMessage}
        />
      )}

      {isSplit && (
        <SplitColumn
          state={props}
          appliedNotice={props.appliedNotice}
        />
      )}

      {confirmDiscard && (
        <ConfirmDiscardDialog
          onCancel={() => setConfirmDiscard(false)}
          onConfirm={confirmDiscardAndClose}
        />
      )}
    </div>
    <ResizeGrips handles={resizeHandles} />
    </div>,
    document.body,
  )
}

// ─── Header ─────────────────────────────────────────────────────────────────

function Header({
  eyebrow,
  targetLabel,
  targetLabelMono,
  showApply,
  showDiscard,
  onApply,
  onDiscard,
  onMinimize,
  headerHandleProps,
  isFloating,
}: {
  eyebrow: string
  targetLabel: string
  targetLabelMono: boolean
  showApply: boolean
  showDiscard: boolean
  onApply: () => void
  onDiscard: () => void
  onMinimize?: () => void
  headerHandleProps: { onPointerDown: (e: React.PointerEvent<HTMLElement>) => void }
  isFloating: boolean
}) {
  const { t } = useTranslation('aiedit')
  // On Mac (Tauri overlay titlebar), traffic lights occupy ~80px at the
  // top-left. Pad the header so the back-arrow doesn't collide with them.
  const macPadLeft = isMacTauriOverlay() ? 'pl-[88px]' : 'pl-4'
  return (
    <div
      {...headerHandleProps}
      className={`flex-shrink-0 flex items-center justify-between ${macPadLeft} pr-4 h-14 border-b border-border bg-card/60 backdrop-blur-sm${
        isFloating ? ' cursor-grab active:cursor-grabbing' : ''
      }`}
    >
      <button
        type="button"
        onClick={onDiscard}
        className="flex items-center gap-2 group p-1 -ml-1 rounded hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:outline-none max-w-[60vw]"
        aria-label={t('shell.backAriaLabel')}
      >
        <ArrowLeft className="w-4 h-4 text-muted-foreground group-hover:text-foreground transition-colors flex-shrink-0" />
        <div className="text-left min-w-0">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground/70 leading-none">
            {eyebrow}
          </div>
          {targetLabelMono ? (
            <code className="text-sm font-mono font-medium text-foreground truncate block">
              {targetLabel}
            </code>
          ) : (
            <span className="text-sm font-medium text-foreground truncate block">
              {targetLabel}
            </span>
          )}
        </div>
      </button>
      <div className="flex items-center gap-2">
        {onMinimize && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onMinimize}
            aria-label={t('common:actions.minimize')}
            data-testid="ai-edit-minimize"
          >
            <Minus className="w-4 h-4" />
          </Button>
        )}
        {showDiscard && (
          <Button variant="ghost" size="sm" onClick={onDiscard}>
            {t('common:actions.discard')}
          </Button>
        )}
        {showApply && (
          <Button size="sm" onClick={onApply} className="gap-1.5">
            <Check className="w-3.5 h-3.5" /> {t('shell.apply')}
            <span className="text-[10px] opacity-70 ml-1">⌘⏎</span>
          </Button>
        )}
      </div>
    </div>
  )
}

// ─── Focused single-column layout ──────────────────────────────────────────

function FocusedColumn({
  uiPhase,
  headline,
  description,
  chips,
  onChipSubmit,
  streamingText,
  composer,
  composerAccessory,
  history,
  baseBody,
  baseBodyDisclosureLabel,
  errorMessage,
}: {
  uiPhase: AiEditUiPhase
  headline: string
  description?: string | null
  chips?: string[]
  onChipSubmit?: (text: string) => void
  streamingText?: string
  composer: ReactNode
  composerAccessory?: ReactNode
  history: AiEditHistoryTurn[]
  baseBody?: string
  baseBodyDisclosureLabel?: string
  errorMessage?: string | null
}) {
  const { t } = useTranslation('aiedit')
  const showChips =
    uiPhase === 'composing' && (chips?.length ?? 0) > 0 && history.length === 0
  const isError = uiPhase === 'error'
  const userTurns = history.filter(
    (t) => t.role === 'user' || (t.role === 'system' && t.kind === 'test_result'),
  )
  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="mx-auto max-w-2xl px-6 py-12 pb-32 flex flex-col gap-6">
        <header className="text-center space-y-2">
          <div
            className={
              'inline-flex items-center justify-center w-10 h-10 rounded-full ring-1 mx-auto ' +
              (isError
                ? 'bg-red-500/10 aurora-light:bg-destructive/10 ring-red-500/30 aurora-light:ring-destructive/30'
                : 'bg-accent-primary/15 ring-accent-primary/30')
            }
          >
            {isError ? (
              <AlertTriangle className="w-5 h-5 text-red-400 aurora-light:text-destructive" />
            ) : (
              <Sparkles className="w-5 h-5 text-accent-primary" />
            )}
          </div>
          <h1 className="text-xl font-semibold tracking-tight">
            {isError ? t('shell.somethingWentWrong') : headline}
          </h1>
          {isError && errorMessage && (
            <p className="text-sm text-muted-foreground max-w-md mx-auto font-mono break-words">
              {errorMessage}
            </p>
          )}
          {!isError && description && (
            <p className="text-sm text-muted-foreground max-w-md mx-auto leading-relaxed">
              {description}
            </p>
          )}
        </header>

        {uiPhase === 'streaming' && (
          <StreamingPanel streamingText={streamingText} />
        )}

        {showChips && chips && onChipSubmit && (
          <SuggestionChips chips={chips} onPick={onChipSubmit} />
        )}

        <div className="space-y-2">
          {composer}
          {composerAccessory && <div>{composerAccessory}</div>}
        </div>

        {userTurns.length > 0 && (
          <ConversationHistory history={userTurns} />
        )}

        {baseBody && (
          <CurrentBodyDisclosure
            body={baseBody}
            label={baseBodyDisclosureLabel ?? t('shell.viewCurrentContent')}
          />
        )}
      </div>
    </div>
  )
}

function SuggestionChips({
  chips,
  onPick,
}: {
  chips: string[]
  onPick: (text: string) => void
}) {
  const { t } = useTranslation('aiedit')
  return (
    <div className="space-y-2">
      <div className="text-[11px] uppercase tracking-wider text-muted-foreground/70">
        {t('shell.quickPrompts')}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {chips.map((chip) => (
          <button
            key={chip}
            type="button"
            onClick={() => onPick(chip)}
            className="text-xs px-3 py-1.5 rounded-full border border-border bg-card/40 hover:border-accent-primary/50 hover:bg-accent-primary/10 hover:text-accent-primary text-foreground/80 transition-colors focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:outline-none"
          >
            {chip}
          </button>
        ))}
      </div>
    </div>
  )
}

function StreamingPanel({ streamingText }: { streamingText?: string }) {
  const { t } = useTranslation('aiedit')
  return (
    <div className="rounded-xl border border-accent-primary/30 bg-accent-primary/5 p-4">
      {streamingText ? (
        <div className="text-xs font-mono whitespace-pre-wrap break-words text-foreground/80 max-h-64 overflow-y-auto leading-relaxed">
          {stripMarkers(streamingText)}
          <span className="inline-block w-1.5 h-3 bg-accent-primary animate-pulse align-middle ml-0.5" />
        </div>
      ) : (
        <div className="text-xs text-muted-foreground italic flex items-center gap-1.5">
          <Loader2 className="w-3 h-3 animate-spin" />
          {t('shell.workingOnRefinement')}
        </div>
      )}
    </div>
  )
}

function ConversationHistory({ history }: { history: AiEditHistoryTurn[] }) {
  const { t } = useTranslation('aiedit')
  if (history.length === 0) return null
  return (
    <div className="space-y-2">
      <div className="text-[11px] uppercase tracking-wider text-muted-foreground/70">
        {t('shell.history')}
      </div>
      <div className="space-y-2">
        {history.map((turn, i) => (
          <ChatTurn key={i} turn={turn} />
        ))}
      </div>
    </div>
  )
}

function CurrentBodyDisclosure({ body, label }: { body: string; label: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="border-t border-border/60 pt-4">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:outline-none rounded px-1 -ml-1"
      >
        {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        {label}
      </button>
      {open && (
        <pre className="mt-2 p-3 rounded-md bg-muted/40 border border-border text-[11px] font-mono whitespace-pre-wrap break-words max-h-72 overflow-y-auto text-foreground/80">
          {body}
        </pre>
      )}
    </div>
  )
}

// ─── Split layout (Reviewing / Applied) ────────────────────────────────────

function SplitColumn({
  state,
  appliedNotice,
}: {
  state: AiEditShellProps
  appliedNotice?: ReactNode
}) {
  return (
    <div className="flex-1 min-h-0 grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
      <ChatColumn
        history={state.history ?? []}
        composer={state.composer}
        composerAccessory={state.composerAccessory}
        secondaryAction={state.secondaryAction}
        appliedNotice={appliedNotice}
        uiPhase={state.uiPhase}
      />
      <DiffPane
        diff={state.diff}
        label={state.diffHeaderLabel}
        applyConflict={state.applyConflict ?? null}
        onForceApply={state.onForceApply}
      />
    </div>
  )
}

function ChatColumn({
  history,
  composer,
  composerAccessory,
  secondaryAction,
  appliedNotice,
  uiPhase,
}: {
  history: AiEditHistoryTurn[]
  composer: ReactNode
  composerAccessory?: ReactNode
  secondaryAction?: { label: string; onClick: () => void; icon?: ReactNode }
  appliedNotice?: ReactNode
  uiPhase: AiEditUiPhase
}) {
  const { t } = useTranslation('aiedit')
  return (
    <section
      aria-label={t('shell.conversation')}
      className="flex flex-col min-h-0 border-r border-border bg-card/20"
    >
      <div className="flex-1 overflow-y-auto p-4 pb-32 space-y-3" aria-live="polite">
        {history.map((turn, i) => (
          <ChatTurn key={i} turn={turn} />
        ))}
        {uiPhase === 'applied' && (appliedNotice ?? <DefaultAppliedNotice />)}
      </div>

      <div className="flex-shrink-0 border-t border-border p-3 space-y-2">
        {composer}
        {composerAccessory}
        {secondaryAction && (
          <button
            type="button"
            onClick={secondaryAction.onClick}
            className="w-full inline-flex items-center justify-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground py-1.5 rounded hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:outline-none"
          >
            {secondaryAction.icon ?? <ExternalLink className="w-3 h-3" />}
            {secondaryAction.label}
          </button>
        )}
      </div>
    </section>
  )
}

function DefaultAppliedNotice() {
  const { t } = useTranslation('aiedit')
  return (
    <div className="rounded-md border border-green-500/40 aurora-light:border-accent-success/40 bg-green-500/10 aurora-light:bg-accent-success/10 p-3 text-xs text-green-300 aurora-light:text-accent-success flex items-center gap-2">
      <Check className="w-3.5 h-3.5" />
      {t('shell.applied')}
    </div>
  )
}

function ChatTurn({ turn }: { turn: AiEditHistoryTurn }) {
  const { t } = useTranslation('aiedit')
  if (turn.role === 'user') {
    return (
      <div className="flex flex-col items-end">
        <div className="text-[10px] text-muted-foreground mb-1">{t('shell.you')}</div>
        <div className="max-w-[90%] rounded-2xl rounded-br-sm bg-accent-primary/15 text-foreground text-sm px-3 py-2 whitespace-pre-wrap break-words">
          {turn.content}
        </div>
      </div>
    )
  }
  if (turn.role === 'system' && turn.kind === 'test_result') {
    return (
      <div className="rounded-md border border-accent-info/30 bg-accent-info/5 p-3 text-xs">
        <div className="flex items-center gap-1.5 font-medium mb-1 text-accent-info">
          <Sparkles className="w-3 h-3" /> {t('shell.autoTestResult')}
        </div>
        <pre className="text-[11px] font-mono whitespace-pre-wrap break-words text-foreground/80 max-h-48 overflow-y-auto">
          {turn.content}
        </pre>
      </div>
    )
  }
  return (
    <div className="flex flex-col items-start">
      <div className="text-[10px] text-muted-foreground mb-1 inline-flex items-center gap-1">
        <Sparkles className="w-3 h-3 text-accent-primary" /> {t('shell.ai')}
      </div>
      <div className="max-w-[90%] rounded-2xl rounded-bl-sm border border-border bg-muted/30 text-xs px-3 py-2 text-muted-foreground italic">
        {t('shell.refinementReady')}
      </div>
    </div>
  )
}

function DiffPane({
  diff,
  label,
  applyConflict,
  onForceApply,
}: {
  diff?: ReactNode
  label?: string
  applyConflict: 'disk_changed' | 'name_changed' | null
  onForceApply?: () => void
}) {
  const { t } = useTranslation('aiedit')
  return (
    <section aria-label={t('shell.diffPreview')} className="flex flex-col min-h-0">
      <div className="flex-shrink-0 flex items-center justify-between px-4 h-9 border-b border-border bg-card/40">
        <span className="text-xs font-mono text-muted-foreground truncate">
          {label ?? t('shell.proposedChanges')}
        </span>
        <span className="text-[10px] text-muted-foreground">{t('shell.wordLevelDiff')}</span>
      </div>
      {applyConflict === 'disk_changed' && (
        <ConflictBanner
          kind="disk_changed"
          action={
            onForceApply && (
              <Button variant="ghost" size="sm" onClick={onForceApply}>
                <RefreshCw className="w-3 h-3 mr-1" /> {t('shell.forceApply')}
              </Button>
            )
          }
        />
      )}
      {applyConflict === 'name_changed' && <ConflictBanner kind="name_changed" />}
      <div className="flex-1 overflow-auto p-4 pb-32">{diff}</div>
    </section>
  )
}

function ConflictBanner({
  kind,
  action,
}: {
  kind: 'disk_changed' | 'name_changed'
  action?: ReactNode
}) {
  const { t } = useTranslation('aiedit')
  const message =
    kind === 'disk_changed'
      ? t('shell.conflict.diskChanged')
      : t('shell.conflict.nameChanged')
  return (
    <div
      role="alert"
      className="flex items-start justify-between gap-3 px-4 py-2 border-b border-yellow-500/40 aurora-light:border-accent-warning/40 bg-yellow-500/10 aurora-light:bg-accent-warning/10 text-yellow-200 aurora-light:text-accent-warning text-xs"
    >
      <div className="flex items-start gap-2 min-w-0">
        <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
        <span>{message}</span>
      </div>
      {action}
    </div>
  )
}

function ConfirmDiscardDialog({
  onCancel,
  onConfirm,
}: {
  onCancel: () => void
  onConfirm: () => void
}) {
  const { t } = useTranslation('aiedit')
  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-label={t('shell.discardDialog.ariaLabel')}
      className="absolute inset-0 z-10 flex items-center justify-center bg-black/40"
    >
      <div className="rounded-lg border border-border bg-card p-5 max-w-sm shadow-xl">
        <div className="flex items-center gap-2 mb-2">
          <AlertTriangle className="w-4 h-4 text-yellow-400 aurora-light:text-accent-warning" />
          <h2 className="text-sm font-medium">{t('shell.discardDialog.title')}</h2>
        </div>
        <p className="text-xs text-muted-foreground mb-4">
          {t('shell.discardDialog.body')}
        </p>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel}>
            {t('shell.discardDialog.keepEditing')}
          </Button>
          <Button size="sm" onClick={onConfirm}>
            {t('common:actions.discard')}
          </Button>
        </div>
      </div>
    </div>
  )
}

// ─── Word-level diff (default renderer, exported for reuse) ────────────────

export interface DiffHunk {
  type: 'eq' | 'add' | 'del'
  text: string
}

export function WordDiffView({ hunks }: { hunks: DiffHunk[] }) {
  return (
    <pre className="font-mono text-xs leading-5 whitespace-pre-wrap break-words">
      {hunks.map((h, i) => {
        if (h.type === 'eq') return <span key={i} className="text-foreground/70">{h.text}</span>
        if (h.type === 'add') {
          return (
            <span
              key={i}
              data-hunk="add"
              className="bg-green-500/20 aurora-light:bg-accent-success/15 text-green-200 aurora-light:text-accent-success rounded px-0.5 ring-1 ring-green-500/30 aurora-light:ring-accent-success/30"
            >
              <span aria-hidden="true">+ </span>
              {h.text}
            </span>
          )
        }
        return (
          <span
            key={i}
            data-hunk="del"
            className="bg-red-500/20 aurora-light:bg-destructive/15 text-red-200 aurora-light:text-destructive line-through rounded px-0.5 ring-1 ring-red-500/30 aurora-light:ring-destructive/30"
          >
            <span aria-hidden="true">− </span>
            {h.text}
          </span>
        )
      })}
    </pre>
  )
}

export function stripMarkers(s: string): string {
  return s.replace(/<!--tool:[^>]+-->/g, '')
}

export function computeWordDiff(oldText: string, newText: string): DiffHunk[] {
  const splitRx = /(\s+)/
  const a = oldText.split(splitRx)
  const b = newText.split(splitRx)
  if (a.length > 20_000 || b.length > 20_000) {
    return computeLineDiff(oldText, newText)
  }
  const m = a.length
  const n = b.length
  const dp: Uint16Array = new Uint16Array((m + 1) * (n + 1))
  const stride = n + 1
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (a[i] === b[j]) {
        dp[i * stride + j] = dp[(i + 1) * stride + (j + 1)] + 1
      } else {
        dp[i * stride + j] = Math.max(dp[(i + 1) * stride + j], dp[i * stride + (j + 1)])
      }
    }
  }
  const out: DiffHunk[] = []
  let i = 0
  let j = 0
  let bufType: 'eq' | 'add' | 'del' | null = null
  let buf = ''
  const flush = () => {
    if (bufType !== null && buf) out.push({ type: bufType, text: buf })
    bufType = null
    buf = ''
  }
  const append = (type: 'eq' | 'add' | 'del', text: string) => {
    if (bufType === type) {
      buf += text
    } else {
      flush()
      bufType = type
      buf = text
    }
  }
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      append('eq', a[i])
      i++
      j++
    } else if (dp[(i + 1) * stride + j] >= dp[i * stride + (j + 1)]) {
      append('del', a[i])
      i++
    } else {
      append('add', b[j])
      j++
    }
  }
  while (i < m) append('del', a[i++])
  while (j < n) append('add', b[j++])
  flush()
  return out
}

function computeLineDiff(oldText: string, newText: string): DiffHunk[] {
  const a = oldText.split('\n')
  const b = newText.split('\n')
  const out: DiffHunk[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ type: 'eq', text: a[i] + '\n' })
      i++
      j++
    } else {
      const nextEqInA = b.indexOf(a[i], j)
      const nextEqInB = a.indexOf(b[j], i)
      if (nextEqInA !== -1 && (nextEqInB === -1 || nextEqInA - j <= nextEqInB - i)) {
        out.push({ type: 'add', text: b[j] + '\n' })
        j++
      } else {
        out.push({ type: 'del', text: a[i] + '\n' })
        i++
      }
    }
  }
  while (i < a.length) out.push({ type: 'del', text: a[i++] + '\n' })
  while (j < b.length) out.push({ type: 'add', text: b[j++] + '\n' })
  return out
}

// ─── Reusable plain-textarea composer ──────────────────────────────────────

export interface PlainComposerProps {
  value: string
  onChange: (v: string) => void
  onSubmit: () => void
  disabled: boolean
  placeholder: string
  autoFocus?: boolean
  inputRef?: React.RefObject<HTMLTextAreaElement | null>
}

export function PlainComposer({
  value,
  onChange,
  onSubmit,
  disabled,
  placeholder,
  autoFocus,
  inputRef,
}: PlainComposerProps) {
  const { t } = useTranslation('aiedit')
  return (
    <div className="space-y-2">
      <div className="relative rounded-xl border border-border bg-card/40 focus-within:border-accent-primary/40 focus-within:ring-2 focus-within:ring-accent-primary/20 transition-all">
        <textarea
          ref={inputRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          rows={3}
          disabled={disabled}
          autoFocus={autoFocus}
          className="w-full text-sm p-3 pr-14 bg-transparent resize-none focus:outline-none disabled:opacity-50 placeholder:text-muted-foreground/60"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              onSubmit()
            }
          }}
        />
        <button
          type="button"
          onClick={onSubmit}
          disabled={!value.trim() || disabled}
          aria-label={t('shell.composer.sendAriaLabel')}
          className="absolute bottom-2.5 right-2.5 p-2 rounded-md bg-accent-primary text-white hover:bg-accent-primary/90 disabled:opacity-30 disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:outline-none transition-opacity"
        >
          {disabled ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <SendIcon />
          )}
        </button>
      </div>
      <div className="flex items-center justify-end text-[11px] text-muted-foreground/70">
        <span>
          <kbd className="px-1.5 py-0.5 rounded bg-muted/60 text-[10px] font-mono">⌘⏎</kbd> {t('shell.composer.kbdSubmit')}
          <span className="mx-1.5">·</span>
          <kbd className="px-1.5 py-0.5 rounded bg-muted/60 text-[10px] font-mono">Esc</kbd> {t('shell.composer.kbdCancel')}
        </span>
      </div>
    </div>
  )
}

// Tiny inline send icon to avoid bundling lucide twice in shell.
function SendIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="w-3.5 h-3.5"
    >
      <path d="M22 2 11 13" />
      <path d="M22 2 15 22l-4-9-9-4Z" />
    </svg>
  )
}
