import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { formatDistanceToNow } from 'date-fns'
import { Trans, useTranslation } from 'react-i18next'
import { X, Pencil, Trash2, Save, Plus, XCircle, MessageSquare, ArrowRight, ArrowLeft, Columns2, ExternalLink } from 'lucide-react'
import { openExternalUrl } from '../lib/tauri-shell'
import { toast } from 'sonner'
import { getDateFnsLocale } from '../lib/i18n'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from './ui/dialog'
import { AttachmentsSection } from './AttachmentsSection'
import { TicketFilesTouched } from './code-explorer/TicketFilesTouched'
import { TicketSpendingLine } from './TicketSpendingLine'
import { useMinimizedChats } from '../context/MinimizedChatsContext'
import { useTicketDetailModal } from '../context/TicketDetailModalContext'
import { useJiraConnection } from '../hooks/useJiraConnection'
import { DiscardSpecDialog } from './jira/DiscardSpecDialog'
import { JiraSpecDetailsPanel } from './jira/JiraSpecDetailsPanel'
import { parseAcceptanceCriteria } from './explore-spec/acceptance-criteria'
import { canRefineTicket } from '../lib/ticket-refine'
import { genPendingSpecId } from '../lib/pending-spec-id'
import { useWebViewModal } from '../context/WebViewModalContext'
import { useDesktop } from '../hooks/useDesktop'
import { SmashActions } from './specs-smash/SmashActions'
import { EpicBreadcrumb } from './specs-smash/EpicChildrenSection'
import { EpicFamilySidebar } from './specs-smash/EpicFamilySidebar'
import { MoveToRailPopover } from './MoveToRailPopover'
import type { RailState } from './RailsBoard'
import type { Attachment, LocalTicket, TicketPriority } from '../types'

const COMPARE_VIEWPORT_MIN = 900
const DRAG_SNAP_THRESHOLD = 0.20 // 20% of viewport width

// ─── Constants ──────────────────────────────────────────────────────────────

