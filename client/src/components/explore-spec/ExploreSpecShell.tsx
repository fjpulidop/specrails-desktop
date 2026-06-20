import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, Check, Send, Loader2, Minus, Sparkles, X, Plug } from 'lucide-react'
import { toast } from 'sonner'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '../ui/dialog'
import { useChatContext, type ChatConversation } from '../../hooks/useChat'
import { providerLabel } from '../../lib/provider-capabilities'
import { useSpecDraftStream } from '../../hooks/useSpecDraftStream'
import { useDesktop } from '../../hooks/useDesktop'
import { useJiraConnection } from '../../hooks/useJiraConnection'
import { getApiBase } from '../../lib/api'
import { API_ORIGIN } from '../../lib/origin'
import { markSpecGenInFlight, unmarkSpecGenInFlight } from '../../lib/spec-gen-suppression'
import { RichAttachmentEditor, type RichAttachmentEditorHandle } from '../RichAttachmentEditor'
import { SpecDraftPanel } from './SpecDraftPanel'
import { ExploreStatusPills } from './ExploreStatusPills'
import { useSmoothStream } from './useSmoothStream'
import { ExploreReviewOverlay, EMPTY_REVIEW_BASELINE, type ReviewProposed } from './ExploreReviewOverlay'
import type { LocalTicket, Attachment } from '../../types'

function isMacTauriOverlay(): boolean {
  if (typeof window === 'undefined') return false
  if (!('__TAURI_INTERNALS__' in window)) return false
  return /mac/i.test(navigator.platform)
}

export interface ExploreSpecShellProps {
  /** The user's initial idea typed in the Add Spec modal. */
  initialIdea: string
  /** Pending spec id used as the attachments storage key. Stable for the
   *  lifetime of the overlay; on Create Spec the server migrates the
   *  directory to the real ticket id. */
  pendingSpecId: string
  /** Attachment ids that were already uploaded in the Add Spec modal. */
  initialAttachmentIds: string[]
  /** Model picked at Add Spec. Used to seed the conversation's `model`
   *  column on first turn. Locked for the conversation lifetime — no UI
   *  in this shell mutates it. Ignored when `resumeConversationId` is
   *  set (the persisted conversation already carries its own model). */
  initialModel?: string
  /** AI engine picked at Add Spec (multi-provider). Seeds the conversation's
   *  provider on first turn; ignored when resuming. Undefined → project primary. */
  initialProvider?: string
  /** When set, skip the `/specrails:explore-spec` bootstrap turn and resume
   *  from an existing conversation id. Used by the minimize-to-dock restore
   *  path so the user picks up where they left off. */
  resumeConversationId?: string
  /** Last-known draft title from the chip — surfaced in the header before
   *  the WS-driven `useSpecDraftStream` catches up on remount, so the
   *  shell never visibly forgets the title across minimize cycles. */
  seedDraftTitle?: string
  /** Last-known composer text — repopulates the textarea on remount so a
   *  half-typed reply isn't lost across minimize/restore cycles. */
  seedComposerText?: string
  /** Manual draft field overrides accumulated before minimize (title,
   *  description, labels, priority, acceptanceCriteria). Replayed via
   *  setField on remount so user edits survive across cycles. */
  seedDraftOverrides?: Partial<{
    title: string
    description: string
    priority: 'low' | 'medium' | 'high' | 'critical'
    labels: string[]
    acceptanceCriteria: string[]
  }>
  onClose: () => void
  /** Optional minimize affordance — when present a `—` button in the header
   *  fires this callback. Receives the current conversation id so the caller
   *  can park it in the dock and resume later. */
  onMinimize?: (conversationId: string | null, draftTitle: string) => void
  /** Push live shell state up to the parent so it can drive programmatic
   *  auto-minimize (e.g. when another minimized spec is restored and this
   *  one needs to be parked instead of unmounted). Fires on changes only. */
  onStateChange?: (state: {
    conversationId: string | null
    draftTitle: string
    composerText: string
    draftOverrides: Partial<{
      title: string
      description: string
      priority: 'low' | 'medium' | 'high' | 'critical'
      labels: string[]
      acceptanceCriteria: string[]
    }>
  }) => void
  onTicketCreated?: (ticket: LocalTicket) => void
  /**
   * When set, the shell runs in "edit existing ticket" mode:
   *   - the draft pane is seeded from this ticket
   *   - the Review overlay receives this ticket as its baseline (real diffs)
   *   - the commit dispatches `PATCH /tickets/:id` instead of POST from-draft
   *   - the header eyebrow reads `EDITING SPEC · #{id}`
   * See openspec/changes/replace-ai-edit-with-continue-editing/design.md D2.
   */
  editTicket?: EditTicketSeed
  /** Context scope chosen in the Add Spec modal. Used at conversation
   *  creation time to freeze the per-turn spawn behaviour and to render
   *  the persistent header pill. Ignored when resumeConversationId is set. */
  contextScope?: import('../../types/context-scope').ContextScope
}

