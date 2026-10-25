import { modalOverlayStyle } from '../../../lib/modal-safe-area'
import { useState, useEffect, useCallback, useRef, useMemo, useId } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { formatDistanceToNow } from 'date-fns'
import { useTranslation } from 'react-i18next'
import { X, Pencil, Trash2, Save, Plus, XCircle, MessageSquare, ArrowRight, ArrowLeft, Columns2, ExternalLink, MoreHorizontal, Split, Download, FileText, FileCode, ClipboardCopy } from 'lucide-react'
import { useInRouterContext, useLocation, useNavigate } from 'react-router-dom'
import { openExternalUrl } from '../../../lib/tauri-shell'
import { toast } from 'sonner'
import { getDateFnsLocale } from '../../../lib/i18n'
import { Button } from '../../../components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../../../components/ui/dropdown-menu'
import { useRailPrDecisions } from '../../delivery/context/RailPrDecisionContext'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../../components/ui/select'
import { DIALOG_SCRIM_CLASS, DialogLayerProvider } from '../../../components/ui/dialog'
import { ConfirmDialog } from '../../../components/ui/confirm-dialog'
import { DIALOG_LAYER_CLASS } from '../../../lib/layers'
import { cn } from '../../../lib/utils'
import { AttachmentsSection } from '../../chat/components/AttachmentsSection'
import { TicketFilesTouched } from '../../code/components/code-explorer/TicketFilesTouched'
import { SpecAddendaSection } from './SpecAddendaSection'
import { SpecTimeline } from './SpecTimeline'
import { copyPrDescription, exportHandoff } from '../lib/spec-handoff-actions'
import type { TimelineTarget } from '../lib/spec-timeline'
import { useUiMode } from '../../../context/UiModeContext'
import { PLACE_PUSH_STATE } from '../../../lib/places'
import { useRegisterPaletteSurface } from '../../../lib/palette-bridge'
import { TicketSpendingLine } from '../../analytics/components/TicketSpendingLine'
import { TicketStatusBadge } from './TicketStatusIndicator'
import { useMinimizedChats } from '../../missions/context/MinimizedChatsContext'
import { useTicketDetailModal } from '../context/TicketDetailModalContext'
import { useJiraConnection } from '../../integrations/hooks/useJiraConnection'
import { jiraApi } from '../../integrations/lib/jira-api'
import { MANUAL_STATUS_TARGETS, STATUS_LABEL_KEY, moveJiraSpecToStatus } from '../lib/ticket-status-moves'
import { DiscardSpecDialog } from '../../integrations/components/jira/DiscardSpecDialog'
import { JiraSpecDetailsPanel } from '../../integrations/components/jira/JiraSpecDetailsPanel'
import { parseAcceptanceCriteria } from './explore-spec/acceptance-criteria'
import { canRefineTicket } from '../lib/ticket-refine'
import { genPendingSpecId } from '../lib/pending-spec-id'
import { useWebViewModal } from '../../browser/context/WebViewModalContext'
import { useDesktop } from '../../../hooks/useDesktop'
import { RepositoryScopeSelector } from '../../projects/components/RepositoryScopeSelector'
import { RegressionOfPicker, isBugTicket } from './RegressionOfPicker'
import { NonGoalsSection } from './NonGoalsSection'
import { SmashActions } from './specs-smash/SmashActions'
import { EpicBreadcrumb } from './specs-smash/EpicChildrenSection'
import { EpicFamilySidebar } from './specs-smash/EpicFamilySidebar'
import { MoveToRailPopover } from '../../rails/components/MoveToRailPopover'
import { useSpecExtensions } from '../context/SpecExtensionsContext'
import { isSmashCapable } from '../../providers/lib/provider-capabilities'
import type { RailState } from '../../rails/components/RailsBoard'
import type { Attachment, LocalTicket, TicketPriority, TicketStatus } from '../../../types'
import { MODAL_FLOAT_VIEWPORT_MIN } from '../../../lib/viewport'
import { useMovableResizableModal } from '../../../hooks/useMovableResizableModal'
import { ResizeGrips } from '../../../components/ui/ResizeGrips'

import { notifyError } from '../../../lib/notify-error'
const COMPARE_VIEWPORT_MIN = MODAL_FLOAT_VIEWPORT_MIN
const DRAG_SNAP_THRESHOLD = 0.20 // 20% of viewport width

// ─── Constants ──────────────────────────────────────────────────────────────

const PRIORITY_OPTIONS: { value: TicketPriority; labelKey: string; className: string }[] = [
  { value: 'critical', labelKey: 'priority.critical', className: 'text-destructive' },
  { value: 'high', labelKey: 'priority.high', className: 'text-accent-warning' },
  { value: 'medium', labelKey: 'priority.medium', className: 'text-accent-highlight' },
  { value: 'low', labelKey: 'priority.low', className: 'text-muted-foreground' },
]

/** Browser URL of a spec's parent Jira epic, derived from the issue's jira_url. */
function epicUrl(ticket: LocalTicket): string | null {
  if (!ticket.jira_epic_key) return null
  if (ticket.jira_url) return ticket.jira_url.replace(/\/browse\/[^/]+$/, `/browse/${ticket.jira_epic_key}`)
  return null
}

const SOURCE_LABEL_KEYS: Record<string, string> = {
  manual: 'source.manual',
  'product-backlog': 'source.productBacklog',
  'propose-spec': 'source.proposeSpec',
  'get-backlog-specs': 'source.getBacklogSpecs',
  'free-prompt': 'source.freePrompt',
}

// ─── Props ──────────────────────────────────────────────────────────────────

interface TicketDetailModalProps {
  ticket: LocalTicket
  allLabels: string[]
  /** All tickets in current project — used to resolve épica children / parent. */
  allTickets?: LocalTicket[]
  onClose: () => void
  /** Navigation hook: open a different ticket inside the same modal stack. */
  onOpenTicket?: (ticketId: number) => void
  onSave: (ticketId: number, fields: Partial<Pick<LocalTicket, 'title' | 'description' | 'status' | 'priority' | 'labels' | 'repositoryIds' | 'nonGoals'>> & { metadata?: { regressionOf?: string | null } }) => Promise<boolean>
  onDelete: (ticketId: number) => Promise<boolean>
  /** Rails available in the project — drives the Move-to-Rail popover. */
  rails?: RailState[]
  /** Move-to-Rail handler — same path as the dashboard postit card. */
  onMoveToRail?: (ticketId: number, railId: string) => void
  /** Reverse of `onMoveToRail`: return the ticket to the specs list. */
  onRemoveFromRail?: (ticketId: number) => void
  /**
   * When true the modal renders as a panel without the centered backdrop
   * wrapper (used by `SplitViewShell` to compose two modals side-by-side).
   * Disables the drag-to-snap entry gesture and hides the "Compare" button.
   */
  embedded?: boolean
}

// ─── Component ──────────────────────────────────────────────────────────────