const PRIORITY_OPTIONS: { value: TicketPriority; labelKey: string; className: string }[] = [
  { value: 'critical', labelKey: 'priority.critical', className: 'text-red-400' },
  { value: 'high', labelKey: 'priority.high', className: 'text-orange-400' },
  { value: 'medium', labelKey: 'priority.medium', className: 'text-yellow-400' },
  { value: 'low', labelKey: 'priority.low', className: 'text-slate-400' },
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
  onSave: (ticketId: number, fields: Partial<Pick<LocalTicket, 'title' | 'description' | 'status' | 'priority' | 'labels'>>) => Promise<boolean>
  onDelete: (ticketId: number) => void
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
  const { activeProjectId, projects } = useDesktop()
  const { enterSplit, state: splitState } = useTicketDetailModal()
  const inSplit = splitState.originSide !== null
  // Feature flag for SMASH. Server gates with `SPECRAILS_SMASH=0` returning
  // 409 from endpoints; the UI optimistically shows the affordance and lets
  // the server reject if disabled.
  //
  // Also disabled on codex projects: SMASH's pipeline depends on claude's
  // multi-agent fan-out (architect/developer/reviewer in parallel via
  // subagent_type), which codex's spawn_agent doesn't support the same
  // way. Hiding the affordance here keeps the modal clean rather than
  // surfacing a feature that would 409 / fail on a codex spawn.
  const activeProvider = projects.find((p) => p.id === activeProjectId)?.provider
  const smashFlagOn = activeProvider !== 'codex'
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

  // Edit mode toggles
  const [editingTitle, setEditingTitle] = useState(false)
  const [editingDescription, setEditingDescription] = useState(false)
  const [labelInput, setLabelInput] = useState('')
  const [showLabelInput, setShowLabelInput] = useState(false)

  // Confirmation dialog
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [showDiscard, setShowDiscard] = useState(false)
  const [showJiraSaveConfirm, setShowJiraSaveConfirm] = useState(false)
  const [saving, setSaving] = useState(false)

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

  const titleInputRef = useRef<HTMLInputElement>(null)
  const descTextareaRef = useRef<HTMLTextAreaElement>(null)
  const labelInputRef = useRef<HTMLInputElement>(null)

  // Track if anything changed
  const isDirty = useMemo(() => {
    return (
      title !== ticket.title ||
      description !== ticket.description ||
      priority !== ticket.priority ||
      JSON.stringify(labels) !== JSON.stringify(ticket.labels)
    )
  }, [title, description, priority, labels, ticket])

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

  // Close on Escape (unless editing or AI overlay is open — overlay owns Esc).
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !editingTitle && !editingDescription && !showDeleteConfirm) {
        onClose()
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [onClose, editingTitle, editingDescription, showDeleteConfirm])

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
    const changes: Partial<Pick<LocalTicket, 'title' | 'description' | 'priority' | 'labels'>> = {}
    if (title !== ticket.title) changes.title = title
    if (description !== ticket.description) changes.description = description
    if (priority !== ticket.priority) changes.priority = priority
    if (JSON.stringify(labels) !== JSON.stringify(ticket.labels)) changes.labels = labels

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
      toast.error(t('detailModal.toast.updateFailed'))
    }
  }, [title, description, priority, labels, ticket, onSave, onClose, t])

  const handleDelete = useCallback(() => {
    onDelete(ticket.id)
    setShowDeleteConfirm(false)
    onClose()
  }, [ticket.id, onDelete, onClose])

  // ─── Drag-to-snap (entry to split-view) ────────────────────────────────────
  const [dragOffset, setDragOffset] = useState(0)
  const dragRef = useRef<{ startX: number; pointerId: number } | null>(null)
  const canDrag = !embedded && !inSplit && typeof window !== 'undefined' && window.innerWidth >= COMPARE_VIEWPORT_MIN

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
    if (Math.abs(delta) >= threshold) {
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
    if (!canDrag) return
    const isProviderModal = splitState.leftId === ticket.id
    enterSplit('right', ticket.id)
    if (!isProviderModal) onClose()
  }, [canDrag, enterSplit, splitState.leftId, ticket.id, onClose])

  // ─── Layout helpers ────────────────────────────────────────────────────────
  const panel = (
    <>
      <div
        className={
          embedded
            ? 'relative w-full h-full rounded-xl bg-card border border-border/40 shadow-2xl shadow-black/50 flex flex-col overflow-hidden'
            : 'relative w-full max-w-[67rem] m-4 rounded-xl bg-card border border-border/40 shadow-2xl shadow-black/50 flex flex-col animate-in fade-in zoom-in-95 duration-200 h-[90vh]'
        }
        style={dragOffset !== 0 ? { transform: `translateX(${dragOffset}px)`, transition: 'none' } : { transition: 'transform 220ms cubic-bezier(0.34, 1.56, 0.64, 1)' }}
      >
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
                className="w-full bg-transparent border-b border-accent-primary/50 text-sm font-semibold text-foreground outline-none pb-0.5"
              />
            ) : (
              <button
                type="button"
                onClick={() => setEditingTitle(true)}
                className="group flex items-center gap-1.5 text-left w-full"
              >
                <h2 className="text-sm font-semibold text-foreground truncate">{title || t('untitled')}</h2>
                <Pencil className="w-3 h-3 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity shrink-0" />
              </button>
            )}
            <div className="flex items-center gap-2 mt-1.5">
              <span className="text-[10px] text-foreground font-mono">#{ticket.id}</span>
            </div>
            <TicketSpendingLine ticketId={ticket.id} />
          </div>

          {activeProjectId && (
            <div className="shrink-0">
              <SmashActions
                ticket={ticket}
                projectId={activeProjectId}
                featureFlagOn={smashFlagOn}
                childrenCount={childrenList.length}
              />
            </div>
          )}

          <ContinueEditingButton ticket={ticket} title={title} description={description} priority={priority} labels={labels} onClose={onClose} />

          {rails && (onMoveToRail || onRemoveFromRail) && (
            <RailAssignmentButton
              ticket={ticket}
              rails={rails}
              onMoveToRail={onMoveToRail}
              onRemoveFromRail={onRemoveFromRail}
            />
          )}

          {canDrag && (
            <Button
              variant="outline"
              size="sm"
              className="shrink-0 mr-1 gap-1.5"
              data-testid="ticket-modal-compare"
              onClick={handleCompareClick}
              title={t('detailModal.compareTooltip')}
            >
              <Columns2 className="w-3.5 h-3.5" />
              {t('detailModal.compare')}
            </Button>
          )}

          <button
            onClick={onClose}
            className="h-7 w-7 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-surface/50 transition-colors cursor-pointer shrink-0"
            data-testid="ticket-modal-close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto min-h-0">
          <div className="flex flex-col sm:flex-row h-full">
            {/* Main content */}
            <div className="flex-1 min-w-0 px-5 py-4 space-y-4 flex flex-col">
              {/* AI Edit overlay renders fullscreen above this modal — see end of component. */}

              <div className="flex-1 flex flex-col">
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                    {t('fields.description')}
                  </span>
                  {!editingDescription && (
                    <button
                      type="button"
                      onClick={() => setEditingDescription(true)}
                      className="text-[10px] text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1"
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
                        className="h-6 text-[10px]"
                        onClick={() => setEditingDescription(false)}
                      >
                        {t('detailModal.doneEditing')}
                      </Button>
                      <span className="text-[9px] text-muted-foreground">{t('fields.supportsMarkdown')}</span>
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
                  <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider block mb-1.5">
                    {t('detailModal.prerequisites')}
                  </span>
                  <div className="flex flex-wrap gap-1">
                    {ticket.prerequisites.map((id) => (
                      <span
                        key={id}
                        className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-mono bg-accent/60 text-foreground/70"
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
                  className="w-full inline-flex items-center justify-center gap-1.5 h-7 rounded border border-accent-info/50 bg-accent-info/10 px-2 text-xs font-medium text-accent-info hover:bg-accent-info/20 transition-colors"
                >
                  <ExternalLink className="w-3.5 h-3.5 shrink-0" />
                  {tj('detail.goToTicket', { key: ticket.jira_key })}
                </button>
              )}
              {/* Parent Jira epic — only when the issue has one */}
              {ticket.jira_epic_key && (
                <div data-testid="jira-epic">
                  <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider block mb-1.5">
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
              {/* Priority selector */}
              <div>
                <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider block mb-1.5">
                  {t('fields.priority')}
                </span>
                <select
                  value={priority}
                  onChange={(e) => setPriority(e.target.value as TicketPriority)}
                  className="w-full h-7 rounded border border-border bg-input px-2 text-xs text-foreground"
                >
                  {PRIORITY_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>{t(opt.labelKey)}</option>
                  ))}
                </select>
              </div>

              {/* Labels */}
              <div>
                <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider block mb-1.5">
                  {t('fields.labels')}
                </span>
                <div className="flex flex-wrap gap-1 mb-1.5">
                  {labels.map((label) => (
                    <span
                      key={label}
                      className="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] font-medium bg-accent/60 text-foreground/70 group"
                    >
                      {label}
                      <button
                        type="button"
                        onClick={() => removeLabel(label)}
                        className="text-muted-foreground hover:text-foreground opacity-0 group-hover:opacity-100 transition-opacity"
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
                      className="w-full h-6 rounded border border-border bg-input px-2 text-[10px] text-foreground placeholder:text-muted-foreground"
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
                            className="w-full text-left px-2 py-1 text-[10px] hover:bg-accent/50 text-foreground/80"
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
                    className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <Plus className="w-2.5 h-2.5" />
                    {t('detailModal.addLabel')}
                  </button>
                )}
              </div>

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
                  <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider block mb-0.5">
                    {t('detailModal.effort')}
                  </span>
                  <span className="text-xs text-foreground/70">{ticket.metadata.effort_level}</span>
                </div>
              )}

              {ticket.assignee && (
                <div>
                  <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider block mb-0.5">
                    {t('detailModal.assignee')}
                  </span>
                  <span className="text-xs text-foreground/70">{ticket.assignee}</span>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-3 border-t border-border/30">
          <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
            <span>{t('meta.createdAgo', { time: formatRelTime(ticket.created_at) })}</span>
            <span>{t('meta.updatedAgo', { time: formatRelTime(ticket.updated_at) })}</span>
            {ticket.source && (
              <span className="bg-muted/30 rounded px-1.5 py-0.5">
                {SOURCE_LABEL_KEYS[ticket.source] ? t(SOURCE_LABEL_KEYS[ticket.source]) : ticket.source}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            {canDiscard ? (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs text-accent-info hover:bg-accent-info/10"
                onClick={() => setShowDiscard(true)}
                data-testid="jira-move-to-button"
              >
                <ArrowRight className="w-3 h-3 mr-1" />
                {tj('discard.moveButton', { status: jira.discardStatus })}
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs text-red-400 aurora-light:text-destructive hover:text-red-300 aurora-light:hover:text-destructive hover:bg-red-500/10 aurora-light:hover:bg-destructive/10"
                onClick={() => setShowDeleteConfirm(true)}
              >
                <Trash2 className="w-3 h-3 mr-1" />
                {t('common:actions.delete')}
              </Button>
            )}
            {isDirty && (
              <Button
                size="sm"
                className="h-7 text-xs"
                onClick={() => { if (isJiraBacked) setShowJiraSaveConfirm(true); else void handleSave() }}
                disabled={saving || !title.trim()}
              >
                <Save className="w-3 h-3 mr-1" />
                {saving ? t('common:states.saving') : t('common:actions.save')}
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Delete confirmation dialog */}
      <Dialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('deleteDialog.title')}</DialogTitle>
            <DialogDescription>
              <Trans
                t={t}
                i18nKey="deleteDialog.body"
                values={{ id: ticket.id, title: ticket.title }}
                components={{ strong: <span className="font-semibold text-foreground" /> }}
              />
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setShowDeleteConfirm(false)}>
              {t('common:actions.cancel')}
            </Button>
            <Button variant="destructive" size="sm" onClick={handleDelete}>
              <Trash2 className="w-3.5 h-3.5 mr-1.5" />
              {t('common:actions.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
      <Dialog open={showJiraSaveConfirm} onOpenChange={setShowJiraSaveConfirm}>
        <DialogContent className="max-w-md" data-testid="jira-save-confirm">
          <DialogHeader>
            <DialogTitle>{tj('detail.saveTitle')}</DialogTitle>
            <DialogDescription>{tj('detail.saveBody', { key: ticket.jira_key ?? `#${ticket.id}` })}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setShowJiraSaveConfirm(false)}>
              {t('common:actions.cancel')}
            </Button>
            <Button size="sm" onClick={() => { setShowJiraSaveConfirm(false); void handleSave() }} disabled={saving} data-testid="jira-save-confirm-btn">
              <Save className="w-3.5 h-3.5 mr-1.5" />
              {tj('detail.saveConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )

  if (embedded) return panel
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/70" onClick={onClose} />
      {panel}
    </div>
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
function ContinueEditingButton({ ticket, title, description, priority, labels, onClose }: ContinueEditingButtonProps) {
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
          acceptanceCriteria: criteria,
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
}

/**
 * Header button next to "Continue Editing" that toggles between
 * "Move to Rail →" (opens the shared `MoveToRailPopover`) and
 * "← Remove from Rail" (returns the spec to the specs list), depending on
 * whether the ticket is already assigned to a rail.
 */
function RailAssignmentButton({ ticket, rails, onMoveToRail, onRemoveFromRail }: RailAssignmentButtonProps) {
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
        variant="outline"
        size="sm"
        className="shrink-0 mr-2 gap-1.5 border-accent-info/30 text-accent-info hover:bg-accent-info/10 hover:text-accent-info"
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
      <div className="prose prose-invert prose-xs max-w-none prose-p:my-1 prose-headings:mt-2 prose-headings:mb-1 prose-headings:text-sm prose-headings:font-semibold prose-ul:my-1 prose-ol:my-1 prose-li:my-0 prose-code:text-cyan-300 prose-code:text-[10px] prose-code:bg-muted/40 prose-code:px-1 prose-code:py-0.5 prose-code:rounded text-foreground/80 text-xs">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{userPart}</ReactMarkdown>
      </div>
      {contract && (
        <details
          data-testid="contract-layer-disclosure"
          className="mt-3 rounded-md border border-border/40 bg-muted/10 px-2 py-1"
          onClick={(e) => e.stopPropagation()}
        >
          <summary className="cursor-pointer text-[10px] font-medium text-foreground/80 select-none flex items-center gap-2">
            {t('contractLayer.title')}
            <span className="rounded-full bg-muted/40 px-1.5 text-[9px] text-foreground/60">
              {t('contractLayer.populated', { n: countContractSubsections(contract) })}
            </span>
          </summary>
          <div className="mt-2 prose prose-invert prose-xs max-w-none prose-p:my-1 prose-headings:mt-2 prose-headings:mb-1 prose-headings:text-sm prose-headings:font-semibold prose-ul:my-1 prose-ol:my-1 prose-li:my-0 prose-code:text-cyan-300 prose-code:text-[10px] prose-code:bg-muted/40 prose-code:px-1 prose-code:py-0.5 prose-code:rounded text-foreground/80 text-xs">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{contract}</ReactMarkdown>
          </div>
        </details>
      )}
    </div>
  )
}