export interface EditTicketSeed {
  id: number
  title: string
  description: string
  labels: string[]
  priority: 'low' | 'medium' | 'high' | 'critical' | null
  acceptanceCriteria: string[]
  /** Current ticket status. When `'draft'`, the primary commit PUBLISHES the
   *  draft — it flips the ticket to a real spec (`status='todo'`) via
   *  `from-draft` instead of PATCHing in place — and the button reads
   *  "Create Spec". For any other status (todo/backlog) the commit PATCHes the
   *  ticket and the button reads "Update Spec". Optional for backward-compat:
   *  absent ⇒ treated as a real-spec edit (PATCH). */
  status?: LocalTicket['status']
}

export function ExploreSpecShell({
  initialIdea,
  pendingSpecId,
  initialAttachmentIds,
  initialModel,
  initialProvider,
  resumeConversationId,
  seedDraftTitle,
  seedComposerText,
  seedDraftOverrides,
  onClose,
  onMinimize,
  onStateChange,
  editTicket,
  onTicketCreated,
  contextScope,
}: ExploreSpecShellProps) {
  const { t } = useTranslation('explore')
  const { t: tj } = useTranslation('jira')
  // On a Jira-backed project a committed Explore spec is always created in Jira;
  // the indicator makes that explicit. (Private specs use Save as Draft.)
  const jira = useJiraConnection()
  const chat = useChatContext()
  const { activeProjectId } = useDesktop()
  const [conversationId, setConversationId] = useState<string | null>(
    resumeConversationId ?? null,
  )
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const [hasComposerText, setHasComposerText] = useState(false)
  const [isCreating, setIsCreating] = useState(false)
  // Optimistic "pending turn" flag flipped at submit-time so the skeleton
  // bubble + Connecting… pill appear within a frame, before the WS round-trip
  // sets conversation.isStreaming. Cleared when isStreaming actually flips.
  const [pendingTurn, setPendingTurn] = useState(false)
  // Review overlay open/closed. Opening it does not mutate any state; the
  // overlay reads draft live and reuses the same handleCreate handler.
  const [reviewOpen, setReviewOpen] = useState(false)
  // Build-time flag — flip to 'false' to remove the Review → entry point.
  // See openspec/changes/power-up-explore-review-diff/design.md.
  const REVIEW_ENABLED = ((typeof import.meta !== 'undefined' &&
    (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_FEATURE_EXPLORE_REVIEW) ?? 'true') !== 'false'
  const [accumulatedAttachments, setAccumulatedAttachments] = useState<Attachment[]>([])
  const previousFocusRef = useRef<Element | null>(null)
  const startedRef = useRef(false)
  // Tracks whether the current edit-mode shell session has already sent its
  // first wrapped turn. Resets on remount (each Continue Editing click).
  const editFirstSendRef = useRef(false)
  // True only when editing a ticket that is ALREADY a real spec (todo/backlog).
  // A draft opened via Continue Editing has `editTicket.status === 'draft'`, so
  // it is NOT a "real spec edit": its primary commit PUBLISHES (flips draft →
  // todo) rather than PATCHing in place, and the button reads "Create Spec".
  // editTicket without a status (legacy callers / tests) ⇒ real-spec edit, so
  // the prior PATCH behaviour is preserved unchanged.
  const isRealSpecEdit = !!editTicket && editTicket.status !== 'draft'
  const composerRef = useRef<RichAttachmentEditorHandle | null>(null)
  const conversationScrollRef = useRef<HTMLDivElement | null>(null)
  const conversationBottomRef = useRef<HTMLDivElement | null>(null)
  const userScrolledRef = useRef(false)

  // Detect manual scroll-up so streaming responses don't yank the user back
  // to the bottom while they're reading earlier turns. Threshold mirrors the
  // sidebar MessageList behaviour.
  const handleConversationScroll = useCallback(() => {
    const el = conversationScrollRef.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    userScrolledRef.current = distanceFromBottom > 100
  }, [])


  // Refresh the list of attachments accumulated in pendingSpecId/. Files
  // added in the Add Spec modal AND in any prior conversation turn live in
  // the same dir; the server returns the union.
  const refreshAttachments = useCallback(async () => {
    if (!activeProjectId) return
    try {
      const res = await fetch(`${API_ORIGIN}/api/projects/${activeProjectId}/tickets/${pendingSpecId}/attachments`)
      if (!res.ok) return
      const data = await res.json() as { attachments: Attachment[] }
      setAccumulatedAttachments(data.attachments)
    } catch { /* ignore */ }
  }, [activeProjectId, pendingSpecId])

  useEffect(() => {
    void refreshAttachments()
  }, [refreshAttachments])

  // Re-fetch when the conversation becomes ready: by then the modal handoff
  // has flushed and any files uploaded in the Add Spec step are guaranteed
  // to be on disk under pendingSpecId/. Cheap belt-and-braces against any
  // mount-time race with the upload's fs sync.
  useEffect(() => {
    if (!conversationId) return
    void refreshAttachments()
  }, [conversationId, refreshAttachments])

  // Bootstrap: start the conversation with the slash-command prefix + idea +
  // initial attachments (folded into Claude's first turn as <user-attachment>
  // text blocks by the server). Skipped when resuming a previously-minimized
  // session — the conversationId is already set from props.
  useEffect(() => {
    if (startedRef.current) return
    if (resumeConversationId) {
      startedRef.current = true
      // Hydrate the conv if it's not already in the chat hook's top-3
      // window — without this the shell stalls on "Starting conversation…"
      // forever because the lookup returns undefined.
      void chat?.hydrateConversation?.(resumeConversationId)
      return
    }
    if (!chat) return
    startedRef.current = true
    if (editTicket) {
      // Edit-existing-ticket mode: do NOT auto-send a bootstrap turn. The
      // draft pane is already pre-filled from the ticket seed, so there's
      // nothing for Claude to "think about" until the user types a real
      // refinement instruction. The first send (handled in sendComposer)
      // wraps the user's text with the ticket context so Claude has what
      // it needs without any silent preamble turn. See design D2.
      return
    }
    const prompt = `/specrails:explore-spec\n\n${initialIdea.trim()}`
    const attachments = initialAttachmentIds.length > 0
      ? { ticketKey: pendingSpecId, ids: initialAttachmentIds }
      : undefined
    void chat.startWithMessage(
      prompt,
      { lightweight: true, maxTurns: 20, attachments },
      initialModel,
      'explore',
      contextScope,
      initialProvider,
    ).then((id) => {
      if (id) setConversationId(id)
    })
  }, [chat, initialIdea, pendingSpecId, initialAttachmentIds, resumeConversationId, initialModel, initialProvider, editTicket, contextScope])

  // Focus restoration on unmount
  useEffect(() => {
    previousFocusRef.current = document.activeElement
    return () => {
      const el = previousFocusRef.current
      if (el && el instanceof HTMLElement) el.focus()
    }
  }, [])

  // Rehydrate composer text from a parked session, once on mount.
  const composerSeededRef = useRef(false)
  useEffect(() => {
    if (composerSeededRef.current) return
    if (!seedComposerText) return
    // Defer one tick so RichAttachmentEditor's contenteditable is ready.
    const t = setTimeout(() => {
      composerRef.current?.setPlainText(seedComposerText)
      setHasComposerText(seedComposerText.trim().length > 0)
      composerSeededRef.current = true
    }, 0)
    return () => clearTimeout(t)
  }, [seedComposerText])

  // Active conversation snapshot (live messages + streaming state)
  const conversation: ChatConversation | undefined = useMemo(() => {
    if (!chat || !conversationId) return undefined
    return chat.conversations.find((c) => c.id === conversationId)
  }, [chat, conversationId])

  const turnCount = conversation?.messages.length ?? 0

  // Char-by-char smoothing: render a steady ~60fps animation over the raw
  // (often bursty) streaming text. Falls back to raw when the feature flag
  // is off. See design.md D8.
  const PREMIUM_UX = ((typeof import.meta !== 'undefined' &&
    (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_FEATURE_EXPLORE_PREMIUM_UX) ?? 'true') !== 'false'
  const smoothed = useSmoothStream(
    conversation?.streamingText ?? '',
    Boolean(conversation?.isStreaming),
  )
  const renderedStream = PREMIUM_UX ? smoothed : (conversation?.streamingText ?? '')

  // Auto-scroll the conversation column to the latest content as messages
  // arrive or the assistant's streaming text grows. Suspended when the user
  // has manually scrolled up beyond the threshold tracked by handleConversationScroll.
  // Uses scrollTop = scrollHeight (instant) during streaming so it keeps up
  // with the char-by-char animation; falls back to smooth on settle.
  useEffect(() => {
    if (userScrolledRef.current) return
    const el = conversationScrollRef.current
    if (!el) return
    if (conversation?.isStreaming || pendingTurn) {
      el.scrollTop = el.scrollHeight
    } else {
      conversationBottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
    }
  }, [turnCount, renderedStream, conversation?.isStreaming, pendingTurn])

  // On mount / navigate-back: jump straight to the bottom so the user lands
  // on the latest message rather than mid-conversation. Two RAFs ensure the
  // bubbles have painted before we measure scrollHeight.
  useEffect(() => {
    userScrolledRef.current = false
    let raf2: number | null = null
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        const el = conversationScrollRef.current
        if (el) el.scrollTop = el.scrollHeight
      })
    })
    return () => {
      cancelAnimationFrame(raf1)
      if (raf2 != null) cancelAnimationFrame(raf2)
    }
    // Only on mount of the shell — intentionally not reacting to turnCount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const {
    draft,
    ready,
    chips,
    lastChangedFields,
    setField,
    clearManualOverrides,
  } = useSpecDraftStream(
    conversationId,
    // Seed the draft pane directly from the ticket in edit mode so the
    // fields are populated on first paint without waiting for WS turns.
    editTicket
      ? {
          title: editTicket.title,
          description: editTicket.description,
          labels: editTicket.labels,
          priority: editTicket.priority ?? 'medium',
          acceptanceCriteria: editTicket.acceptanceCriteria,
        }
      : undefined,
  )

  // Replay parked draft overrides into the stream so user manual edits
  // survive minimize/restore. CRITICAL: only replay fields with meaningful
  // (non-default) values — `setField` marks each replayed field as a
  // manual override, which blocks Claude's WS pushes and the hydration
  // fetch from filling them. Replaying empty defaults would cause
  // description / labels / acceptanceCriteria to permanently appear blank
  // even when the server has the real values from Claude. One-shot per
  // shell instance.
  const draftSeededRef = useRef(false)
  useEffect(() => {
    if (draftSeededRef.current) return
    // Edit mode is seeded directly via useSpecDraftStream's `initialDraft`
    // arg (so the draft pane is populated on first paint, not after a
    // re-render). Only the parked-session replay path is handled here.
    if (editTicket) {
      draftSeededRef.current = true
      return
    }
    if (!seedDraftOverrides) return
    draftSeededRef.current = true
    const o = seedDraftOverrides
    if (o.title && o.title.trim()) setField('title', o.title)
    if (o.description && o.description.trim()) setField('description', o.description)
    if (o.priority && o.priority !== 'medium') setField('priority', o.priority)
    if (o.labels && o.labels.length > 0) setField('labels', o.labels)
    const criteria = o.acceptanceCriteria?.filter((c) => c.trim().length > 0) ?? []
    if (criteria.length > 0) setField('acceptanceCriteria', criteria)
  }, [seedDraftOverrides, setField, editTicket])

  const requestClose = useCallback(() => {
    // Only confirm when the conversation has progressed beyond the initial user idea
    const beyondIntro = turnCount > 1
    if (beyondIntro) {
      setConfirmDiscard(true)
    } else {
      onClose()
    }
  }, [turnCount, onClose])

  const sendComposer = useCallback(async (text: string) => {
    const v = text.trim()
    if (!v || !chat) return
    // Edit-mode first send of this shell session: wrap the user's
    // instruction with the CURRENT ticket context so Claude knows what
    // we're refining (the ticket may have diverged since any resumed
    // conversation history was recorded). Subsequent sends are normal.
    // The wrapper is invisible in the bubble thanks to stripSlashPrefix.
    if (editTicket && !editFirstSendRef.current) {
      editFirstSendRef.current = true
      const attIds = composerRef.current?.getAttachmentIds() ?? []
      composerRef.current?.clear()
      setHasComposerText(false)
      setComposerText('')
      setPendingTurn(true)
      clearManualOverrides()
      const ticketBlock = [
        `## Spec context`,
        `Ticket #${editTicket.id}: ${editTicket.title}`,
        '',
        editTicket.description || '(no description)',
      ].join('\n')
      const prompt = `/specrails:explore-spec\n\n${ticketBlock}\n\n---\n\n## Instruction\n\n${v}`
      const attachments = attIds.length > 0
        ? { ticketKey: pendingSpecId, ids: attIds }
        : undefined
      if (conversation) {
        // We resumed an existing conversation — send the wrapped first turn
        // via sendMessage so we keep the same conversation row + history.
        await chat.sendMessage(conversation.id, prompt, { lightweight: true, maxTurns: 20, attachments })
      } else {
        // No prior conversation — create one with the wrapped turn.
        void chat.startWithMessage(prompt, { lightweight: true, maxTurns: 20, attachments }, initialModel, 'explore', undefined, initialProvider).then((id) => {
          if (id) setConversationId(id)
        })
      }
      return
    }
    if (!conversation || conversation.isStreaming) return
    // Pull current attachments off the editor (rich editor lets the user
    // drop / paste files mid-conversation; each turn carries its own list).
    const attIds = composerRef.current?.getAttachmentIds() ?? []
    composerRef.current?.clear()
    setHasComposerText(false)
    setComposerText('')
    setPendingTurn(true) // optimistic skeleton at T+0
    clearManualOverrides()
    if (attIds.length > 0) {
      // New uploads went into pendingSpecId/, so refresh the accumulated list
      // so the user sees them in the Draft panel right away.
      void refreshAttachments()
    }
    await chat.sendMessage(conversation.id, v, {
      lightweight: true,
      maxTurns: 20,
      attachments: attIds.length > 0 ? { ticketKey: pendingSpecId, ids: attIds } : undefined,
    })
  }, [conversation, chat, clearManualOverrides, pendingSpecId, refreshAttachments, editTicket, initialModel])

  // Clear the optimistic skeleton flag as soon as the real streaming state
  // takes over (or surfaces an error). Without this, the skeleton would
  // double-render alongside the streaming bubble for a frame.
  useEffect(() => {
    if (conversation?.isStreaming) setPendingTurn(false)
  }, [conversation?.isStreaming])

  const submitComposer = useCallback(() => {
    if (conversation?.isStreaming) {
      const canAbort = (conversation.messages?.length ?? 0) > 1
      if (canAbort && chat) void chat.abortStream(conversation.id)
      return
    }
    const text = composerRef.current?.getPlainText().trim() ?? ''
    if (text) void sendComposer(text)
  }, [conversation, chat, sendComposer])

  const handleSaveAsDraft = useCallback(async () => {
    if (!conversationId || !activeProjectId) return false
    try {
      const body: Record<string, unknown> = {
        conversationId,
        title: draft.title?.trim() || undefined,
        description: draft.description || undefined,
        labels: draft.labels,
      }
      if (editTicket) body.editTicketId = editTicket.id
      const res = await fetch(`${getApiBase()}/tickets/save-as-draft`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: string }
        toast.error(err.error || t('shell.toasts.saveDraftFailed'))
        return false
      }
      const data = await res.json() as { ticket: LocalTicket }
      toast.success(t('shell.toasts.draftSaved', { id: data.ticket.id, title: data.ticket.title }))
      return true
    } catch {
      toast.error(t('shell.toasts.draftNetworkError'))
      return false
    }
  }, [conversationId, activeProjectId, draft.title, draft.description, draft.labels, editTicket, t])

  const handleCreate = useCallback(async () => {
    if (isCreating) return
    if (!draft.title.trim() || !activeProjectId) return
    setIsCreating(true)
    // Suppress useTickets' generic "New ticket: ..." toast so only this
    // shell's richer "Spec created — #N TITLE" toast surfaces. Mirrors the
    // Quick-mode flow's behaviour (handled by useSpecGenTracker).
    markSpecGenInFlight(activeProjectId)
    try {
      if (isRealSpecEdit && editTicket) {
        // Edit-an-already-real-spec path: PATCH the ticket in place. Status is
        // NOT included (editing a live spec's text must never accidentally flip
        // its status). Drafts do NOT take this branch — they publish below.
        // See design.md D4+D5.
        const res = await fetch(`${getApiBase()}/tickets/${editTicket.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: draft.title.trim(),
            description: draft.description,
            labels: draft.labels,
            priority: draft.priority,
            acceptanceCriteria: draft.acceptanceCriteria.filter((c) => c.trim().length > 0),
          }),
        })
        if (!res.ok) {
          const err = await res.json().catch(() => ({})) as { error?: string }
          toast.error(err.error || t('shell.toasts.updateSpecFailed'))
          return
        }
        const data = await res.json() as { ticket: LocalTicket }
        toast.success(t('shell.toasts.specUpdated', { id: data.ticket.id, title: data.ticket.title }))
        onTicketCreated?.(data.ticket)
        onClose()
        return
      }
      const res = await fetch(`${getApiBase()}/tickets/from-draft`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: draft.title.trim(),
          description: draft.description,
          labels: draft.labels,
          priority: draft.priority,
          acceptanceCriteria: draft.acceptanceCriteria.filter((c) => c.trim().length > 0),
          // Server migrates pendingSpecId/<id>/* → ticket/<realId>/* so the
          // attachments uploaded during the conversation end up bound to the
          // freshly-created ticket.
          pendingSpecId,
          // Lets the server back-fill ticket_id on prior ai_invocations rows
          // for this conversation, attributing all Explore turns to this ticket.
          conversationId,
          // Publishing a draft opened via Continue Editing: flip THAT specific
          // draft in place to a real spec (status='todo') rather than relying
          // on the conversation-id lookup. editTicket is only set here when it
          // is a draft — real-spec edits took the PATCH branch above.
          ...(editTicket ? { draftTicketId: editTicket.id } : {}),
        }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: string }
        toast.error(err.error || t('shell.toasts.createSpecFailed'))
        return
      }
      const data = await res.json() as { ticket: LocalTicket }
      toast.success(t('shell.toasts.specCreated', { id: data.ticket.id, title: data.ticket.title }))
      onTicketCreated?.(data.ticket)
      onClose()
    } catch (err) {
      toast.error(t('shell.toasts.createNetworkError'))
    } finally {
      setIsCreating(false)
      unmarkSpecGenInFlight(activeProjectId)
    }
  }, [isCreating, draft, activeProjectId, onTicketCreated, onClose, pendingSpecId, editTicket, isRealSpecEdit, conversationId, t])

  // Esc -> request close. (⌘⏎ is handled inside RichAttachmentEditor.)
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault()
        requestClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [requestClose])

  // Push live state up so the parent can auto-minimize this shell when
  // another minimized session is restored (mutual-exclusion rule), and so
  // composer text + draft overrides survive minimize/restore cycles.
  const onStateChangeRef = useRef(onStateChange)
  onStateChangeRef.current = onStateChange
  const [composerText, setComposerText] = useState(seedComposerText ?? '')
  useEffect(() => {
    onStateChangeRef.current?.({
      conversationId,
      draftTitle: draft.title,
      composerText,
      draftOverrides: {
        title: draft.title,
        description: draft.description,
        priority: draft.priority,
        labels: draft.labels,
        acceptanceCriteria: draft.acceptanceCriteria,
      },
    })
  }, [conversationId, draft.title, draft.description, draft.priority, draft.labels, draft.acceptanceCriteria, composerText])

  const macPadLeft = isMacTauriOverlay() ? 'pl-[88px]' : 'pl-4'

  return (
    <div
      className="fixed inset-0 z-50 flex p-3 pt-10 sm:p-6 sm:pt-12 bg-black/40 backdrop-blur-sm animate-in fade-in duration-150"
      data-testid="explore-spec-backdrop"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('shell.dialogAriaLabel')}
        className="m-auto w-full h-full max-w-[1600px] flex flex-col bg-background rounded-xl border border-border/40 shadow-2xl overflow-hidden"
      >
      {/* Header */}
      <div className={`flex-shrink-0 flex items-center justify-between ${macPadLeft} pr-4 h-14 border-b border-border bg-card/60 backdrop-blur-sm`}>
        <button
          type="button"
          onClick={requestClose}
          className="flex items-center gap-2 group p-1 -ml-1 rounded hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:outline-none"
          aria-label={t('shell.backAriaLabel')}
        >
          <ArrowLeft className="w-4 h-4 text-muted-foreground group-hover:text-foreground" />
          <div className="text-left min-w-0">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground/70 leading-none">
              {editTicket ? t('shell.editingEyebrow', { id: editTicket.id }) : t('shell.exploreEyebrow')}
            </div>
            <span className="text-sm font-medium text-foreground truncate block">
              {draft.title || seedDraftTitle || t('shell.newSpecPlaceholder')}
            </span>
          </div>
        </button>
        <div className="flex items-center gap-2">
          {contextScope ? (
            <span
              data-testid="explore-context-pill"
              title={t('shell.contextPillTitle')}
              className="hidden md:inline-flex items-center gap-1 px-2 py-1 rounded-full border border-border/50 bg-card/60 text-[10px] text-muted-foreground"
            >
              {t('shell.contextPill', {
                scopes: [
                  contextScope.specrails && 'specrails',
                  contextScope.openspec && 'openspec',
                  contextScope.full && t('shell.contextScopeCodebase'),
                  contextScope.mcp && 'mcp',
                ].filter(Boolean).join(', ') || t('shell.contextScopeMinimal'),
              })}
            </span>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            onClick={async () => {
              const ok = await handleSaveAsDraft()
              if (ok) onClose()
            }}
            disabled={turnCount < 2 || isCreating}
            className="gap-1.5"
            aria-label={t('shell.saveAsDraftAriaLabel')}
            data-testid="explore-spec-save-draft"
            title={turnCount < 2 ? t('shell.saveAsDraftDisabledTitle') : undefined}
          >
            {t('shell.saveAsDraft')}
          </Button>
          {REVIEW_ENABLED && draft.title.trim() && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setReviewOpen(true)}
              disabled={isCreating}
              className="gap-1.5"
              aria-label={t('shell.reviewAriaLabel')}
              data-testid="explore-spec-review"
            >
              {t('shell.review')}
            </Button>
          )}
          {jira.connected && !isRealSpecEdit && (
            <span
              className="inline-flex items-center gap-1.5 text-[11px] text-accent-info mr-1"
              data-testid="jira-create-indicator"
              title={tj('addSpec.willCreate', { key: jira.jiraProjectKey ?? '' })}
            >
              <Plug className="w-3 h-3 shrink-0" />
              <span className="hidden lg:inline">{tj('addSpec.willCreate', { key: jira.jiraProjectKey ?? '' })}</span>
            </span>
          )}
          <Button
            size="sm"
            onClick={handleCreate}
            disabled={!draft.title.trim() || isCreating}
            className="gap-1.5"
            aria-label={isRealSpecEdit ? t('shell.updateSpecAriaLabel') : t('shell.createSpecAriaLabel')}
            data-testid="explore-spec-create"
            title={!draft.title.trim() ? t('shell.createSpecDisabledTitle') : undefined}
          >
            {isCreating ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : ready ? (
              <Sparkles className="w-3.5 h-3.5" />
            ) : (
              <Check className="w-3.5 h-3.5" />
            )}
            {isRealSpecEdit ? t('shell.updateSpec') : t('shell.createSpec')}
          </Button>
          {onMinimize && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onMinimize(conversationId, draft.title || seedDraftTitle || '')}
              aria-label={t('common:actions.minimize')}
              data-testid="explore-spec-minimize"
            >
              <Minus className="w-4 h-4" />
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={requestClose} aria-label={t('common:actions.close')}>
            <X className="w-4 h-4" />
          </Button>
        </div>
      </div>

      {/* Body: conversation left, draft right */}
      <div className="flex-1 min-h-0 grid grid-cols-[1fr_360px] divide-x divide-border/40">
        {/* Conversation column */}
        <div className="flex flex-col min-h-0">
          <div
            ref={conversationScrollRef}
            onScroll={handleConversationScroll}
            className="flex-1 overflow-y-auto px-5 py-4 pb-24 space-y-3"
            data-testid="explore-conversation"
          >
            {!conversation && editTicket && (
              <div className="text-xs text-muted-foreground/70 italic px-1 py-2">
                {t('shell.editModeIntro')}
              </div>
            )}
            {!conversation && !editTicket && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="w-4 h-4 animate-spin" />
                {t('shell.startingConversation')}
              </div>
            )}
            {conversation?.messages.map((m, i) => (
              <TurnBubble key={i} role={m.role} content={m.content} timestamp={m.created_at} provider={conversation?.provider} />
            ))}
            {(pendingTurn || conversation?.isStreaming) && (
              conversation?.streamingText
                ? <TurnBubble role="assistant" content={renderedStream} streaming provider={conversation?.provider} />
                : (
                  <div className="px-5 pb-1">
                    <ExploreStatusPills
                      active
                      hasSystemEvent={Boolean(conversation?.isStreaming)}
                      hasToolUse={false}
                      hasText={false}
                    />
                  </div>
                )
            )}
            <div ref={conversationBottomRef} />
          </div>

          {/* Chips */}
          {chips.length > 0 && conversation && !conversation.isStreaming && (
            <div role="group" aria-label={t('shell.suggestedRepliesAriaLabel')} className="flex-shrink-0 flex gap-1.5 px-5 pb-2 flex-wrap">
              {chips.map((chip) => (
                <button
                  key={chip}
                  type="button"
                  onClick={() => sendComposer(chip)}
                  className="text-[11px] px-2.5 py-1 rounded-full border border-border/60 bg-card/40 hover:bg-card/80 hover:border-primary/40 transition-colors"
                >
                  {chip}
                </button>
              ))}
            </div>
          )}

          {/* Composer with attachments (drag-drop, paste, click). The pending
              spec id is the same one used in the Add Spec modal so attachments
              uploaded there are visible here, and any new ones drop into the
              same dir. The server migrates everything to the real ticket id
              when the user clicks Create Spec. */}
          <div className="flex-shrink-0 px-5 py-3 border-t border-border/40 bg-card/30">
            <RichAttachmentEditor
              ref={composerRef}
              ticketKey={pendingSpecId}
              placeholder={conversation?.isStreaming ? '' : t('shell.composerPlaceholder')}
              minHeight={72}
              ariaLabel={t('shell.composerAriaLabel')}
              onChange={() => {
                const text = composerRef.current?.getPlainText() ?? ''
                setHasComposerText(text.length > 0)
                setComposerText(text)
              }}
              onUnsupportedFile={(f) => toast.error(t('shell.toasts.unsupportedFileType', { name: f.name }))}
              onUploadError={(err, f) => toast.error(t('shell.toasts.uploadFailed', { name: f.name, message: err.message }))}
              onAttachmentRemoved={(a) => {
                fetch(`${API_ORIGIN}/api/projects/${activeProjectId}/tickets/${pendingSpecId}/attachments/${a.id}`, { method: 'DELETE' }).catch(() => {})
                // Drop from the accumulated list immediately so the panel
                // does not show a stale entry.
                setAccumulatedAttachments((prev) => prev.filter((x) => x.id !== a.id))
              }}
              onAttachmentAdded={() => {
                // New file uploaded into pendingSpecId/; reflect it in the
                // Draft panel without waiting for a turn submit.
                void refreshAttachments()
              }}
              onSubmit={submitComposer}
            />
            <div className="flex items-center justify-between mt-2 gap-3">
              <span />
              {/* Streaming indicator removed — ExploreStatusPills covers this state. */}
              {conversation?.isStreaming && turnCount > 1 ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    if (conversation && chat) void chat.abortStream(conversation.id)
                  }}
                  className="gap-1.5 text-destructive hover:text-destructive"
                  data-testid="explore-stop-button"
                >
                  {t('shell.stop')}
                  <span className="text-[10px] opacity-70 ml-1">⌘⏎</span>
                </Button>
              ) : (
                <Button
                  size="sm"
                  onClick={submitComposer}
                  disabled={!hasComposerText || (!conversation && !editTicket) || pendingTurn}
                  className="gap-1.5"
                >
                  <Send className="w-3.5 h-3.5" />
                  {t('shell.send')}
                  <span className="text-[10px] opacity-70 ml-1">⌘⏎</span>
                </Button>
              )}
            </div>
          </div>
        </div>

        {/* Draft column — breathes subtly while assistant is thinking so the
            user knows the panel will update once the turn settles. */}
        <div className={`relative min-h-0 transition-opacity duration-500 ${conversation?.isStreaming ? 'opacity-90' : 'opacity-100'}`}>
          {conversation?.isStreaming && (
            <div className="absolute top-0 inset-x-0 h-0.5 overflow-hidden pointer-events-none z-10">
              <div className="h-full bg-primary/40 animate-pulse" />
            </div>
          )}
          <SpecDraftPanel
            draft={draft}
            ready={ready}
            flashFields={lastChangedFields}
            onFieldChange={setField}
            attachments={accumulatedAttachments}
            onRemoveAttachment={async (id) => {
              try {
                await fetch(`${API_ORIGIN}/api/projects/${activeProjectId}/tickets/${pendingSpecId}/attachments/${id}`, { method: 'DELETE' })
              } catch { /* ignore */ }
              setAccumulatedAttachments((prev) => prev.filter((a) => a.id !== id))
            }}
          />
        </div>
      </div>

      {/* Close prompt — Save as Draft / Discard / Cancel */}
      <Dialog open={confirmDiscard} onOpenChange={(o) => !o && setConfirmDiscard(false)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('shell.closePrompt.title')}</DialogTitle>
            <DialogDescription>
              {t('shell.closePrompt.description')}
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2 mt-2">
            <Button variant="ghost" size="sm" onClick={() => setConfirmDiscard(false)} data-testid="close-prompt-cancel">
              {t('common:actions.cancel')}
            </Button>
            <Button variant="destructive" size="sm" onClick={onClose} data-testid="close-prompt-discard">
              {t('common:actions.discard')}
            </Button>
            <Button
              size="sm"
              onClick={async () => {
                const ok = await handleSaveAsDraft()
                setConfirmDiscard(false)
                if (ok) onClose()
              }}
              autoFocus
              data-testid="close-prompt-save-draft"
            >
              {t('shell.saveAsDraft')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      </div>
      {REVIEW_ENABLED && reviewOpen && (
        <ExploreReviewOverlay
          baseline={editTicket
            ? {
                title: editTicket.title,
                description: editTicket.description,
                labels: editTicket.labels,
                priority: editTicket.priority,
                acceptanceCriteria: editTicket.acceptanceCriteria,
              }
            : EMPTY_REVIEW_BASELINE}
          proposed={{
            title: draft.title ?? '',
            description: draft.description ?? '',
            labels: draft.labels ?? [],
            priority: draft.priority ?? null,
            acceptanceCriteria: draft.acceptanceCriteria ?? [],
          } satisfies ReviewProposed}
          mode={isRealSpecEdit ? 'edit' : 'create'}
          isCommitting={isCreating}
          onBack={() => setReviewOpen(false)}
          onCommit={async () => {
            await handleCreate()
            setReviewOpen(false)
          }}
        />
      )}
    </div>
  )
}

/** Hide the leading `/specrails:explore-spec` command from the visible content
 * so the user sees only their idea. The prefix is sent for Claude's benefit
 * (slash-command resolution); displaying it in the chat is noise.
 *
 * Edit-mode first turn additionally wraps the user's instruction with a
 * `## Spec context` block carrying the ticket payload (for Claude only).
 * This strip removes the wrapper so the visible bubble shows only the
 * user's actual instruction. */
function stripSlashPrefix(content: string): string {
  let working = content.trimStart()
  if (working.startsWith('/specrails:explore-spec')) {
    const idx = working.indexOf('\n')
    if (idx === -1) return ''
    working = working.slice(idx + 1).replace(/^\s+/, '')
  }
  // Edit-mode: strip the ticket-context block we attached server-side so the
  // user sees only their instruction.
  const editMarker = '## Instruction\n\n'
  if (working.startsWith('## Spec context')) {
    const i = working.indexOf(editMarker)
    if (i !== -1) {
      return working.slice(i + editMarker.length).trimStart()
    }
  }
  return working
}

function formatChatTime(iso?: string): string | null {
  if (!iso) return null
  const d = new Date(iso)
  if (isNaN(d.getTime())) return null
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function TurnBubble({ role, content, streaming, timestamp, provider }: { role: 'user' | 'assistant' | 'system'; content: string; streaming?: boolean; timestamp?: string; provider?: string | null }) {
  const { t } = useTranslation('explore')
  if (role === 'system') return null
  const isUser = role === 'user'
  const visible = isUser ? stripSlashPrefix(content) : content
  if (!visible.trim() && !streaming) return null
  const timeLabel = formatChatTime(timestamp)
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${isUser ? 'bg-primary/10 text-foreground' : 'bg-card/60 border border-border/40'}`}>
        <div className="flex items-baseline justify-between gap-3 mb-1">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground/60 font-semibold">
            {isUser ? t('shell.you') : providerLabel(provider)}
          </div>
          {timeLabel && (
            <div className="text-[10px] text-muted-foreground/50 font-mono tabular-nums">
              {timeLabel}
            </div>
          )}
        </div>
        {isUser ? (
          <div className="whitespace-pre-wrap break-words">
            {visible}
            {streaming && <span className="inline-block w-1 h-3 bg-primary/60 ml-0.5 animate-pulse align-baseline" />}
          </div>
        ) : (
          <div className={[
            'prose prose-sm max-w-none break-words',
            // Force prose body / paragraph / list colors to the theme's
            // foreground so light theme renders dark text, dark theme renders
            // light text. `prose-invert` (dark-mode prose) is intentionally
            // NOT applied — it broke contrast under the light theme.
            'text-foreground',
            '[&_p]:text-foreground [&_li]:text-foreground',
            '[&_p]:my-1.5 [&_ul]:my-1.5 [&_ol]:my-1.5 [&_li]:my-0.5',
            '[&_p:first-child]:mt-0 [&_p:last-child]:mb-0',
            // Bolded prose gets the accent colour — keeps Claude's emphasis
            // visible and on-brand across themes.
            '[&_strong]:text-accent-primary [&_strong]:font-semibold',
            '[&_code]:rounded [&_code]:bg-background/60 [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-accent-primary [&_code]:text-[12px]',
            '[&_pre]:rounded [&_pre]:bg-background/60 [&_pre]:p-2 [&_pre]:my-2',
            '[&_pre_code]:bg-transparent [&_pre_code]:p-0',
            '[&_a]:text-accent-primary [&_a]:underline',
            '[&_h1]:text-foreground [&_h2]:text-foreground [&_h3]:text-foreground',
            '[&_h1]:text-base [&_h2]:text-sm [&_h3]:text-sm [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-semibold',
          ].join(' ')}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{visible}</ReactMarkdown>
            {streaming && <span className="inline-block w-1 h-3 bg-primary/60 ml-0.5 animate-pulse align-baseline" />}
          </div>
        )}
      </div>
    </div>
  )
}