export function TicketDetailModal({
  ticket,
  allLabels,
  allTickets,
  onClose,
  onOpenTicket,
  onSave,
  onDelete,
  rails,
  onMoveToRail,
  onRemoveFromRail,
  embedded = false,
}: TicketDetailModalProps) {
  const { t } = useTranslation('tickets')
  const { t: tj } = useTranslation('jira')
  const { t: tAct } = useTranslation('activity')
  // Another way to work on the spec next to Move to Rail (Flow), from the composition root.
  const { StartAlternative } = useSpecExtensions()
  const { activeProjectId, projects } = useDesktop()
  const { enterSplit, state: splitState } = useTicketDetailModal()
  const inSplit = splitState.originSide !== null
  // ⌘K: "Export hand-off for #N" / "Copy PR description for #N" run the very handlers the Export menu calls.
  const { t: tTimeline } = useTranslation('tickets')
  useRegisterPaletteSurface('handoff', {
    ticketId: () => ticket.id,
    exportHandoff: (id) => { void exportHandoff(id, 'md', tTimeline) },
    copyPrDescription: (id) => { void copyPrDescription(id, tTimeline) },
  })
  // Feature flag for SMASH. Server gates with `SPECRAILS_SMASH=0` returning
  // 409 from endpoints; the UI optimistically shows the affordance and lets
  // the server reject if disabled.
  //
  // SMASH's pipeline depends on Claude-specific structured actions and
  // multi-agent fan-out. Hide the affordance for every provider that cannot
  // honour that contract (including Kimi), with an unknown provider failing
  // closed while project context is loading.
  const activeProvider = projects.find((p) => p.id === activeProjectId)?.provider
  const smashFlagOn = isSmashCapable(activeProvider)
  const [tab, setTab] = useState<'details' | 'timeline'>('details')
  useEffect(() => { setTab('details') }, [ticket.id])
  const [statusPrimaryShown, setStatusPrimaryShown] = useState(false)
  const [smashAvailable, setSmashAvailable] = useState(false)
  const [smashOpenRequest, setSmashOpenRequest] = useState(0)
  const childrenList = useMemo(
    () => (allTickets ?? []).filter((t) => t.parent_epic_id === ticket.id),
    [allTickets, ticket.id],
  )
  const epicParent = useMemo(() => {
    if (ticket.parent_epic_id == null) return null
    return (allTickets ?? []).find((t) => t.id === ticket.parent_epic_id) ?? null
  }, [allTickets, ticket.parent_epic_id])
  const totalEpicSiblings = useMemo(() => {
    if (!epicParent) return 0
    return (allTickets ?? []).filter((t) => t.parent_epic_id === epicParent.id).length
  }, [allTickets, epicParent])
  // Editable state
  const [title, setTitle] = useState(ticket.title)
  const [description, setDescription] = useState(ticket.description)
  const [priority, setPriority] = useState<TicketPriority>(ticket.priority ?? 'medium')
  const [labels, setLabels] = useState<string[]>([...(ticket.labels ?? [])])
  const [repositoryIds, setRepositoryIds] = useState(ticket.repositoryIds)
  const [regressionOf, setRegressionOf] = useState<string | null>(ticket.metadata?.regressionOf ?? null)
  const [nonGoals, setNonGoals] = useState<string[]>([...(ticket.nonGoals ?? [])])

  // Edit mode toggles
  const [editingTitle, setEditingTitle] = useState(false)
  const [editingDescription, setEditingDescription] = useState(false)
  const [labelInput, setLabelInput] = useState('')
  const [showLabelInput, setShowLabelInput] = useState(false)

  // Confirmation dialog
  const [showDiscard, setShowDiscard] = useState(false)
  const [showJiraSaveConfirm, setShowJiraSaveConfirm] = useState(false)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)

  // In a Jira-synced project, a Jira-backed spec is "moved to" the configured
  // discard status instead of being deleted. Otherwise the button stays Delete.
  const jira = useJiraConnection()
  const canDiscard =
    jira.connected && !!jira.discardStatus && ticket.source === 'jira' && !!ticket.jira_key
  // Saving a Jira-backed spec writes the edits back to the Jira issue — require
  // an explicit confirmation so Save never silently mutates the Jira ticket.
  const isJiraBacked = jira.connected && ticket.source === 'jira' && !!ticket.jira_key

  // Attachments (synced from ticket prop)
  const [attachments, setAttachments] = useState<Attachment[]>(ticket.attachments ?? [])
  useEffect(() => { setAttachments(ticket.attachments ?? []) }, [ticket.attachments, ticket.id])

  // ── Status selector (manual transitions from the detail view) ──────────────
  const [statusMoving, setStatusMoving] = useState(false)
  // Jira-backed specs: lazily fetch the board's REAL workflow statuses once.
  const [jiraStatuses, setJiraStatuses] = useState<{ name: string }[] | null>(null)
  useEffect(() => {
    if (!isJiraBacked) return
    let alive = true
    jiraApi.listStatuses()
      .then((r) => { if (alive) setJiraStatuses(r.statuses) })
      .catch(() => { if (alive) setJiraStatuses([]) })
    return () => { alive = false }
  }, [isJiraBacked, ticket.id])
  const jiraStatusValue = ticket.jira_status ?? ''

  const handleLocalStatusMove = async (next: TicketStatus): Promise<void> => {
    if (next === ticket.status) return
    setStatusMoving(true)
    try {
      await onSave(ticket.id, { status: next })
    } finally {
      setStatusMoving(false)
    }
  }

  const handleJiraStatusMove = async (next: string): Promise<void> => {
    if (!next || next === jiraStatusValue) return
    setStatusMoving(true)
    try {
      await moveJiraSpecToStatus(ticket.id, next, tj)
    } finally {
      setStatusMoving(false)
    }
  }

  const titleInputRef = useRef<HTMLInputElement>(null)
  const descTextareaRef = useRef<HTMLTextAreaElement>(null)
  const labelInputRef = useRef<HTMLInputElement>(null)

  // Track if anything changed
  const isDirty = useMemo(() => {
    return (
      title !== ticket.title ||
      description !== ticket.description ||
      priority !== ticket.priority ||
      JSON.stringify(labels) !== JSON.stringify(ticket.labels) ||
      JSON.stringify(repositoryIds) !== JSON.stringify(ticket.repositoryIds) ||
      regressionOf !== (ticket.metadata?.regressionOf ?? null) ||
      JSON.stringify(nonGoals) !== JSON.stringify(ticket.nonGoals ?? [])
    )
  }, [title, description, priority, labels, repositoryIds, regressionOf, nonGoals, ticket])

  // Focus on edit start
  useEffect(() => {
    if (editingTitle) titleInputRef.current?.focus()
  }, [editingTitle])

  useEffect(() => {
    if (editingDescription) {
      const el = descTextareaRef.current
      if (el) {
        el.focus()
        el.selectionStart = el.value.length
      }
    }
  }, [editingDescription])

  useEffect(() => {
    if (showLabelInput) labelInputRef.current?.focus()
  }, [showLabelInput])

  // Escape (Radix): close the spec unless an inline editor or the Move-to-rail
  // popover owns it. Nested dialogs (confirms, SMASH, Selects) are their own
  // Radix layers, so Escape only ever closes the top one.
  const handleEscapeKeyDown = useCallback((e: KeyboardEvent) => {
    const target = e.target instanceof HTMLElement ? e.target : null
    if (
      editingTitle
      || editingDescription
      || target?.closest('input, textarea, select, [contenteditable="true"]')
      || document.querySelector('[data-testid="move-to-rail-popover"]')
    ) {
      e.preventDefault()
    }
  }, [editingTitle, editingDescription])

  // Label autocomplete suggestions
  const labelSuggestions = useMemo(() => {
    if (!labelInput.trim()) return []
    const q = labelInput.toLowerCase()
    return allLabels.filter(
      (l) => l.toLowerCase().includes(q) && !labels.includes(l)
    ).slice(0, 5)
  }, [labelInput, allLabels, labels])

  const addLabel = useCallback((label: string) => {
    const trimmed = label.trim()
    if (trimmed && !labels.includes(trimmed)) {
      setLabels((prev) => [...prev, trimmed])
    }
    setLabelInput('')
  }, [labels])

  const removeLabel = useCallback((label: string) => {
    setLabels((prev) => prev.filter((l) => l !== label))
  }, [])

  const handleSave = useCallback(async () => {
    const changes: Partial<Pick<LocalTicket, 'title' | 'description' | 'priority' | 'labels' | 'repositoryIds' | 'nonGoals'>> & { metadata?: { regressionOf: string | null } } = {}
    if (title !== ticket.title) changes.title = title
    if (description !== ticket.description) changes.description = description
    if (priority !== ticket.priority) changes.priority = priority
    if (JSON.stringify(labels) !== JSON.stringify(ticket.labels)) changes.labels = labels
    if (JSON.stringify(repositoryIds) !== JSON.stringify(ticket.repositoryIds)) changes.repositoryIds = repositoryIds
    if (regressionOf !== (ticket.metadata?.regressionOf ?? null)) changes.metadata = { regressionOf }
    if (JSON.stringify(nonGoals) !== JSON.stringify(ticket.nonGoals ?? [])) changes.nonGoals = nonGoals

    if (Object.keys(changes).length === 0) {
      onClose()
      return
    }

    setSaving(true)
    const ok = await onSave(ticket.id, changes)
    setSaving(false)

    if (ok) {
      toast.success(t('detailModal.toast.updated'))
      onClose()
    } else {
      notifyError(t('detailModal.toast.updateFailed'))
    }
  }, [title, description, priority, labels, repositoryIds, regressionOf, nonGoals, ticket, onSave, onClose, t])

  const handleDelete = useCallback(async () => {
    if (deleting) return
    setDeleting(true)
    let ok = false
    try {
      ok = await onDelete(ticket.id)
    } catch {
      ok = false
    }
    setDeleting(false)
    if (!ok) {
      notifyError(t('detailModal.toast.deleteFailed'))
      return
    }
    onClose()
  }, [deleting, ticket.id, onDelete, onClose, t])

  // ─── Drag-to-snap (entry to split-view) ────────────────────────────────────
  const [dragOffset, setDragOffset] = useState(0)
  const dragRef = useRef<{ startX: number; pointerId: number } | null>(null)
  const [compareViewportEligible, setCompareViewportEligible] = useState(
    () => typeof window !== 'undefined' && window.innerWidth >= COMPARE_VIEWPORT_MIN,
  )
  useEffect(() => {
    if (typeof window === 'undefined') return
    const updateEligibility = () => setCompareViewportEligible(window.innerWidth >= COMPARE_VIEWPORT_MIN)
    updateEligibility()
    window.addEventListener('resize', updateEligibility)
    return () => window.removeEventListener('resize', updateEligibility)
  }, [])
  const canDrag = !embedded && !inSplit && compareViewportEligible

  const handleDragMove = useCallback((e: PointerEvent) => {
    if (!dragRef.current) return
    setDragOffset(e.clientX - dragRef.current.startX)
  }, [])

  const handleDragUp = useCallback((e: PointerEvent) => {
    if (!dragRef.current) return
    const delta = e.clientX - dragRef.current.startX
    const threshold = window.innerWidth * DRAG_SNAP_THRESHOLD
    window.removeEventListener('pointermove', handleDragMove)
    window.removeEventListener('pointerup', handleDragUp)
    window.removeEventListener('pointercancel', handleDragUp)
    dragRef.current = null
    setDragOffset(0)
    if (Math.abs(delta) >= threshold && window.innerWidth >= COMPARE_VIEWPORT_MIN) {
      // If this modal instance is rendered by a third-party site (e.g.
      // DashboardPage's local state) the provider's leftId is not ours;
      // pass ticket.id so the reducer can bootstrap, then call onClose to
      // dismiss the third-party modal so only the provider's split shell
      // remains visible. For the provider's own modal (leftId === ticket.id)
      // we skip onClose because that handler would call closeAll and undo
      // the enterSplit we just dispatched.
      const isProviderModal = splitState.leftId === ticket.id
      enterSplit(delta < 0 ? 'left' : 'right', ticket.id)
      if (!isProviderModal) onClose()
    }
  }, [enterSplit, handleDragMove, splitState.leftId, ticket.id, onClose])

  const handleDragDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!canDrag) return
      // Only react to primary pointer; ignore right-clicks
      if (e.button !== 0) return
      // Don't start drag if clicking on inputs/buttons inside the header
      const target = e.target as HTMLElement
      if (target.closest('button, input, textarea, select, [contenteditable="true"]')) return
      dragRef.current = { startX: e.clientX, pointerId: e.pointerId }
      window.addEventListener('pointermove', handleDragMove)
      window.addEventListener('pointerup', handleDragUp)
      window.addEventListener('pointercancel', handleDragUp)
    },
    [canDrag, handleDragMove, handleDragUp],
  )

  // Clean up listeners if component unmounts mid-drag
  useEffect(() => {
    return () => {
      if (dragRef.current) {
        window.removeEventListener('pointermove', handleDragMove)
        window.removeEventListener('pointerup', handleDragUp)
        window.removeEventListener('pointercancel', handleDragUp)
      }
    }
  }, [handleDragMove, handleDragUp])

  const handleCompareClick = useCallback(() => {
    if (!canDrag || window.innerWidth < COMPARE_VIEWPORT_MIN) return
    const isProviderModal = splitState.leftId === ticket.id
    enterSplit('right', ticket.id)
    if (!isProviderModal) onClose()
  }, [canDrag, enterSplit, splitState.leftId, ticket.id, onClose])

  // ─── Resize-only floating (header stays the split gesture) ──────────────────
  // Unique per instance: the split view renders two of these side by side.
  const titleId = `ticket-detail-title-${useId()}`
  const { panelRef, panelStyle, resizeHandles, guardBackdrop } = useMovableResizableModal({
    enabled: !embedded,
    allowMove: false,
    persistKey: 'specrails.modal.spec-detail',
  })

  // Terminal specs (done/cancelled) are finished work: no Move to rail / Flow.
  const isTerminal = ticket.status === 'done' || ticket.status === 'cancelled'
  // Compare needs a second spec to compare against (unknown list ⇒ keep it).
  const hasComparable = allTickets === undefined || allTickets.some((t) => t.id !== ticket.id)

  // Focus return: the board card that opened the modal often re-renders while
  // it is open; remember its identity so focus lands on its live replacement.
  const [returnTarget] = useState(() => {
    if (embedded || typeof document === 'undefined') return null
    const el = document.activeElement
    if (!(el instanceof HTMLElement) || el === document.body) return null
    const testId = el.getAttribute('data-testid')
    const selector = el.id ? `#${CSS.escape(el.id)}` : testId ? `[data-testid="${CSS.escape(testId)}"]` : null
    return { el, selector }
  })
  const handleCloseAutoFocus = useCallback((e: Event) => {
    // Radix only refocuses a `DialogTrigger`; this modal is opened from cards,
    // chips and menus, so return focus to whatever opened it.
    e.preventDefault()
    if (!returnTarget) return
    const next = returnTarget.el.isConnected
      ? returnTarget.el
      : returnTarget.selector ? document.querySelector<HTMLElement>(returnTarget.selector) : null
    next?.focus()
  }, [returnTarget])

  // ─── Layout helpers ────────────────────────────────────────────────────────
  // Spec detail keeps its own workspace geometry (wider than the `workspace`
  // size token, 90vh tall): it is an entity page with a metadata rail, and its
  // header doubles as the drag-to-split gesture, so it is built on the raw
  // Radix primitives instead of `DialogContent`.
  const panelClassName = embedded
    ? 'relative w-full h-full rounded-panel bg-popover border border-border/40 shadow-3 flex flex-col overflow-hidden'
    : 'modal-enter relative w-full max-w-[67rem] m-4 rounded-panel bg-popover border border-border/40 shadow-3 flex flex-col h-[90vh] max-h-[calc(100%-2rem)] outline-none'
  const panelInlineStyle: React.CSSProperties = {
    ...(dragOffset !== 0
      ? { transform: `translateX(${dragOffset}px)`, transition: 'none' }
      : { transition: 'transform 220ms cubic-bezier(0.22, 1, 0.36, 1)' }),
    ...panelStyle,
  }
  const statusLabel = t(STATUS_LABEL_KEY[ticket.status], { ns: 'tickets' })
  const titleHeading = (
    // No `id` key when standalone: Radix's Title (asChild) supplies the id.
    <h2 {...(embedded ? { id: titleId } : {})} className="text-headline text-foreground line-clamp-2 break-words">{title || t('untitled')}</h2>
  )
  const panelContent = (
    <>
        {/* Épica breadcrumb (children only) */}
        {epicParent && (
          <div className="px-5 pt-3">
            <EpicBreadcrumb
              epic={epicParent}
              childExecutionOrder={ticket.execution_order ?? null}
              totalChildren={totalEpicSiblings}
              onOpenEpic={() => onOpenTicket?.(epicParent.id)}
            />
          </div>
        )}
        {/* Header */}
        <div
          className={`flex items-start justify-between gap-3 px-5 py-4 border-b border-border/30 ${canDrag ? 'cursor-grab active:cursor-grabbing' : ''}`}
          onPointerDown={handleDragDown}
          data-testid="ticket-modal-header"
        >
          <div className="flex-1 min-w-0">
            {editingTitle ? (
              <input
                ref={titleInputRef}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onBlur={() => setEditingTitle(false)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') setEditingTitle(false)
                  if (e.key === 'Escape') { setTitle(ticket.title); setEditingTitle(false) }
                }}
                className="w-full bg-transparent border-b border-accent-primary/50 text-title text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring pb-0.5"
              />
            ) : (
              <button
                type="button"
                onClick={() => setEditingTitle(true)}
                className="group flex items-center gap-1.5 text-left w-full"
              >
                {embedded ? titleHeading : <DialogPrimitive.Title asChild>{titleHeading}</DialogPrimitive.Title>}
                <Pencil className="w-3 h-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
              </button>
            )}
            <div className="flex items-center gap-2 mt-1.5">
              <span className="text-xs text-foreground font-mono">#{ticket.id}</span>
              {/* Work delivered as a draft PR — awaiting the human review decision. */}
              {ticket.status === 'on_review' && (
                <span title={t('specs:status.onReviewHint')} data-testid="ticket-modal-on-review-badge">
                  <TicketStatusBadge status="on_review" />
                <span className="sr-only"> ({t('specs:status.onReviewHint')})</span></span>
              )}
            </div>
            {/* Plain-language gloss for the "~$x · ≥N turns · 1 quick + 3 loops" line. */}
            <div title={t('detailModal.spendingLineHint')} data-testid="ticket-spending-line">
              <TicketSpendingLine ticketId={ticket.id} />
            </div>
          </div>

          {/* A Done spec is finished work — SMASHing it into Sub-Specs makes no sense. */}
          {activeProjectId && ticket.status !== 'done' && (
            <div className="shrink-0">
              <SmashActions
                ticket={ticket}
                projectId={activeProjectId}
                provider={activeProvider}
                featureFlagOn={smashFlagOn}
                childrenCount={childrenList.length}
                hideButton
                openRequest={smashOpenRequest}
                onAvailableChange={setSmashAvailable}
              />
            </div>
          )}

          <ContinueEditingButton ticket={ticket} title={title} description={description} priority={priority} labels={labels} repositoryIds={repositoryIds} onClose={onClose} />

          {!isTerminal && (ticket.status === 'on_review' || ticket.status === 'in_progress') && (
            <StatusPrimaryAction ticket={ticket} rails={rails} onClose={onClose} onShownChange={setStatusPrimaryShown} />
          )}

          {rails && (onMoveToRail || onRemoveFromRail) && (
            <RailAssignmentButton
              ticket={ticket}
              rails={rails}
              onMoveToRail={isTerminal ? undefined : onMoveToRail}
              onRemoveFromRail={onRemoveFromRail}
              secondary={statusPrimaryShown}
            />
          )}

          {/* Flow and Implement (Move to Rail) are two equal ways to work on a spec. */}
          {rails && onMoveToRail && StartAlternative && !isTerminal && (
            <StartAlternative
              variant="button"
              className="shrink-0 mr-1"
              spec={ticket}
              rail={(() => { const rail = rails.find((r) => r.ticketIds.includes(ticket.id)); return rail ? { running: rail.status === 'running' } : null })()}
            />
          )}

          {((activeProjectId && ticket.status !== 'done' && smashAvailable) || (canDrag && hasComparable)) && (
            <DropdownMenu>
              <DropdownMenuTrigger
                aria-label={t('detailModal.moreActions')}
                title={t('detailModal.moreActions')}
                data-testid="ticket-modal-more"
                className="h-7 w-7 mr-1 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-surface/50 transition-colors cursor-pointer shrink-0"
              >
                <MoreHorizontal className="w-4 h-4" aria-hidden />
              </DropdownMenuTrigger>
              <DropdownMenuContent className={DIALOG_LAYER_CLASS.stacked}>
                {activeProjectId && ticket.status !== 'done' && smashAvailable && (
                  <DropdownMenuItem
                    data-testid="ticket-modal-smash"
                    onSelect={() => setSmashOpenRequest((n) => n + 1)}
                  >
                    <Split className="w-3.5 h-3.5" aria-hidden />
                    {ticket.is_epic ? tAct('smash.reSmashButton') : tAct('smash.smashButton')}
                  </DropdownMenuItem>
                )}
                {canDrag && hasComparable && (
                  <DropdownMenuItem
                    data-testid="ticket-modal-compare"
                    onSelect={handleCompareClick}
                    title={t('detailModal.compareTooltip')}
                  >
                    <Columns2 className="w-3.5 h-3.5" aria-hidden />
                    {t('detailModal.compare')}
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          <button
            type="button"
            onClick={onClose}
            aria-label={t('common:actions.close')}
            className="h-7 w-7 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-surface/50 transition-colors cursor-pointer shrink-0"
            data-testid="ticket-modal-close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Sections: a tab inside the modal is not a place (no history entry). */}
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/30 px-5" data-testid="ticket-modal-tabs">
          <div role="tablist" aria-label={t('timeline.tabs.aria')} className="flex items-center gap-1">
            {(['details', 'timeline'] as const).map((id) => (
              <button
                key={id}
                type="button"
                role="tab"
                id={`ticket-tab-${id}`}
                aria-selected={tab === id}
                aria-controls={`ticket-panel-${id}`}
                tabIndex={tab === id ? 0 : -1}
                data-testid={`ticket-tab-${id}`}
                onClick={() => setTab(id)}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); setTab(id === 'details' ? 'timeline' : 'details') }
                }}
                className={cn(
                  '-mb-px border-b-2 px-2.5 py-2 text-label transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  tab === id ? 'border-accent-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
                )}
              >
                {t(`timeline.tabs.${id}`)}
              </button>
            ))}
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger
              data-testid="ticket-export-menu"
              className="my-1 inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-label text-muted-foreground transition-colors hover:bg-surface/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer"
            >
              <Download className="h-3.5 w-3.5" aria-hidden />
              {t('timeline.export.menu')}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className={DIALOG_LAYER_CLASS.stacked}>
              <DropdownMenuItem data-testid="ticket-export-md" onSelect={() => { void exportHandoff(ticket.id, 'md', t) }}>
                <FileText className="h-3.5 w-3.5" aria-hidden />{t('timeline.export.markdown')}
              </DropdownMenuItem>
              <DropdownMenuItem data-testid="ticket-export-html" onSelect={() => { void exportHandoff(ticket.id, 'html', t) }}>
                <FileCode className="h-3.5 w-3.5" aria-hidden />{t('timeline.export.html')}
              </DropdownMenuItem>
              <DropdownMenuItem data-testid="ticket-copy-pr" onSelect={() => { void copyPrDescription(ticket.id, t) }}>
                <ClipboardCopy className="h-3.5 w-3.5" aria-hidden />{t('timeline.export.copyPr')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* Body */}
        {tab === 'timeline' ? (
          <div className="flex-1 overflow-y-auto min-h-0 px-5 py-4" role="tabpanel" id="ticket-panel-timeline" aria-labelledby="ticket-tab-timeline">
            <TimelineHost ticketId={ticket.id} refreshKey={ticket.updated_at} onClose={onClose} />
          </div>
        ) : (
        <div className="flex-1 overflow-y-auto min-h-0" role="tabpanel" id="ticket-panel-details" aria-labelledby="ticket-tab-details">
          <div className="flex flex-col sm:flex-row h-full">
            {/* Main content */}
            <div className="flex-1 min-w-0 px-5 py-4 space-y-4 flex flex-col">
              {/* AI Edit overlay renders fullscreen above this modal — see end of component. */}

              <div className="flex-1 flex flex-col">
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-label text-muted-foreground flex items-center gap-1.5">
                    {t('fields.description')}
                  </span>
                  {!editingDescription && (
                    <button
                      type="button"
                      onClick={() => setEditingDescription(true)}
                      className="text-xs text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1"
                    >
                      <Pencil className="w-2.5 h-2.5" />
                      {t('common:actions.edit')}
                    </button>
                  )}
                </div>

                {editingDescription ? (
                  <div className="space-y-1.5 flex-1 flex flex-col">
                    <textarea
                      ref={descTextareaRef}
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      className="w-full flex-1 rounded-lg border border-border bg-input px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground resize-none min-h-[300px]"
                      placeholder={t('fields.markdownPlaceholder')}
                    />
                    <div className="flex items-center gap-1.5">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 text-xs"
                        onClick={() => setEditingDescription(false)}
                      >
                        {t('detailModal.doneEditing')}
                      </Button>
                      <span className="text-xs text-muted-foreground">{t('fields.supportsMarkdown')}</span>
                    </div>
                  </div>
                ) : description ? (
                  <DescriptionRender
                    description={description}
                    onEdit={() => setEditingDescription(true)}
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => setEditingDescription(true)}
                    className="w-full rounded-lg border border-dashed border-border/40 bg-muted/10 px-3 py-4 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/20 transition-colors text-center"
                  >
                    {t('detailModal.addDescription')}
                  </button>
                )}
              </div>

              {/* Non-goals — "Out of scope" under the description (feedback-2026-10 3.2) */}
              <NonGoalsSection value={nonGoals} onChange={setNonGoals} disabled={saving} />

              {/* Spec addenda — iterate without editing the description (spec-addenda) */}
              <SpecAddendaSection ticket={ticket} />

              {/* Attachments / Resources */}
              <AttachmentsSection
                ticketKey={ticket.id}
                attachments={attachments}
                onChange={setAttachments}
              />

              {/* Files touched by AI rails (code-explorer feature) */}
              <TicketFilesTouched ticketId={ticket.id} onClose={onClose} />

              {/* Prerequisites */}
              {ticket.prerequisites && ticket.prerequisites.length > 0 && (
                <div>
                  <span className="text-label text-muted-foreground block mb-1.5">
                    {t('detailModal.prerequisites')}
                  </span>
                  <div className="flex flex-wrap gap-1">
                    {ticket.prerequisites.map((id) => (
                      <span
                        key={id}
                        data-chip=""
                        className="inline-flex h-5 items-center rounded px-1.5 text-caption font-mono bg-accent/60 text-foreground/70"
                      >
                        #{id}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Sidebar */}
            <div className="sm:w-56 sm:border-l border-t sm:border-t-0 border-border/30 px-4 py-4 space-y-4 bg-muted/5">
              {/* Go to Jira ticket — only when the spec is Jira-backed */}
              {ticket.jira_url && ticket.jira_key && (
                <button
                  type="button"
                  onClick={() => { void openExternalUrl(ticket.jira_url!) }}
                  data-testid="jira-go-to-ticket"
                  className="w-full inline-flex items-center justify-center gap-1.5 h-7 rounded border border-accent-info/50 bg-accent-info/10 px-2 text-label text-accent-info hover:bg-accent-info/20 transition-colors"
                >
                  <ExternalLink className="w-3.5 h-3.5 shrink-0" />
                  {tj('detail.goToTicket', { key: ticket.jira_key })}
                </button>
              )}
              {/* Parent Jira epic — only when the issue has one */}
              {ticket.jira_epic_key && (
                <div data-testid="jira-epic">
                  <span className="text-label text-muted-foreground block mb-1.5">
                    {tj('detail.epic')}
                  </span>
                  <button
                    type="button"
                    onClick={() => { const u = epicUrl(ticket); if (u) void openExternalUrl(u) }}
                    title={ticket.jira_epic_name ?? ticket.jira_epic_key}
                    className="w-full inline-flex items-center gap-1.5 rounded border border-accent-highlight/40 bg-accent-highlight/5 px-2 py-1.5 text-left text-xs hover:bg-accent-highlight/10 transition-colors"
                  >
                    <span className="font-mono text-accent-highlight shrink-0">{ticket.jira_epic_key}</span>
                    {ticket.jira_epic_name && <span className="truncate text-foreground/80">{ticket.jira_epic_name}</span>}
                  </button>
                </div>
              )}
              {/* Status selector — manual transitions from the detail view.
                  Jira-backed specs offer the board's REAL workflow statuses
                  (transition rides the outbox); local specs offer the manual
                  targets (never INTO on_review/draft — pipeline-owned). */}
              <div>
                <span className="text-label text-muted-foreground block mb-1.5">
                  {t('fields.status')}
                </span>
                {isJiraBacked ? (
                  <Select
                    value={jiraStatusValue || undefined}
                    disabled={statusMoving || jiraStatuses === null}
                    onValueChange={(v) => { void handleJiraStatusMove(v) }}
                  >
                    <SelectTrigger
                      className="h-7 w-full text-xs"
                      aria-label={t('fields.status')}
                      data-testid="ticket-jira-status-select"
                    >
                      <SelectValue placeholder={t('states.loading', { ns: 'common' })} />
                    </SelectTrigger>
                    <SelectContent>
                      {jiraStatusValue && !(jiraStatuses ?? []).some((s) => s.name === jiraStatusValue) && (
                        <SelectItem value={jiraStatusValue} className="text-xs">{jiraStatusValue}</SelectItem>
                      )}
                      {(jiraStatuses ?? []).map((s) => (
                        <SelectItem key={s.name} value={s.name} className="text-xs">{s.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Select
                    value={ticket.status}
                    disabled={statusMoving}
                    onValueChange={(v) => { void handleLocalStatusMove(v as TicketStatus) }}
                  >
                    <SelectTrigger
                      className="h-7 w-full text-xs"
                      aria-label={t('fields.status')}
                      data-testid="ticket-status-select"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {/* Current status always listed (even draft/on_review) so the
                          trigger renders truthfully; manual targets exclude the
                          pipeline-owned states. */}
                      {!MANUAL_STATUS_TARGETS.includes(ticket.status) && (
                        <SelectItem value={ticket.status} className="text-xs">{t(STATUS_LABEL_KEY[ticket.status], { ns: 'tickets' })}</SelectItem>
                      )}
                      {MANUAL_STATUS_TARGETS.map((s) => (
                        <SelectItem key={s} value={s} className="text-xs">{t(STATUS_LABEL_KEY[s], { ns: 'tickets' })}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>

              {/* Priority selector */}
              <div>
                <span className="text-label text-muted-foreground block mb-1.5">
                  {t('fields.priority')}
                </span>
                <Select value={priority} onValueChange={(v) => setPriority(v as TicketPriority)}>
                  <SelectTrigger
                    className="h-7 w-full text-xs"
                    aria-label={t('fields.priority')}
                    data-testid="ticket-priority-select"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PRIORITY_OPTIONS.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value} className="text-xs">{t(opt.labelKey)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <RepositoryScopeSelector value={repositoryIds} onChange={setRepositoryIds} disabled={saving} />

              {/* Labels */}
              <div>
                <span className="text-label text-muted-foreground block mb-1.5">
                  {t('fields.labels')}
                </span>
                <div className="flex flex-wrap gap-1 mb-1.5">
                  {labels.map((label) => (
                    <span
                      key={label}
                      data-chip=""
                      className="inline-flex h-5 items-center gap-0.5 rounded px-1.5 text-caption font-medium bg-accent/60 text-foreground/70 group"
                    >
                      {label}
                      <button
                        type="button"
                        onClick={() => removeLabel(label)}
                        aria-label={t('fields.removeLabel', { label })}
                        className="text-muted-foreground hover:text-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity"
                      >
                        <XCircle className="w-2.5 h-2.5" />
                      </button>
                    </span>
                  ))}
                </div>
                {showLabelInput ? (
                  <div className="relative">
                    <input
                      ref={labelInputRef}
                      value={labelInput}
                      onChange={(e) => setLabelInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && labelInput.trim()) {
                          e.preventDefault()
                          addLabel(labelInput)
                        }
                        if (e.key === 'Escape') {
                          setShowLabelInput(false)
                          setLabelInput('')
                        }
                      }}
                      onBlur={() => {
                        if (labelInput.trim()) addLabel(labelInput)
                        setShowLabelInput(false)
                        setLabelInput('')
                      }}
                      placeholder={t('detailModal.addLabelPlaceholder')}
                      className="w-full h-7 rounded border border-border bg-input px-2 text-xs text-foreground placeholder:text-muted-foreground"
                    />
                    {labelSuggestions.length > 0 && (
                      <div className="absolute left-0 right-0 top-full mt-0.5 rounded border border-border/50 bg-popover shadow-lg z-10 py-0.5">
                        {labelSuggestions.map((suggestion) => (
                          <button
                            key={suggestion}
                            type="button"
                            onMouseDown={(e) => {
                              e.preventDefault()
                              addLabel(suggestion)
                            }}
                            className="w-full text-left px-2 py-1 text-xs hover:bg-accent/50 text-foreground/80"
                          >
                            {suggestion}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setShowLabelInput(true)}
                    className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <Plus className="w-2.5 h-2.5" />
                    {t('detailModal.addLabel')}
                  </button>
                )}
              </div>

              {/* Escaped-defect link — bug tickets (or an existing link) only */}
              {(isBugTicket(labels) || regressionOf !== null) && (
                <RegressionOfPicker value={regressionOf} onChange={setRegressionOf} disabled={saving} />
              )}

              {/* SMASH family — list of Sub-Specs (Epic view) or parent + siblings (child view) */}
              <EpicFamilySidebar
                ticket={ticket}
                allTickets={allTickets ?? []}
                onOpenTicket={(id) => onOpenTicket?.(id)}
              />

              {/* Jira details + Development (read-only) — only for Jira-backed specs */}
              {ticket.source === 'jira' && ticket.jira_key && (
                <JiraSpecDetailsPanel localId={ticket.id} />
              )}

              {/* Continue Editing lives in the modal header — see top of component. */}

              {/* Metadata */}
              {ticket.metadata?.effort_level && (
                <div>
                  <span className="text-label text-muted-foreground block mb-0.5">
                    {t('detailModal.effort')}
                  </span>
                  <span className="text-xs text-foreground/70">{ticket.metadata.effort_level}</span>
                </div>
              )}

              {ticket.assignee && (
                <div>
                  <span className="text-label text-muted-foreground block mb-0.5">
                    {t('detailModal.assignee')}
                  </span>
                  <span className="text-xs text-foreground/70">{ticket.assignee}</span>
                </div>
              )}
            </div>
          </div>
        </div>
        )}

        {/* Footer: destructive action + provenance on the left, Save on the right. */}
        <div className="flex shrink-0 items-center justify-between gap-3 px-5 py-3 border-t border-border/40">
          <div className="flex min-w-0 items-center gap-3 text-xs text-muted-foreground">
            {canDiscard ? (
              <Button
                variant="ghost"
                className="text-accent-info hover:bg-accent-info/10"
                onClick={() => setShowDiscard(true)}
                data-testid="jira-move-to-button"
              >
                <ArrowRight className="w-3.5 h-3.5 mr-1" />
                {tj('discard.moveButton', { status: jira.discardStatus })}
              </Button>
            ) : (
              <Button
                variant="ghost"
                className="text-destructive hover:text-destructive hover:bg-destructive/10"
                onClick={() => { void handleDelete() }}
                disabled={deleting}
              >
                <Trash2 className="w-3.5 h-3.5 mr-1" />
                {t('common:actions.delete')}
              </Button>
            )}
            <span>{t('meta.createdAgo', { time: formatRelTime(ticket.created_at) })}</span>
            <span>{t('meta.updatedAgo', { time: formatRelTime(ticket.updated_at) })}</span>
            {ticket.source && (
              <span className="bg-muted/30 rounded px-1.5 py-0.5">
                {SOURCE_LABEL_KEYS[ticket.source] ? t(SOURCE_LABEL_KEYS[ticket.source]) : ticket.source}
              </span>
            )}
          </div>
          {isDirty && (
            <Button
              onClick={() => { if (isJiraBacked) setShowJiraSaveConfirm(true); else void handleSave() }}
              disabled={saving || !title.trim()}
            >
              <Save className="w-3.5 h-3.5 mr-1" />
              {saving ? t('common:states.saving') : t('common:actions.save')}
            </Button>
          )}
        </div>
        {!embedded && <ResizeGrips handles={resizeHandles} placement="inset" />}
    </>
  )

  const dialogs = (
    <>
      {/* Jira "Move to <status>" — replaces delete for Jira-backed specs */}
      {canDiscard && jira.discardStatus && (
        <DiscardSpecDialog
          open={showDiscard}
          onOpenChange={setShowDiscard}
          ticket={{ id: ticket.id, title: ticket.title, jira_key: ticket.jira_key }}
          discardStatus={jira.discardStatus}
          onDiscarded={onClose}
        />
      )}

      {/* Save confirmation — Save on a Jira-backed spec writes back to the issue */}
      <ConfirmDialog
        open={showJiraSaveConfirm}
        onOpenChange={setShowJiraSaveConfirm}
        tone="default"
        title={tj('detail.saveTitle')}
        description={tj('detail.saveBody', { key: ticket.jira_key ?? `#${ticket.id}` })}
        confirmLabel={tj('detail.saveConfirm')}
        confirmDisabled={saving}
        onConfirm={() => { setShowJiraSaveConfirm(false); void handleSave() }}
        testId="jira-save-confirm"
        confirmTestId="jira-save-confirm-btn"
      />
    </>
  )

  if (embedded) {
    // Embedded in the split view: the shell is the dialog, each pane a region.
    return (
      <>
        <div ref={panelRef} role="region" aria-labelledby={titleId} className={panelClassName} style={panelInlineStyle}>
          {panelContent}
        </div>
        {dialogs}
      </>
    )
  }

  // Standalone: a Radix modal on the `entity` layer (focus trap, hideOthers,
  // focus return, Escape stacking). Above the floating agent panel and level
  // with Job detail — a spec opened from inside Job detail mounts later, so it
  // is the top layer; nested confirms/SMASH climb to `stacked`.
  return (
    <DialogPrimitive.Root open onOpenChange={(next) => { if (!next) onClose() }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          style={modalOverlayStyle()}
          className={cn(DIALOG_SCRIM_CLASS, DIALOG_LAYER_CLASS.entity)}
          data-testid="ticket-modal-overlay"
        />
        <div
          style={modalOverlayStyle()}
          className={cn('pointer-events-none fixed inset-0 flex items-center justify-center', DIALOG_LAYER_CLASS.entity)}
        >
          <DialogPrimitive.Content
            ref={panelRef}
            data-testid="ticket-detail-modal"
            data-dialog-layer="entity"
            className={cn(panelClassName, 'pointer-events-auto')}
            style={panelInlineStyle}
            onEscapeKeyDown={handleEscapeKeyDown}
            onPointerDownOutside={(e) => {
              // A resize drag that ends over the scrim must not dismiss.
              let dismiss = false
              guardBackdrop(() => { dismiss = true })()
              if (!dismiss) e.preventDefault()
            }}
            onCloseAutoFocus={handleCloseAutoFocus}
          >
            <DialogPrimitive.Description className="sr-only">#{ticket.id} · {statusLabel}</DialogPrimitive.Description>
            <DialogLayerProvider layer="entity">
              {panelContent}
              {dialogs}
            </DialogLayerProvider>
          </DialogPrimitive.Content>
        </div>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

function formatRelTime(dateStr: string): string {
  try {
    return formatDistanceToNow(new Date(dateStr), { addSuffix: true, locale: getDateFnsLocale() })
  } catch {
    return dateStr
  }
}


// ─── ContinueEditingButton ─────────────────────────────────────────────────

interface ContinueEditingButtonProps {
  ticket: LocalTicket
  /** Current modal-edited values, in case the user has unsaved tweaks. */
  title: string
  description: string
  priority: TicketPriority
  labels: string[]
  repositoryIds?: string[]
  onClose: () => void
}

/**
 * Single entry point for "open this ticket in Explore Spec to refine it".
 *
 * - draft + `origin_conversation_id`: resume the existing Explore conversation
 *   (preserves prior chat history). Same behaviour as the legacy `Continue
 *   Explore` button this component replaces.
 * - draft (no conv) / todo: launch a fresh Explore session in edit-existing-
 *   ticket mode (commits via PATCH; Review baseline = ticket).
 * - Jira-backed specs (`source==='jira'`): refine in any non-cancelled status
 *   too — the local status mirrors the Jira board column, not a rail
 *   lifecycle. See `canRefineTicket`.
 *
 * Hidden for non-Jira `in_progress`/`done` and any `cancelled` ticket.
 * See openspec/changes/replace-ai-edit-with-continue-editing/design.md D1+D8.
 */
function ContinueEditingButton({ ticket, title, description, priority, labels, repositoryIds, onClose }: ContinueEditingButtonProps) {
  const { t } = useTranslation('tickets')
  const { triggerResume } = useMinimizedChats()
  const { activeProjectId } = useDesktop()
  const { closeTicketDetail } = useTicketDetailModal()
  if (!canRefineTicket(ticket)) return null
  const handleClick = () => {
    if (!activeProjectId) return
    // Unified Continue Editing: ALL editable tickets get the editTicket
    // payload (draft pane pre-seeded + Review with real diff + PATCH commit).
    // If the ticket carries origin_conversation_id, also resume that
    // conversation so prior chat history is visible. The shell does NOT
    // auto-send a turn — the user types the first refinement.
    const { body, criteria } = parseAcceptanceCriteria(description)
    triggerResume({
      kind: 'explore-spec',
      projectId: activeProjectId,
      label: title || ticket.title || t('detailModal.ticketFallbackLabel', { id: ticket.id }),
      restoreRoute: '/',
      params: {
        initialIdea: '',
        // A real, filesystem-safe id (NOT '') so attachment uploads and the
        // "From a website" capture work in edit mode (an empty id 400s capture
        // with "pendingSpecId is required").
        pendingSpecId: genPendingSpecId(),
        initialAttachmentIds: [],
        resumeConversationId: ticket.origin_conversation_id ?? undefined,
        editTicket: {
          id: ticket.id,
          title,
          description: body,
          labels,
          priority,
          repositoryIds,
          acceptanceCriteria: criteria,
          nonGoals: ticket.nonGoals ?? [],
          // Drives publish-vs-update on commit: a draft PUBLISHES (flips to a
          // real spec), a live spec PATCHes in place. See ExploreSpecShell.
          status: ticket.status,
        },
      },
    })
    // Continue Editing navigates the user to ExploreSpecShell. Always
    // collapse the modal context (split or centered) so the comparison
    // disappears and the shell takes over the surface. `onClose` is also
    // called for any third-party modal mount (e.g. DashboardPage's local
    // state) — harmless when the modal is provider-owned because the state
    // has already been cleared.
    closeTicketDetail()
    onClose()
  }
  return (
    <Button
      variant="default"
      size="sm"
      onClick={handleClick}
      className="shrink-0 mr-2"
      data-testid="continue-editing"
    >
      <MessageSquare className="w-3.5 h-3.5 mr-1.5" />
      {t('detailModal.continueEditing')}
    </Button>
  )
}

// ─── RailAssignmentButton ───────────────────────────────────────────────────

interface RailAssignmentButtonProps {
  ticket: LocalTicket
  rails: RailState[]
  onMoveToRail?: (ticketId: number, railId: string) => void
  onRemoveFromRail?: (ticketId: number) => void
  /** Another primary is shown: render as outline so exactly one stays filled. */
  secondary?: boolean
}

/**
 * Header button next to "Continue Editing" that toggles between
 * "Move to Rail →" (opens the shared `MoveToRailPopover`) and
 * "← Remove from Rail" (returns the spec to the specs list), depending on
 * whether the ticket is already assigned to a rail.
 */
function RailAssignmentButton({ ticket, rails, onMoveToRail, onRemoveFromRail, secondary }: RailAssignmentButtonProps) {
  const { t } = useTranslation('tickets')
  const [anchor, setAnchor] = useState<DOMRect | null>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const assignedRail = rails.find((r) => r.ticketIds.includes(ticket.id))

  if (assignedRail) {
    if (!onRemoveFromRail) return null
    return (
      <Button
        variant="outline"
        size="sm"
        className="shrink-0 mr-2 gap-1.5 border-accent-warning/30 text-accent-warning hover:bg-accent-warning/10 hover:text-accent-warning"
        data-testid="modal-remove-from-rail"
        onClick={() => onRemoveFromRail(ticket.id)}
        title={t('rail.currentlyOn', { rail: assignedRail.label })}
      >
        <ArrowLeft className="w-3.5 h-3.5" aria-hidden />
        {t('rail.removeFromRail')}
      </Button>
    )
  }

  if (!onMoveToRail) return null
  return (
    <>
      <Button
        ref={buttonRef}
        size="sm"
        variant={secondary ? 'outline' : 'default'}
        className="shrink-0 mr-2 gap-1.5"
        data-testid="modal-move-to-rail"
        onClick={() => {
          if (!buttonRef.current) return
          setAnchor(buttonRef.current.getBoundingClientRect())
        }}
      >
        {t('rail.moveToRail')}
        <ArrowRight className="w-3.5 h-3.5" aria-hidden />
      </Button>
      {anchor && (
        <MoveToRailPopover
          rails={rails}
          anchorRect={anchor}
          onMoveToRail={(railId) => onMoveToRail(ticket.id, railId)}
          onClose={() => setAnchor(null)}
        />
      )}
    </>
  )
}

// ─── Timeline tab host ──────────────────────────────────────────────────────

/** Mounts the timeline with router-aware navigation (the modal also renders outside a router in isolation). */
function TimelineHost(props: { ticketId: number; refreshKey: string; onClose: () => void }) {
  const inRouter = useInRouterContext()
  return inRouter ? <TimelineHostInner {...props} /> : <SpecTimeline ticketId={props.ticketId} refreshKey={props.refreshKey} uiMode="kanban" currentSearch="" onNavigate={() => {}} />
}

function TimelineHostInner({ ticketId, refreshKey, onClose }: { ticketId: number; refreshKey: string; onClose: () => void }) {
  const navigate = useNavigate()
  const location = useLocation()
  const { uiMode, setUiMode } = useUiMode()
  const goTo = useCallback((target: TimelineTarget) => {
    onClose()
    const go = (): void => { navigate({ pathname: target.pathname, search: target.search }, { state: { [PLACE_PUSH_STATE]: target.place } }) }
    // A mission only exists in Mission mode: switch first, then navigate in the next task (the mode switch restores its own route).
    if (target.needsAgentMode) { setUiMode('agent', { immediate: true }); setTimeout(go, 0) } else go()
  }, [navigate, onClose, setUiMode])
  return <SpecTimeline ticketId={ticketId} refreshKey={refreshKey} uiMode={uiMode} currentSearch={location.search} onNavigate={goTo} onOpenExternal={(url) => { void openExternalUrl(url) }} />
}

// ─── Status primary action ──────────────────────────────────────────────────

/**
 * The one primary action of a spec that is already past the rail hand-off:
 * `on_review` opens the review packet, `in_progress` opens the running job.
 * Renders nothing when the target cannot be resolved (no live delivery / job).
 */
function StatusPrimaryAction(props: { ticket: LocalTicket; rails?: RailState[]; onClose: () => void; onShownChange?: (shown: boolean) => void }) {
  const inRouter = useInRouterContext()
  return inRouter ? <StatusPrimaryActionInner {...props} /> : null
}

function StatusPrimaryActionInner({ ticket, rails, onClose, onShownChange }: { ticket: LocalTicket; rails?: RailState[]; onClose: () => void; onShownChange?: (shown: boolean) => void }) {
  const { t } = useTranslation('tickets')
  const navigate = useNavigate()
  const { decisions } = useRailPrDecisions()
  let path: string | null = null
  let label = ''
  if (ticket.status === 'on_review') {
    for (const d of decisions.values()) {
      if (d.ticketIds.includes(ticket.id)) { path = `/review/${encodeURIComponent(d.prDeliveryId)}`; break }
    }
    label = t('detailModal.openReview')
  } else {
    const jobId = rails?.find((r) => r.ticketIds.includes(ticket.id))?.activeJobId
    if (jobId) path = `/jobs/${encodeURIComponent(jobId)}`
    label = t('detailModal.viewJob')
  }
  const shown = Boolean(path)
  useEffect(() => {
    onShownChange?.(shown)
    return () => onShownChange?.(false)
  }, [shown, onShownChange])
  if (!path) return null
  const target = path
  return (
    <Button
      size="sm"
      className="shrink-0 mr-2 gap-1.5"
      data-testid="modal-primary-action"
      onClick={() => { onClose(); navigate(target) }}
    >
      {label}
      <ArrowRight className="w-3.5 h-3.5" aria-hidden />
    </Button>
  )
}

// ─── Contract Layer disclosure ──────────────────────────────────────────────

const CONTRACT_LAYER_SEPARATOR = '\n\n---\n\n## Contract Layer\n\n'

function splitDescriptionAtContractLayer(description: string): { user: string; contract: string | null } {
  const idx = description.indexOf(CONTRACT_LAYER_SEPARATOR)
  if (idx < 0) return { user: description, contract: null }
  return {
    user: description.slice(0, idx),
    contract: description.slice(idx + CONTRACT_LAYER_SEPARATOR.length),
  }
}

function countContractSubsections(contract: string): number {
  const subs = ['### Naming Contract', '### Data Shapes', '### State Machine', '### Invariants', '### File Touch List']
  let count = 0
  for (const sub of subs) {
    const start = contract.indexOf(sub)
    if (start < 0) continue
    const tail = contract.slice(start + sub.length)
    const naIdx = tail.indexOf('N/A — model did not produce items')
    const nextHeading = tail.indexOf('### ')
    if (naIdx >= 0 && (nextHeading < 0 || naIdx < nextHeading)) continue
    count++
  }
  return count
}

interface DescriptionRenderProps {
  description: string
  onEdit: () => void
}

function DescriptionRender({ description, onEdit }: DescriptionRenderProps) {
  const { t } = useTranslation('tickets')
  const { openWebView } = useWebViewModal()
  const { user, contract } = splitDescriptionAtContractLayer(description)
  const userPart = user || description
  // Open http(s) links from the description inside the app's embedded browser
  // modal (sharing the global cookies/profile), instead of navigating away.
  const markdownComponents = useMemo(() => ({
    a: ({ href, children }: { href?: string; children?: React.ReactNode }) => (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        onClick={(e) => {
          if (typeof href === 'string' && /^https?:\/\//i.test(href)) {
            e.preventDefault()
            e.stopPropagation() // don't trigger the card's enter-edit onClick
            openWebView(href)
          }
        }}
      >
        {children}
      </a>
    ),
  }), [openWebView])
  return (
    <div
      className="flex-1 rounded-lg bg-muted/20 px-3 py-2 overflow-y-auto transition-colors"
      onClick={(e) => {
        // Don't enter edit mode when interacting with the disclosure
        if ((e.target as HTMLElement).closest('details, summary')) return
        onEdit()
      }}
      role="button"
      style={{ cursor: 'pointer' }}
    >
      <div className="prose prose-invert prose-sm text-body leading-relaxed max-w-[75ch] prose-p:my-2.5 prose-headings:text-title prose-headings:mt-5 prose-headings:mb-2 prose-headings:font-semibold prose-ul:my-2 prose-ol:my-2 prose-li:my-0.5 prose-code:text-foreground prose-code:text-label [&_code]:!text-label [&_pre]:!text-label prose-code:bg-muted prose-code:px-1 prose-code:py-0.5 prose-code:rounded-control text-foreground/90">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{userPart}</ReactMarkdown>
      </div>
      {contract && (
        <details
          data-testid="contract-layer-disclosure"
          className="mt-3 rounded-md border border-border/40 bg-muted/10 px-2 py-1"
          onClick={(e) => e.stopPropagation()}
        >
          <summary className="cursor-pointer text-label text-foreground/80 select-none flex items-center gap-2">
            {t('contractLayer.title')}
            <span data-chip="" className="inline-flex h-5 items-center rounded-full bg-muted/40 px-1.5 text-caption text-foreground/60">
              {t('contractLayer.populated', { n: countContractSubsections(contract) })}
            </span>
          </summary>
          <div className="mt-2 prose prose-invert prose-sm text-body leading-relaxed max-w-[75ch] prose-p:my-2.5 prose-headings:text-title prose-headings:mt-5 prose-headings:mb-2 prose-headings:font-semibold prose-ul:my-2 prose-ol:my-2 prose-li:my-0.5 prose-code:text-foreground prose-code:text-label [&_code]:!text-label [&_pre]:!text-label prose-code:bg-muted prose-code:px-1 prose-code:py-0.5 prose-code:rounded-control text-foreground/90">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{contract}</ReactMarkdown>
          </div>
        </details>
      )}
    </div>
  )
}
