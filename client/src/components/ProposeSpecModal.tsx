import { useEffect, useCallback, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Sparkles, Send, Zap, MessagesSquare, Globe, Ratio, PenLine, Plug } from 'lucide-react'
import { toast } from 'sonner'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog'
import { Button } from './ui/button'
import { useDesktop } from '../hooks/useDesktop'
import { useSpecGenTracker } from '../hooks/useSpecGenTracker'
import { API_ORIGIN } from '../lib/origin'
import { deleteAllAttachments } from '../lib/attachments'
import { RichAttachmentEditor, type RichAttachmentEditorHandle } from './RichAttachmentEditor'
import { SpecModelPicker, useDefaultSpecModel } from './explore-spec/SpecModelPicker'
import { AiEngineSelector } from './AiEngineSelector'
import type { LocalTicket, TicketPriority } from '../types'
import { ContextScopeChecks } from './ContextScopeChecks'
import { ContextScopeSlider } from './ContextScopeSlider'
import {
  isSmashCapable,
  providerLabel,
  providerSupportsPureOutput,
  providerSupportsStructuredActions,
  providerSupportsUserMcp,
  type ProviderId,
} from '../lib/provider-capabilities'
import { getLastEngine, setLastEngine } from '../lib/last-engine'
import { useContextScope } from '../hooks/useContextScope'
import { useContextBudget } from '../hooks/useContextBudget'
import { useQuickContractRefineLast } from '../hooks/useQuickContractRefineLast'
import { useJiraConnection } from '../hooks/useJiraConnection'
import { quickHintForScope, tierFromScope, submitAccentForTier, type ContextScope, type SpecMode } from '../types/context-scope'
import { BrowserCaptureModal } from './browser-capture/BrowserCaptureModal'
import { CapturedDomPanel } from './browser-capture/CapturedDomPanel'
import { isBrowserCaptureEnabled, type CaptureResult, type CapturedDom } from '../lib/browser-capture'

interface BrowserCaptureBreakpoint {
  key: string
  attachmentId: string
  dataUrl: string
  width: number
}

interface BrowserCaptureEntry {
  screenshotId: string
  screenshotName: string
  screenshotDataUrl: string
  domAttachmentId: string
  dom: CapturedDom
  /** Present for a multi-breakpoint capture: one screenshot per device size. */
  breakpoints?: BrowserCaptureBreakpoint[]
}

/** Premium presentation classes for the Raw-mode priority pill selector.
 *  Distinct from the board cards' `PRIORITY_VARIANT` — tuned for the modal
 *  surface (info/muted palette). Semantic theme tokens only. */
const RAW_PRIORITY_CLASS: Record<TicketPriority, string> = {
  critical: 'bg-destructive/15 text-destructive',
  high: 'bg-accent-warning/15 text-accent-warning',
  medium: 'bg-accent-info/15 text-accent-info',
  low: 'bg-muted text-muted-foreground',
}
const RAW_PRIORITY_ORDER: readonly TicketPriority[] = ['critical', 'high', 'medium', 'low']

export interface ExploreLaunchPayload {
  idea: string
  pendingSpecId: string
  initialAttachmentIds: string[]
  /** Model picked at Add Spec — locked for the lifetime of the explore flow.
   *  No downstream UI changes it. */
  model: string
  /** AI engine picked at Add Spec (multi-provider). Undefined → project primary.
   *  Forwarded to the ExploreSpecShell so the conversation runs on it. */
  provider?: ProviderId
  /** Add Spec context scope frozen at launch time. Forwarded to the
   *  ExploreSpecShell so the server-side conversation row carries it. */
  contextScope: ContextScope
}

interface ProposeSpecModalProps {
  open: boolean
  onClose: () => void
  tickets: LocalTicket[]
  /** Required when explore mode should be wired. Parent owns the
   *  ExploreSpecShell lifecycle so it can keep the chat alive across
   *  modal close events (used by the minimize-to-dock flow). */
  onExploreLaunch?: (payload: ExploreLaunchPayload) => void
}

function genPendingId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  // fallback (shouldn't be hit in modern browsers)
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

export function ProposeSpecModal({ open, onClose, tickets, onExploreLaunch }: ProposeSpecModalProps) {
  const { t } = useTranslation('addspec')
  const { t: tj } = useTranslation('jira')
  // On a Jira-backed project, new specs are always created in Jira; the indicator
  // makes that explicit. (Private/not-yet-official specs use Save as Draft.)
  const jira = useJiraConnection()
  const { activeProjectId, projects } = useDesktop()
  const tracker = useSpecGenTracker()
  const [mode, setMode] = useState<SpecMode>('quick')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [hasText, setHasText] = useState(false)
  const [attachmentCount, setAttachmentCount] = useState(0)
  const [pendingSpecId, setPendingSpecId] = useState<string>(() => genPendingId())
  const [browserOpen, setBrowserOpen] = useState(false)
  const [captures, setCaptures] = useState<BrowserCaptureEntry[]>([])
  const browserCaptureEnabled = isBrowserCaptureEnabled()
  const editorRef = useRef<RichAttachmentEditorHandle | null>(null)
  const submittedRef = useRef(false)
  const scopeTouchedRef = useRef(false)

  // Raw mode ("free") — the user's prompt is saved verbatim as a spec, no AI.
  // Title auto-derives from the first non-empty line of the body until the user
  // edits it (titleTouchedRef). Priority defaults to medium; labels optional.
  const [title, setTitle] = useState('')
  const titleTouchedRef = useRef(false)
  const [priority, setPriority] = useState<TicketPriority>('medium')
  const [labels, setLabels] = useState<string[]>([])

  // AI Engine (multi-provider). null until the first fetch resolves the
  // project's providers; then initialised to the last-used engine (default =
  // primary). Single-provider projects never render the selector.
  const [engine, setEngine] = useState<ProviderId | null>(null)

  // Model picker — fetched on each open. Locked for the whole flow once the
  // user submits; no downstream surface changes it. See spec
  // `add-spec-model-selection`. Refetches when the engine changes.
  const {
    model,
    setModel,
    allowed,
    customModelAliases,
    loading: modelLoading,
    provider,
    providers,
  } =
    useDefaultSpecModel(activeProjectId, open, engine)

  // Initialise the engine selection once providers are known (remember last
  // choice per project; default to primary).
  useEffect(() => {
    if (!open || engine || providers.length === 0) return
    setEngine(getLastEngine(activeProjectId, providers, provider ?? 'claude'))
  }, [open, engine, providers, provider, activeProjectId])

  const handleEngineChange = useCallback((next: ProviderId) => {
    setEngine(next)
    setLastEngine(activeProjectId, next)
  }, [activeProjectId])

  // Effective provider drives SMASH gating + the payload's aiEngine. Prefer the
  // user's pick; fall back to the resolved primary while it loads.
  const effectiveProvider = engine ?? provider
  const quickAvailable = effectiveProvider == null
    || providerSupportsPureOutput(effectiveProvider)
  const userMcpSupported = effectiveProvider == null
    || providerSupportsUserMcp(effectiveProvider)
  const contractRefineSupported = effectiveProvider == null
    || providerSupportsStructuredActions(effectiveProvider)

  const { scope, setScope, persist: persistScope } = useContextScope(activeProjectId, mode, open)
  const quickRefine = useQuickContractRefineLast(activeProjectId, open)
  const { data: budget, isError: budgetError } = useContextBudget(activeProjectId, open)
  const sanitizeScopeForProvider = useCallback((candidate: ContextScope): ContextScope => {
    const userMcp = userMcpSupported ? candidate.userMcp : false
    const contractRefine = contractRefineSupported ? candidate.contractRefine : false
    if (
      userMcp === candidate.userMcp
      && contractRefine === candidate.contractRefine
    ) {
      return candidate
    }
    return { ...candidate, userMcp, contractRefine }
  }, [userMcpSupported, contractRefineSupported])
  const effectiveScope = useMemo(
    () => sanitizeScopeForProvider(scope),
    [scope, sanitizeScopeForProvider],
  )
  const tier = useMemo(() => tierFromScope(effectiveScope), [effectiveScope])
  const smashCapable = isSmashCapable(effectiveProvider)

  useEffect(() => {
    if (open && mode === 'quick' && !quickAvailable) setMode('explore')
  }, [open, mode, quickAvailable])

  useEffect(() => {
    if (
      mode !== 'quick'
      || !quickRefine.loaded
      || scopeTouchedRef.current
      || !contractRefineSupported
    ) return
    setScope((prev) => ({ ...prev, contractRefine: quickRefine.value }))
  }, [mode, quickRefine.loaded, quickRefine.value, setScope, contractRefineSupported])

  // Provider changes can invalidate values restored from the previous
  // provider's persisted preset. Clear them in state as well as at submit time
  // so disabled controls never conceal a stale true value.
  useEffect(() => {
    if (scope !== effectiveScope) setScope(effectiveScope)
  }, [scope, effectiveScope, setScope])

  const handleScopeChange = useCallback((next: ContextScope | ((s: ContextScope) => ContextScope)) => {
    scopeTouchedRef.current = true
    setScope((previous) => sanitizeScopeForProvider(
      typeof next === 'function' ? next(previous) : next,
    ))
  }, [setScope, sanitizeScopeForProvider])

  useEffect(() => {
    scopeTouchedRef.current = false
  }, [mode])

  const activeProjectIdRef = useRef(activeProjectId)
  useEffect(() => { activeProjectIdRef.current = activeProjectId }, [activeProjectId])

  const projectsRef = useRef(projects)
  useEffect(() => { projectsRef.current = projects }, [projects])

  // Reset on open; cleanup orphaned attachments on close-without-submit
  useEffect(() => {
    if (open) {
      setPendingSpecId(genPendingId())
      setMode('quick')
      setIsSubmitting(false)
      setHasText(false)
      setAttachmentCount(0)
      setEngine(null)
      setBrowserOpen(false)
      setCaptures([])
      setTitle('')
      setPriority('medium')
      setLabels([])
      submittedRef.current = false
      scopeTouchedRef.current = false
      titleTouchedRef.current = false
      // defer to let dialog mount; reset any user-resized height so the modal
      // always opens at the configured minHeight, then focus the editor.
      setTimeout(() => {
        editorRef.current?.resetHeight()
        editorRef.current?.focus()
      }, 50)
    }
  }, [open])

  useEffect(() => {
    // On close, if not submitted and we had attachments, clean up
    if (!open && !submittedRef.current && attachmentCount > 0) {
      deleteAllAttachments(pendingSpecId).catch((err) => console.warn('[ProposeSpec] cleanup failed:', err))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const canSubmit = useMemo(
    () => (hasText || captures.length > 0)
      && !isSubmitting
      && (mode === 'free' || (!modelLoading && model !== null))
      && (mode !== 'quick' || quickAvailable),
    [hasText, captures.length, isSubmitting, mode, quickAvailable, modelLoading, model],
  )

  const handleCaptured = useCallback((result: CaptureResult) => {
    // A capture contributes two attachments (screenshot image + DOM JSON). Both
    // are tracked here and merged into the submit payload; the screenshot renders
    // as a visual chip and the DOM in a collapsible panel. They are NOT inserted
    // as editor pills so removeCapture can cleanly drop both.
    // If the user annotated, the flattened image is `screenshot`; drop the raw one
    // it replaced so only the annotated image + DOM ride into the spec.
    if (result.rawScreenshot && result.rawScreenshot.id !== result.screenshot.id) {
      const pid = activeProjectIdRef.current
      fetch(`${API_ORIGIN}/api/projects/${pid}/tickets/${pendingSpecId}/attachments/${result.rawScreenshot.id}`, { method: 'DELETE' }).catch(() => {})
    }
    const breakpoints = result.breakpoints
      ? Object.entries(result.breakpoints).map(([key, b]) => ({ key, attachmentId: b.attachment.id, dataUrl: b.dataUrl, width: b.viewport.width }))
      : undefined
    setCaptures((c) => [...c, {
      screenshotId: result.screenshot.id,
      screenshotName: result.screenshot.filename,
      screenshotDataUrl: result.screenshotDataUrl,
      domAttachmentId: result.domAttachment.id,
      dom: result.dom,
      breakpoints,
    }])
    // One DOM attachment + N screenshots (N=1 for a normal capture).
    setAttachmentCount((c) => c + 1 + (breakpoints ? breakpoints.length : 1))
  }, [pendingSpecId])

  const removeCapture = useCallback((entry: BrowserCaptureEntry) => {
    setCaptures((c) => c.filter((e) => e.domAttachmentId !== entry.domAttachmentId))
    const ids = new Set<string>([entry.screenshotId, entry.domAttachmentId, ...(entry.breakpoints?.map((b) => b.attachmentId) ?? [])])
    setAttachmentCount((c) => Math.max(0, c - ids.size))
    const pid = activeProjectIdRef.current
    for (const id of ids) {
      fetch(`${API_ORIGIN}/api/projects/${pid}/tickets/${pendingSpecId}/attachments/${id}`, { method: 'DELETE' }).catch(() => {})
    }
  }, [pendingSpecId])

  const handleSubmit = useCallback(async () => {
    const typed = editorRef.current?.getPlainText().trim() ?? ''
    let idea = typed || (captures.length > 0
      ? 'Create a spec based on the captured browser selection (a screenshot and the page DOM are attached for reference).'
      : '')
    if (!idea) return
    // When any capture is multi-breakpoint, tell the spec generator it must be
    // responsive and which reference sizes are attached.
    const responsive = captures.find((c) => c.breakpoints && c.breakpoints.length > 1)
    if (responsive) {
      const widths = responsive.breakpoints!.map((b) => `${b.width}px`).join(', ')
      idea += `${idea ? '\n\n' : ''}This element must be responsive: reference screenshots are attached at ${widths}.`
    }
    const attachmentIds = [
      ...(editorRef.current?.getAttachmentIds() ?? []),
      ...captures.flatMap((c) => [
        ...(c.breakpoints ? c.breakpoints.map((b) => b.attachmentId) : [c.screenshotId]),
        c.domAttachmentId,
      ]),
    ]

    const projectId = activeProjectIdRef.current
    if (!projectId) return
    if (mode !== 'free' && (modelLoading || model === null)) return
    if (mode === 'quick' && !quickAvailable) {
      setMode('explore')
      return
    }

    // Raw mode: persist the prompt verbatim as a spec ticket. No AI runs — a
    // direct create against /tickets/from-prompt (status='todo', ready for
    // rails). The editor text is the description; title falls back to a
    // server-derived single line when left blank.
    if (mode === 'free') {
      // Raw mode is self-contained: the spec body is exactly the editor text
      // and only the editor's own attachments ride along (browser captures are
      // a Quick/Explore concept and are intentionally ignored here, even if the
      // user switched modes after capturing).
      const description = editorRef.current?.getPlainText().trim() ?? ''
      if (!description) return
      const rawAttachmentIds = editorRef.current?.getAttachmentIds() ?? []
      submittedRef.current = true // suppress attachment cleanup on close
      setIsSubmitting(true)
      try {
        const res = await fetch(`${API_ORIGIN}/api/projects/${projectId}/tickets/from-prompt`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            description,
            title: title.trim() || undefined,
            labels: labels.length > 0 ? labels : undefined,
            priority,
            structured: false,
            attachmentIds: rawAttachmentIds,
            pendingSpecId,
          }),
        })
        if (!res.ok) {
          submittedRef.current = false
          toast.error(t('proposeModal.toast.createFailed'))
          return
        }
        const data = await res.json().catch(() => ({})) as { ticket?: { id?: number } }
        const newId = data.ticket?.id
        toast.success(newId ? t('proposeModal.toast.rawSavedWithId', { id: newId }) : t('proposeModal.toast.rawCreated'))
        onClose()
      } catch (err) {
        submittedRef.current = false
        console.error('[ProposeSpec] from-prompt failed:', err)
        toast.error(t('proposeModal.toast.createFailed'))
      } finally {
        setIsSubmitting(false)
      }
      return
    }

    // Explore mode: hand off to the parent (which owns the overlay
    // lifecycle so the conversation can survive modal close — i.e. minimize
    // to dock). Attachments uploaded into pendingSpecId are carried through
    // and folded into Claude's context for the first turn.
    if (mode === 'explore') {
      if (!onExploreLaunch) {
        toast.error(t('proposeModal.toast.exploreNotWired'))
        return
      }
      submittedRef.current = true // suppress attachment cleanup on close
      void persistScope(effectiveScope)
      onExploreLaunch({
        idea, pendingSpecId, initialAttachmentIds: attachmentIds,
        model: model!,
        provider: effectiveProvider ?? undefined,
        contextScope: effectiveScope,
      })
      onClose()
      return
    }

    const projectName = projectsRef.current.find(p => p.id === projectId)?.name ?? 'Project'
    const toastId = `spec-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const truncated = idea.length > 45 ? idea.slice(0, 45) + '…' : idea
    const knownTicketIds = new Set(tickets.map(t => t.id))
    const startTime = Date.now()

    toast.loading(`${projectName} · ${truncated}`, { id: toastId, description: t('proposeModal.toast.generating') })

    submittedRef.current = true
    void quickRefine.persist(effectiveScope.contractRefine)
    setIsSubmitting(true)
    editorRef.current?.clear()
    setAttachmentCount(0)
    setHasText(false)
    setCaptures([])

    const reg = { toastId, truncated, knownTicketIds, projectId, projectName, startTime, persistId: toastId }

    try {
      let res: Response
      try {
        res = await fetch(`${API_ORIGIN}/api/projects/${projectId}/tickets/generate-spec`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            idea, attachmentIds, pendingSpecId, model: model ?? undefined,
            aiEngine: effectiveProvider ?? undefined,
            contextScope: {
              specrails: effectiveScope.specrails,
              openspec: effectiveScope.openspec,
              full: effectiveScope.full,
              mcp: effectiveScope.mcp,
              userMcp: effectiveScope.userMcp,
              contractRefine: effectiveScope.contractRefine,
            },
            contractRefine: effectiveScope.contractRefine,
          }),
        })
      } catch (err) {
        console.error('[ProposeSpec] generate-spec fetch threw:', err)
        toast.error(t('proposeModal.toast.failedToStart', { projectName }), { id: toastId })
        return
      }
      if (!res.ok) {
        toast.error(t('proposeModal.toast.failedToStart', { projectName }), { id: toastId })
        return
      }
      const data = await res.json() as { requestId: string }
      tracker.registerFastSpec(data.requestId, reg)
    } finally {
      setIsSubmitting(false)
    }
  }, [mode, tickets, tracker, pendingSpecId, onClose, onExploreLaunch, model, quickRefine, effectiveScope, effectiveProvider, quickAvailable, captures, title, priority, labels, t])

  return (
    <>
      {/* While the browser-capture modal is open we drop the Add Spec dialog to
          non-modal: Radix's modal layer otherwise sets `pointer-events:none` on
          <body> and traps focus inside DialogContent, which would block the
          body-portaled BrowserCaptureModal (can't interact with URL bar or
          canvas). DialogContent stays mounted with state preserved while the
          capture modal is stacked above at a higher z-index. */}
      <Dialog open={open} modal={!browserOpen} onOpenChange={(o) => { if (!o && !browserOpen) onClose() }}>
        <DialogContent movableResizable className="max-w-4xl flex flex-col gap-0 p-0 overflow-hidden">
          <DialogHeader className="px-5 py-4 border-b border-border/40 shrink-0">
            <DialogTitle className="text-sm flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-primary/70" />
              {t('proposeModal.title')}
            </DialogTitle>
            <DialogDescription className="sr-only">
              {t('proposeModal.dialogDescription')}
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col p-5 gap-4 flex-1 min-h-0 overflow-y-auto">
            <div className="flex items-center justify-between gap-3">
              <ModeSegmented
                value={mode}
                onChange={setMode}
                fullCodebase={effectiveScope.full}
                quickAvailable={quickAvailable}
              />
              {mode !== 'free' && (
                <div className="flex items-center gap-2">
                  <AiEngineSelector
                    value={effectiveProvider ?? 'claude'}
                    providers={providers}
                    onChange={handleEngineChange}
                    disabled={modelLoading}
                    ariaLabel={t('proposeModal.engineAriaLabel')}
                  />
                  <SpecModelPicker
                    value={model}
                    allowed={allowed}
                    customModelAliases={customModelAliases}
                    loading={modelLoading}
                    onChange={setModel}
                  />
                </div>
              )}
            </div>

            {mode !== 'free' && (
              <div className="space-y-3">
                <ContextScopeSlider
                  value={effectiveScope}
                  onChange={handleScopeChange}
                  budget={budget}
                  budgetError={budgetError}
                  model={model ?? ''}
                  maxPresetId={mode === 'quick' ? 'max' : 'desktop'}
                  smashCapable={smashCapable}
                />
                <ContextScopeChecks
                  scope={effectiveScope}
                  mode={mode}
                  onChange={handleScopeChange}
                  label={t('contextScope.fineTune')}
                  showSummary={false}
                  userMcpSupported={userMcpSupported}
                  contractRefineSupported={contractRefineSupported}
                  providerLabel={providerLabel(effectiveProvider)}
                />
              </div>
            )}

            {mode === 'free' && (
              <div className="flex flex-col gap-4 animate-in fade-in slide-in-from-bottom-1 duration-150">
                {/* Title — auto-derived from the first line of the body, editable. */}
                <div className="flex items-center gap-3">
                  <label htmlFor="raw-spec-title" className="text-xs font-medium text-muted-foreground whitespace-nowrap">
                    {t('proposeModal.raw.titleLabel')}
                  </label>
                  <input
                    id="raw-spec-title"
                    type="text"
                    value={title}
                    onChange={(e) => {
                      // Any edit hands the field to the user: stop auto-deriving.
                      // If they leave it blank, the server derives a title from
                      // the body on submit (no dead/empty-title state).
                      titleTouchedRef.current = true
                      setTitle(e.target.value)
                    }}
                    placeholder={t('proposeModal.raw.titlePlaceholder')}
                    data-testid="raw-title-input"
                    className="flex-1 h-8 px-2.5 rounded-md bg-card/40 border border-border/40 text-sm text-foreground placeholder-muted-foreground/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-info/40 focus-visible:border-accent-info/60 transition-colors"
                  />
                </div>

                {/* Priority pills + optional labels. */}
                <div className="flex items-center gap-4 flex-wrap">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium text-muted-foreground">{t('proposeModal.raw.priorityLabel')}</span>
                    <div
                      role="radiogroup"
                      aria-label={t('proposeModal.raw.priorityLabel')}
                      data-testid="raw-priority-group"
                      className="inline-flex items-center gap-1 p-1 rounded-lg border border-border/50 bg-card/40"
                    >
                      {RAW_PRIORITY_ORDER.map((p) => (
                        <button
                          key={p}
                          type="button"
                          role="radio"
                          aria-checked={priority === p}
                          tabIndex={priority === p ? 0 : -1}
                          onClick={() => setPriority(p)}
                          onKeyDown={(e) => {
                            const i = RAW_PRIORITY_ORDER.indexOf(priority)
                            if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                              e.preventDefault()
                              setPriority(RAW_PRIORITY_ORDER[Math.min(i + 1, RAW_PRIORITY_ORDER.length - 1)])
                            } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                              e.preventDefault()
                              setPriority(RAW_PRIORITY_ORDER[Math.max(i - 1, 0)])
                            }
                          }}
                          className={`px-2 py-1 rounded-md text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-info/40 ${
                            priority === p ? RAW_PRIORITY_CLASS[p] : 'text-muted-foreground hover:text-foreground hover:bg-card/60'
                          }`}
                        >
                          {t(`proposeModal.priority.${p}`)}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="flex items-center gap-2 flex-1 min-w-[12rem]">
                    <span className="text-xs font-medium text-muted-foreground">{t('proposeModal.raw.labelsLabel')}</span>
                    <div className="flex-1 flex items-center flex-wrap gap-1 px-2 py-1 rounded-md border border-border/40 bg-card/40">
                      {labels.map((label) => (
                        <span
                          key={label}
                          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-accent-info/15 text-accent-info text-[10px] font-medium"
                        >
                          {label}
                          <button
                            type="button"
                            aria-label={t('proposeModal.raw.removeLabel', { label })}
                            onClick={() => setLabels((ls) => ls.filter((l) => l !== label))}
                            className="text-accent-info/60 hover:text-accent-info"
                          >
                            ×
                          </button>
                        </span>
                      ))}
                      <input
                        type="text"
                        aria-label={t('proposeModal.raw.addLabelAria')}
                        data-testid="raw-label-input"
                        placeholder={labels.length ? '' : t('proposeModal.raw.labelPlaceholder')}
                        className="flex-1 min-w-[4rem] bg-transparent text-xs text-foreground placeholder-muted-foreground/50 focus-visible:outline-none"
                        onKeyDown={(e) => {
                          const el = e.target as HTMLInputElement
                          const v = el.value.trim()
                          if (e.key === 'Enter' && v) {
                            e.preventDefault()
                            setLabels((ls) => (ls.includes(v) ? ls : [...ls, v]))
                            el.value = ''
                          } else if (e.key === 'Backspace' && !v && labels.length) {
                            setLabels((ls) => ls.slice(0, -1))
                          }
                        }}
                      />
                    </div>
                  </div>
                </div>
              </div>
            )}

            <p className="text-sm text-muted-foreground">
              {mode === 'quick'
                ? t('proposeModal.modeDescription.quick')
                : mode === 'explore'
                  ? t('proposeModal.modeDescription.explore')
                  : t('proposeModal.modeDescription.raw')}
            </p>
            <RichAttachmentEditor
              ref={editorRef}
              ticketKey={pendingSpecId}
              placeholder={mode === 'quick'
                ? t('proposeModal.editorPlaceholder.quick')
                : mode === 'explore'
                  ? t('proposeModal.editorPlaceholder.explore')
                  : t('proposeModal.editorPlaceholder.raw')}
              minHeight={mode === 'free' ? 220 : 160}
              autoFocus
              ariaLabel={mode === 'free' ? t('proposeModal.raw.bodyAriaLabel') : t('proposeModal.ideaAriaLabel')}
              onChange={() => {
                const text = editorRef.current?.getPlainText() ?? ''
                setHasText(text.trim().length > 0)
                // Raw mode: keep the title in sync with the first non-empty line
                // until the user takes over the field.
                if (mode === 'free' && !titleTouchedRef.current) {
                  const firstLine = text.split('\n').find((l) => l.trim().length > 0)?.trim().slice(0, 120) ?? ''
                  setTitle(firstLine)
                }
              }}
              onAttachmentAdded={() => setAttachmentCount((c) => c + 1)}
              onAttachmentRemoved={(a) => {
                setAttachmentCount((c) => Math.max(0, c - 1))
                fetch(`${API_ORIGIN}/api/projects/${activeProjectIdRef.current}/tickets/${pendingSpecId}/attachments/${a.id}`, { method: 'DELETE' }).catch(() => {})
              }}
              onUnsupportedFile={(f) => toast.error(t('proposeModal.toast.unsupportedFileType', { name: f.name }))}
              onUploadError={(err, f) => toast.error(t('proposeModal.toast.uploadFailed', { name: f.name, message: err.message }))}
              onSubmit={handleSubmit}
              footerExtra={mode !== 'free' && browserCaptureEnabled && activeProjectId ? (
                <button
                  type="button"
                  onClick={() => setBrowserOpen(true)}
                  data-testid="from-browser-btn"
                  title={t('proposeModal.fromWebsiteTitle')}
                  className="inline-flex items-center gap-1 px-2 py-1 rounded-md border border-accent-info/50 text-accent-info hover:bg-accent-info/10 transition-colors font-medium"
                >
                  <Globe className="w-3.5 h-3.5" />
                  <span>{t('proposeModal.fromWebsite')}</span>
                </button>
              ) : undefined}
            />
            {mode !== 'free' && captures.length > 0 && (
              <div className="space-y-3" data-testid="captured-dom-list">
                {captures.map((c) => (
                  <div key={c.domAttachmentId} className="space-y-1.5">
                    <div className="rounded-lg border border-accent-secondary/40 bg-accent-secondary/5 p-2 space-y-1.5">
                      {c.breakpoints ? (
                        <div className="space-y-1.5" data-testid="capture-breakpoints">
                          <div className="flex items-center gap-1 text-[10px] font-medium text-accent-highlight">
                            <Ratio className="w-3 h-3 shrink-0" />
                            {t('proposeModal.capture.responsiveSizes', { count: c.breakpoints.length })}
                          </div>
                          <div className="flex items-end justify-center gap-2 flex-wrap">
                            {c.breakpoints.map((b) => (
                              <div key={b.key} className="flex flex-col items-center gap-1">
                                <img
                                  src={b.dataUrl}
                                  alt={`${b.key} (${b.width}px)`}
                                  className="max-h-36 w-auto max-w-[10rem] object-contain rounded border border-border/60 bg-background-deep block"
                                />
                                <span className="text-[10px] text-muted-foreground tabular-nums">{b.key} · {b.width}px</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      ) : (
                        <img
                          src={c.screenshotDataUrl}
                          alt={c.screenshotName}
                          className="max-h-44 w-auto max-w-full object-contain rounded border border-border/60 bg-background-deep mx-auto block"
                        />
                      )}
                      {c.dom.url && c.dom.url !== 'about:blank' && (
                        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground" title={c.dom.url}>
                          <Globe className="w-3 h-3 shrink-0" />
                          <span className="truncate">{c.dom.url}</span>
                        </div>
                      )}
                    </div>
                    <CapturedDomPanel dom={c.dom} onRemove={() => removeCapture(c)} />
                  </div>
                ))}
              </div>
            )}
            {jira.connected && mode === 'quick' && (
              <div className="flex items-center justify-end text-[11px]" data-testid="jira-create-indicator">
                <span className="inline-flex items-center gap-1 text-accent-info">
                  <Plug className="w-3 h-3" />
                  {tj('addSpec.willCreate', { key: jira.jiraProjectKey ?? '' })}
                </span>
              </div>
            )}
            <div className="flex items-center justify-end">
              <Button
                size="sm"
                onClick={handleSubmit}
                disabled={!canSubmit}
                title={!canSubmit ? t('proposeModal.submit.disabledTitle') : undefined}
                className={`gap-1.5 ${mode === 'free' ? 'bg-accent-info text-white hover:bg-accent-info/90' : submitAccentForTier(tier)}`}
                data-testid="propose-submit"
              >
                {mode === 'free' ? <PenLine className="w-3.5 h-3.5" /> : <Send className="w-3.5 h-3.5" />}
                {mode === 'quick' ? t('proposeModal.submit.quick') : mode === 'explore' ? t('proposeModal.submit.explore') : t('proposeModal.submit.raw')}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {browserCaptureEnabled && browserOpen && activeProjectId && (
        <BrowserCaptureModal
          open={browserOpen}
          onClose={() => setBrowserOpen(false)}
          projectId={activeProjectId}
          pendingSpecId={pendingSpecId}
          onCaptured={handleCaptured}
        />
      )}
    </>
  )
}

function ModeSegmented({
  value,
  onChange,
  fullCodebase,
  quickAvailable,
}: {
  value: SpecMode
  onChange: (v: SpecMode) => void
  fullCodebase: boolean
  quickAvailable: boolean
}) {
  const { t } = useTranslation('addspec')
  const quickUnavailable = t('proposeModal.mode.quickUnavailable')
  return (
    <div role="tablist" aria-label={t('proposeModal.modeTablistLabel')} className="inline-flex items-center gap-1 p-1 rounded-lg border border-border/50 bg-card/40 self-start">
      <ModeOption
        active={value === 'quick'}
        icon={<Zap className="w-3.5 h-3.5" />}
        label={t('proposeModal.mode.quick')}
        hint={quickAvailable
          ? quickHintForScope({ specrails: false, openspec: false, full: fullCodebase, mcp: false, contractRefine: false })
          : quickUnavailable}
        onClick={() => onChange('quick')}
        disabled={!quickAvailable}
        disabledReason={quickUnavailable}
      />
      <ModeOption
        active={value === 'explore'}
        icon={<MessagesSquare className="w-3.5 h-3.5" />}
        label={t('proposeModal.mode.explore')}
        hint={t('proposeModal.mode.exploreHint')}
        onClick={() => onChange('explore')}
      />
      <ModeOption
        active={value === 'free'}
        icon={<PenLine className="w-3.5 h-3.5" />}
        label={t('proposeModal.mode.raw')}
        hint={t('proposeModal.mode.rawHint')}
        onClick={() => onChange('free')}
      />
    </div>
  )
}

function ModeOption({
  active,
  icon,
  label,
  hint,
  onClick,
  disabled = false,
  disabledReason,
}: {
  active: boolean
  icon: React.ReactNode
  label: string
  hint: string
  onClick: () => void
  disabled?: boolean
  disabledReason?: string
}) {
  return (
    <button
      role="tab"
      type="button"
      aria-selected={active}
      disabled={disabled}
      title={disabled ? disabledReason : hint}
      onClick={onClick}
      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
        disabled
          ? 'cursor-not-allowed text-muted-foreground/50 opacity-70'
          : active
            ? 'bg-primary/15 text-primary'
            : 'text-muted-foreground hover:text-foreground hover:bg-card/60'
      }`}
    >
      {icon}
      {label}
      <span className={`text-[10px] ${active ? 'text-primary/60' : 'text-muted-foreground/60'}`}>{hint}</span>
    </button>
  )
}
