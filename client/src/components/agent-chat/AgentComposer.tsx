import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { SendHorizontal, History, Square, X, Check, Pencil, Bot, Gauge, Terminal } from 'lucide-react'
import { useAgentChat } from '../../context/AgentChatContext'
import { useAgentWorkspace } from '../../context/AgentWorkspaceContext'
import { useBackgroundProcesses } from '../../context/BackgroundProcessesContext'
import { useDesktop } from '../../hooks/useDesktop'
import { blockMissionTransfer } from '../../lib/mission-view-state'
import { useMissionWindows } from '../../context/MissionWindowsContext'
import { API_ORIGIN } from '../../lib/origin'
import { uploadAgentAttachment, deleteAgentAttachment, type AgentAttachment } from '../../lib/agent-api'
import {
  recoverComposerDraft,
  composerSubmissionIds,
  composerDrafts,
  composerAttachmentDrafts,
  composerReferenceDrafts,
  migrateNewMissionComposerDrafts,
  useComposerDraftRevision,
  writeComposerDraft,
  setComposerAttachments,
  setComposerSubmission,
  clearSubmittedComposerDraft,
  restoreSubmittedComposerDraft,
  NEW_MISSION_DRAFT_KEY,
  type AgentComposerDraftSnapshot,
} from '../../lib/agent-composer-drafts'
import { isBrowserCaptureEnabled } from '../../lib/browser-capture'
import { AgentComposerAttachmentChip } from './AgentComposerAttachmentChip'
import {
  buildPaletteItems,
  discoveredFileItems,
  buildNoResultPaletteItems,
  chipKey,
  detectAgentPaletteTrigger,
  filterPaletteItems,
  insertPaletteSelection,
  toContextReference,
  type AgentPaletteItem,
  type AgentPaletteMode,
  type AgentPaletteTrigger,
} from '../../lib/agent-context-palette'
import type { BackgroundProcess, JobSummary, LocalTicket } from '../../types'
import { AgentProjectSelector } from './AgentProjectSelector'
import { AgentTierChip } from './AgentTierChip'
import { AgentModelSelector } from './AgentModelSelector'
import { AgentToolbarSelector } from './AgentToolbarSelector'
import { useAgentProviderCatalog } from './useAgentProviderCatalog'
import { AgentGitBar } from './AgentGitBar'
import { AgentContextPalette, AgentPlusMenu } from './AgentContextPalette'
import { AgentComposerEditor, type AgentComposerEditorHandle, type AgentInlineReference } from './AgentComposerEditor'
import { BackgroundProcessChip, isBackgroundProcessFinished, type BackgroundProcessAccent } from '../BackgroundProcessChip'
import { BackgroundProcessLogsModal } from '../BackgroundProcessLogsModal'
import { BackgroundProcessHistoryModal } from '../BackgroundProcessHistoryModal'
import { backgroundProcessKey } from '../../lib/background-processes-api'
import { useAvailableProviders } from '../../hooks/useAvailableProviders'
import { reasoningEffortsForProvider, defaultReasoningEffortForProvider } from '../../lib/provider-capabilities'

function replaceInlineRange(
  text: string,
  references: AgentInlineReference[],
  start: number,
  end: number,
  replacement: string,
): { text: string; references: AgentInlineReference[] } {
  const delta = replacement.length - (end - start)
  return {
    text: `${text.slice(0, start)}${replacement}${text.slice(end)}`,
    references: references.flatMap(ref => {
      if (ref.end <= start) return [ref]
      if (ref.start >= end) return [{ ...ref, start: ref.start + delta, end: ref.end + delta }]
      return [] // A replaced selection also removes the references it covered.
    }),
  }
}

// Session-scoped composer drafts — shared store in lib/agent-composer-drafts
// (AgentChatContext.materializeDraftConversation migrates the new-mission slot
// there, so externally-triggered materialization — e.g. a browser capture on
// the empty compose screen — never loses the typed draft).
export { __clearComposerDrafts } from '../../lib/agent-composer-drafts'

// Stable empties: the composer reads these straight out of the store during
// render, so a fresh [] per render would churn every memo and effect that
// depends on the reference list or the attachment list.
const EMPTY_REFERENCES: AgentInlineReference[] = []
const EMPTY_ATTACHMENTS: AgentAttachment[] = []

/**
 * Shared agent composer — controls row (project · provider · model · effort · tier),
 * prompt-history editor, send/stop. Context-driven so the floating panel and
 * the inline Agent-Mode surface render the exact same input (attachment parity
 * lands here in a later phase). The project selector is re-homed here so it
 * survives in both variants.
 */
export function AgentComposer({
  autoFocus = false,
  hideProjectSelector = false,
  queueEditRequest,
}: {
  autoFocus?: boolean
  /** Kanban floating panel: its window header carries the project selector
   *  (next to the Agent title), so the composer's own copy is hidden. Agent
   *  Mode keeps the composer selector on the EMPTY compose screen. */
  hideProjectSelector?: boolean
  queueEditRequest?: { conversationId: string; queueId: string; revision: number }
}) {
  const { t } = useTranslation('agent')
  const {
    active, messages, conversations, isStreaming, providersReady, draftPinnedProjectId,
    draftProvider, draftModel, draftTierLevel, draftEffort, setEffort,
    send, abort, cycleTier, setProvider, setModel, setPinnedProject, materializeDraftConversation,
    queuedMessages: allQueuedMessages, editQueuedMessage, wasQueueConsumed,
  } = useAgentChat()
  const queuedMessages = useMemo(() => allQueuedMessages.filter((item) => item.deliveryMode !== 'steer'), [allQueuedMessages])
  const { pendingCaptures, consumePendingCaptures, openBrowser } = useAgentWorkspace()
  const { processes: backgroundProcesses, history: backgroundProcessHistory = backgroundProcesses, historyLoading = false, historyError = null, refreshHistory, kill: killBackgroundProcess } = useBackgroundProcesses()
  const [selectedProcess, setSelectedProcess] = useState<BackgroundProcess | null>(null)
  const [processHistoryScope, setProcessHistoryScope] = useState<{ chatId: string; projectId: string } | null>(null)
  const compactProcesses = useMemo(() => [...backgroundProcesses].sort((a, b) => Number(isBackgroundProcessFinished(a)) - Number(isBackgroundProcessFinished(b)) || b.startedAt - a.startedAt).slice(0, 4), [backgroundProcesses])
  const { projects, activeProjectId } = useDesktop()
  const backgroundProjectId = active?.pinned_project_id ?? draftPinnedProjectId ?? activeProjectId
  const draftKey = active?.id ?? NEW_MISSION_DRAFT_KEY
  const missionWindows = useMissionWindows()
  const recoveredKey = useRef<string | null>(null)
  if (recoveredKey.current !== draftKey) {
    recoverComposerDraft(draftKey)
    recoveredKey.current = draftKey
  }
  // The composer UNMOUNTS mid-send (the EMPTY→ACTIVE branch swap in
  // AgentModeSurface, the `active?.id` remount key in AgentConversationView),
  // so what is on screen must come from the SHARED store rather than from state
  // seeded at mount: a clear issued by an instance that is already gone still
  // has to reach whichever composer replaced it.
  useComposerDraftRevision(draftKey)
  // Queue-edit shows a QUEUED message, deliberately outside the draft store
  // (the store keeps holding the real draft as the stash). It is the one local
  // override of the stored value, and it belongs to the key it was opened on.
  const [queueEdit, setQueueEdit] = useState<{ key: string; queueId: string; text: string } | null>(null)
  const activeQueueEdit = queueEdit && queueEdit.key === draftKey ? queueEdit : null
  const input = activeQueueEdit ? activeQueueEdit.text : composerDrafts.get(draftKey) ?? ''
  const inlineReferences = activeQueueEdit ? EMPTY_REFERENCES : composerReferenceDrafts.get(draftKey) ?? EMPTY_REFERENCES
  const attached = composerAttachmentDrafts.get(draftKey) ?? EMPTY_ATTACHMENTS
  // Every keystroke mirrors into the session draft store so an unmount
  // (mode switch, panel close) never loses a typed-but-unsent prompt.
  const setInput = (v: string, refs: AgentInlineReference[] = []): void => writeComposerDraft(draftKey, v, refs)
  const [histIndex, setHistIndex] = useState<number | null>(null)
  const setAttachmentDraft = (
    key: string,
    updater: AgentAttachment[] | ((prev: AgentAttachment[]) => AgentAttachment[]),
  ): void => {
    const prev = composerAttachmentDrafts.get(key) ?? EMPTY_ATTACHMENTS
    setComposerAttachments(key, typeof updater === 'function' ? updater(prev) : updater)
  }
  const [uploading, setUploading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const submittingRef = useRef(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const editorRef = useRef<AgentComposerEditorHandle | null>(null)
  // Keep each occurrence in the editor, but send entity metadata once. Scope
  // participates in identity so equal spec IDs in different projects differ.
  const contextChips = useMemo(() => [...new Map(inlineReferences.map(({ chip }) =>
    [JSON.stringify([chip.projectId, chipKey(chip)]), chip],
  )).values()], [inlineReferences])
  const [paletteTrigger, setPaletteTrigger] = useState<AgentPaletteTrigger | null>(null)
  const [activePaletteIndex, setActivePaletteIndex] = useState(0)
  const [plusOpen, setPlusOpen] = useState(false)
  const [scopedTickets, setScopedTickets] = useState<LocalTicket[]>([])
  const [scopedJobs, setScopedJobs] = useState<JobSummary[]>([])
  const inHistory = histIndex !== null
  const history = useMemo(
    () => messages.filter((m) => m.role === 'user').map((m) => m.content),
    [messages],
  )
  // ── Queue-edit mode (↑/↓ navigate queued messages, edit in place) ──────────
  // While ≥1 message is parked behind the in-flight turn, the arrows drive the
  // QUEUE, not the prompt history: "the last thing we wrote" is the queued
  // message, so ↑ recalls it for in-place editing. History nav resumes as soon
  // as the queue drains. Tracked by queueId (indices shift as the head drains).
  const editingQueueId = activeQueueEdit?.queueId ?? null
  // The slot's text at selection time: dirty-detection that survives the slot
  // vanishing mid-edit (drain race).
  const editBaseTextRef = useRef('')
  const editIdx = editingQueueId === null ? -1 : queuedMessages.findIndex((q) => q.queueId === editingQueueId)
  const editingItem = editIdx >= 0 ? queuedMessages[editIdx] : null
  const inQueueEdit = activeQueueEdit !== null
  useEffect(() => {
    if (uploading || submitting || inQueueEdit) return blockMissionTransfer(draftKey)
  }, [draftKey, uploading, submitting, inQueueEdit])
  const blocked = providersReady === false || (active ? !missionWindows.isEditable(active.id) : !!missionWindows.current)
  // Attachments upload to a conversation-keyed endpoint. On the EMPTY compose
  // screen we materialise the draft conversation just before the upload.
  const canAttach = !blocked && !inQueueEdit
  const provider = active?.provider ?? draftProvider
  const { availableIds: discoveredProviders } = useAvailableProviders()
  const selectableProviders = useMemo(
    () => [provider, ...discoveredProviders].filter((id, index, all) => all.indexOf(id) === index),
    [provider, discoveredProviders],
  )
  // The git strip follows the MISSION's pinned project (or the draft pin on the
  // EMPTY compose screen) — never the app's active project.
  const gitProjectId = active ? active.pinned_project_id : draftPinnedProjectId
  const pinnedProjectId = gitProjectId

  const fileQuery = paletteTrigger?.mode === 'reference' ? paletteTrigger.query.trim() : ''
  const fileQueryKey = `${pinnedProjectId ?? ''}:${fileQuery}`
  const [fileResults, setFileResults] = useState<{ key: string; items: AgentPaletteItem[] }>({ key: '', items: [] })
  useEffect(() => {
    const project = projects.find((item) => item.id === pinnedProjectId)
    if (!project || fileQuery.length < 2) return
    const request = new AbortController()
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ kind: 'find', q: fileQuery, limit: '20' })
      void fetch(`${API_ORIGIN}/api/projects/${encodeURIComponent(project.id)}/code/discover?${params}`, { signal: request.signal })
        .then(async (response) => {
          if (!response.ok) return
          const data = await response.json() as { matches?: Array<{ path: string; repositoryId: string; repositoryName: string }> }
          if (!request.signal.aborted) setFileResults({ key: fileQueryKey, items: discoveredFileItems(project, data.matches ?? []) })
        }).catch(() => { /* Local palette entries remain available. */ })
    }, 180)
    return () => { clearTimeout(timer); request.abort() }
  }, [pinnedProjectId, projects, fileQuery, fileQueryKey])

  const paletteSource = useMemo(() => ({
    projects,
    conversations,
    activeConversation: active,
    pinnedProjectId,
    activeProjectId,
    tickets: scopedTickets,
    jobs: scopedJobs,
    chips: contextChips,
  }), [projects, conversations, active, pinnedProjectId, activeProjectId, scopedTickets, scopedJobs, contextChips])
  const paletteItems = useMemo(
    () => (paletteTrigger ? [...buildPaletteItems(paletteTrigger.mode, paletteSource), ...(paletteTrigger.mode === 'reference' && fileQuery.length >= 2 && fileResults.key === fileQueryKey ? fileResults.items : [])] : []),
    [paletteTrigger, paletteSource, fileResults, fileQueryKey, fileQuery],
  )
  const visiblePaletteItems = useMemo(
    () => {
      if (!paletteTrigger) return []
      const filtered = filterPaletteItems(paletteItems, paletteTrigger.query)
      if (filtered.length > 0) return filtered
      return buildNoResultPaletteItems(paletteTrigger.mode, paletteTrigger.query)
    },
    [paletteItems, paletteTrigger],
  )
  const paletteOpen = paletteTrigger !== null && !inQueueEdit
  const hasDraft = input.trim().length > 0 || contextChips.length > 0
  const backgroundAccentVariants: BackgroundProcessAccent[] = ['accent-primary', 'accent-info', 'accent-highlight']

  const activeId = active?.id ?? null
  useEffect(() => { setSelectedProcess(null); setProcessHistoryScope(null) }, [activeId, backgroundProjectId])
  // The composer survives conversation switches (no key/remount): pending chips
  // are keyed to the conversation they were uploaded to (foreign ids silently
  // no-op server-side) and a stale histIndex could index past the new history.
  useEffect(() => {
    setHistIndex(null)
    setPaletteTrigger(null)
    setPlusOpen(false)
    // A queue-edit in progress belongs to the previous conversation — drop it
    // (the queued message is untouched server-side; the draft store still holds
    // the stashed draft, which the subscribed read below restores by itself).
    setQueueEdit(null)
  }, [activeId])

  useEffect(() => {
    if (!pinnedProjectId) {
      setScopedTickets([])
      setScopedJobs([])
      return
    }
    let alive = true
    const loadScopedContext = async (): Promise<void> => {
      try {
        const [ticketsRes, jobsRes] = await Promise.all([
          fetch(`${API_ORIGIN}/api/projects/${encodeURIComponent(pinnedProjectId)}/tickets`),
          fetch(`${API_ORIGIN}/api/projects/${encodeURIComponent(pinnedProjectId)}/jobs?limit=25`),
        ])
        const ticketsJson = await ticketsRes.json() as { tickets?: LocalTicket[] }
        const jobsJson = await jobsRes.json() as { jobs?: JobSummary[] }
        if (!alive) return
        setScopedTickets(Array.isArray(ticketsJson.tickets) ? ticketsJson.tickets : [])
        setScopedJobs(Array.isArray(jobsJson.jobs) ? jobsJson.jobs : [])
      } catch {
        if (!alive) return
        setScopedTickets([])
        setScopedJobs([])
      }
    }
    void loadScopedContext()
    return () => { alive = false }
  }, [pinnedProjectId])

  useEffect(() => {
    setActivePaletteIndex(0)
  }, [paletteTrigger?.mode, paletteTrigger?.query])

  useEffect(() => {
    if (activePaletteIndex >= visiblePaletteItems.length) {
      setActivePaletteIndex(Math.max(0, visiblePaletteItems.length - 1))
    }
  }, [activePaletteIndex, visiblePaletteItems.length])

  // Browser captures land as already-uploaded agent attachments — adopt them as
  // chips so they ride the next manual send.
  useEffect(() => {
    if (pendingCaptures.length === 0) return
    const captured = consumePendingCaptures()
    if (captured.length) setAttachmentDraft(draftKey, (prev) => [...prev, ...captured])
  }, [pendingCaptures, consumePendingCaptures, draftKey])

  // A single provider-tagged request owns models, effort tiers and image
  // capability. Tagging prevents one render of stale options after a switch.
  const providerCatalog = useAgentProviderCatalog(provider)
  const {
    models,
    efforts: providerEfforts,
    supportsImageInput: supportsImage,
    customModelAliases,
  } = providerCatalog
  const configuredModel = active ? active.model : draftModel
  const effectiveModel =
    configuredModel ?? models.find((entry) => entry.default)?.value ?? models[0]?.value ?? ''
  const modelEfforts = reasoningEffortsForProvider(provider, effectiveModel)
  // The server catalog remains authoritative; the client model gate narrows it
  // immediately on model switches without another request.
  const efforts = providerEfforts.filter((level) =>
    (modelEfforts as readonly string[]).includes(level),
  )
  const configuredEffort = active ? active.reasoning_effort : draftEffort
  // No stored effort ⇒ show the provider default the SERVER already applies at
  // spawn (defaultReasoningEffortForModel: medium → high → first) instead of an
  // empty selector — display-only, the send path is unchanged.
  const effort =
    configuredEffort && efforts.includes(configuredEffort)
      ? configuredEffort
      : defaultReasoningEffortForProvider(provider, effectiveModel) ?? ''

  /** The migration itself notifies both keys, so every mounted composer follows. */
  const adoptNewMissionDrafts = (conversationId: string): void => {
    migrateNewMissionComposerDrafts(conversationId)
  }

  const uploadFiles = async (files: File[]) => {
    if (files.length === 0) return
    setUploading(true)
    let conversation = active
    if (!conversation) {
      try {
        conversation = await materializeDraftConversation()
        adoptNewMissionDrafts(conversation.id)
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t('workspace.uploadFailed'))
        setUploading(false)
        return
      }
    }
    for (const f of files) {
      if (!supportsImage && f.type.startsWith('image/')) {
        toast.error(t('imagesUnsupported'))
        continue
      }
      try {
        const att = await uploadAgentAttachment(conversation.id, f)
        setAttachmentDraft(conversation.id, (prev) => [...prev, att])
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t('workspace.uploadFailed'))
      }
    }
    setUploading(false)
  }
  const removeAttachment = async (id: string) => {
    try {
      if (active) await deleteAgentAttachment(active.id, id)
      setAttachmentDraft(draftKey, (prev) => prev.filter((a) => a.id !== id))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to remove attachment.')
    }
  }

  const syncPalette = (text: string, caret: number, references = inlineReferences): void => {
    if (references.some(ref => caret > ref.start && caret <= ref.end)) {
      setPaletteTrigger(null)
      return
    }
    const trigger = detectAgentPaletteTrigger(text, caret)
    setPaletteTrigger(trigger)
    if (trigger) setPlusOpen(false)
  }
  const triggerForMode = (mode: AgentPaletteMode): AgentPaletteTrigger['trigger'] => (
    mode === 'reference' ? '@' : mode === 'trace' ? '#' : '/'
  )
  const focusEditorAt = (caret: number): void => {
    requestAnimationFrame(() => {
      editorRef.current?.focus()
      editorRef.current?.setSelectionRange(caret, caret)
    })
  }
  const openPaletteMode = (mode: AgentPaletteMode): void => {
    if (inQueueEdit) return
    const trigger = triggerForMode(mode)
    const el = editorRef.current
    const start = el?.selectionStart ?? input.length
    const end = el?.selectionEnd ?? start
    const next = replaceInlineRange(input, inlineReferences, start, end, trigger)
    setInput(next.text, next.references)
    setHistIndex(null)
    setPlusOpen(false)
    setPaletteTrigger({ mode, trigger, query: '', start, end: start + 1 })
    focusEditorAt(start + 1)
  }
  const selectPaletteItem = (item: AgentPaletteItem): void => {
    // Palette buttons can own focus when invoked with assistive technology or
    // the + menu. Restore the editable surface before its undoable insertion.
    editorRef.current?.focus()
    const next = insertPaletteSelection(input, paletteTrigger, item)
    const start = paletteTrigger?.start ?? input.length
    const end = paletteTrigger?.end ?? start
    const replacement = next.text.slice(start, next.caret)
    const { references } = replaceInlineRange(input, inlineReferences, start, end, replacement)
    if (item.chip) {
      const tokenStart = start + replacement.indexOf(item.chip.token)
      references.push({ key: crypto.randomUUID(), start: tokenStart, end: tokenStart + item.chip.token.length, chip: item.chip })
      references.sort((a, b) => a.start - b.start)
    }
    setInput(next.text, references)
    setHistIndex(null)
    setPaletteTrigger(null)
    setPlusOpen(false)
    focusEditorAt(next.caret)
  }

  // ── Queue-edit helpers ──────────────────────────────────────────────────────
  /** Show one queue slot in the composer (entry point and ↑/↓ moves). */
  const selectQueueSlot = (i: number): void => {
    const item = queuedMessages[i]
    if (!item) return
    editBaseTextRef.current = item.text
    // NOT setInput — the draft store keeps holding the real draft as the stash.
    setQueueEdit({ key: draftKey, queueId: item.queueId, text: item.text })
  }
  const enterQueueEdit = (i: number): void => {
    // Entering from history browsing: the real draft was '' (history nav only
    // starts from an empty box), so the stash the store must hold is ''.
    if (inHistory) setInput('')
    setHistIndex(null)
    selectQueueSlot(i)
  }
  useEffect(() => {
    if (!queueEditRequest || queueEditRequest.conversationId !== active?.id) return
    const index = queuedMessages.findIndex((item) => item.queueId === queueEditRequest.queueId)
    if (index < 0) return
    if (inQueueEdit) selectQueueSlot(index)
    else enterQueueEdit(index)
    focusEditorAt(queuedMessages[index].text.length)
    // Only a new menu selection should replace editor text, never a stream tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queueEditRequest])
  /** Leave the mode. 'restore' brings back the stashed draft; 'keep' promotes
   *  the current text to the draft (never-lose-input on conflict/drain). */
  const exitQueueEdit = (mode: 'restore' | 'keep', text?: string): void => {
    const edited = text ?? input
    setQueueEdit(null)
    // 'restore' just drops the override — the store still holds the stash.
    if (mode === 'keep') setInput(edited)
  }
  const saveQueueEdit = async (): Promise<void> => {
    const item = editingItem
    const text = input.trim()
    if (!item || !text) return // empty edit = nothing to save (Esc to cancel)
    try {
      const r = await editQueuedMessage(item.queueId, text)
      if (r === 'saved') {
        exitQueueEdit('restore')
      } else {
        // Dispatched while we were editing — keep the text so nothing is lost.
        toast.info(t('queueEdit.dispatched'))
        exitQueueEdit('keep')
      }
    } catch {
      // Stay in edit mode with the text intact — the user can retry Enter.
      toast.error(t('queueEdit.saveFailed'))
    }
  }
  // Drain race: the slot being edited left the queue (its turn started, or the
  // queue was cleared by Stop). Exit gracefully — dirty edits become the draft.
  useEffect(() => {
    if (!activeQueueEdit || queuedMessages.some((q) => q.queueId === activeQueueEdit.queueId)) return
    const dirty = input !== editBaseTextRef.current
    if (wasQueueConsumed(activeQueueEdit.queueId)) toast.info(t('queueEdit.dispatched'))
    exitQueueEdit(dirty ? 'keep' : 'restore')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingQueueId, queuedMessages, inQueueEdit])

  const submit = async () => {
    // Text is required (server contract: 400 on empty text) — an attachment-only
    // submit must NOT clear the chips into a silently-dropped turn.
    if (blocked || !hasDraft || submittingRef.current) return
    const textForTurn = input.trim() || contextChips.map((chip) => chip.token).join(' ')
    const opts = {
      ...(attached.length ? { attachmentIds: attached.map((a) => a.id) } : {}),
      ...(contextChips.length ? { contextRefs: contextChips.map(toContextReference) } : {}),
    }
    const signature = JSON.stringify([textForTurn, opts])
    const previous = composerSubmissionIds.get(draftKey)
    const requestIdentity = previous?.signature === signature ? previous : { signature, queueId: `q-${crypto.randomUUID()}` }
    // Exactly what is being handed to the turn — the unit that gets cleared now
    // and handed back verbatim if the send is rejected.
    const submitted: AgentComposerDraftSnapshot = {
      text: input,
      references: inlineReferences,
      attachments: attached,
      submission: requestIdentity,
    }
    setComposerSubmission(draftKey, requestIdentity)
    // Clear BEFORE awaiting: the box must empty in the same beat the user bubble
    // appears, and a new mission materializing mid-send must find nothing left to
    // migrate into the conversation it creates (which is what used to resurrect
    // the text under the new key, in a composer this closure no longer owns).
    clearSubmittedComposerDraft(draftKey, submitted)
    setPaletteTrigger(null)
    setPlusOpen(false)
    setHistIndex(null)
    submittingRef.current = true
    setSubmitting(true)
    try {
      const result = await send(textForTurn, { ...opts, queueId: requestIdentity.queueId })
      // A materialized mission owns the draft from here on: rejection restores
      // into the conversation the turn actually reached, not the sentinel slot.
      const targetKey = result.conversationId ?? draftKey
      if (!result.accepted) {
        setComposerSubmission(targetKey, requestIdentity)
        restoreSubmittedComposerDraft(targetKey, submitted)
        return
      }
      // The synchronous clear happened before materialization. Anything now
      // in the destination belongs to a later edit, even if its text matches.
      setComposerSubmission(draftKey, null)
      setComposerSubmission(targetKey, null)
    } catch (error) {
      restoreSubmittedComposerDraft(draftKey, submitted)
      toast.error(error instanceof Error ? error.message : t('queueEdit.saveFailed'))
    } finally {
      submittingRef.current = false
      setSubmitting(false)
    }
  }
  const recall = (i: number) => {
    if (history[i] === undefined) {
      setHistIndex(null)
      return
    }
    setHistIndex(i)
    setInput(history[i])
  }
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing) return
    // Shift+Tab cycles the tier ladder from INSIDE the editor too. Handled
    // here (not only on the conversation-view wrapper) because the EMPTY
    // compose card renders the composer without that wrapper — there the
    // browser default (focus previous element) was winning on macOS.
    if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault()
      e.stopPropagation() // the view wrapper also listens — don't cycle twice
      void cycleTier()
      return
    }
    if (paletteOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        if (visiblePaletteItems.length > 0) {
          setActivePaletteIndex((idx) => Math.min(visiblePaletteItems.length - 1, idx + 1))
        }
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        if (visiblePaletteItems.length > 0) {
          setActivePaletteIndex((idx) => Math.max(0, idx - 1))
        }
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        const item = visiblePaletteItems[activePaletteIndex] ?? visiblePaletteItems[0]
        if (item) selectPaletteItem(item)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setPaletteTrigger(null)
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      // In queue-edit mode Enter SAVES the slot in place — it never sends.
      if (inQueueEdit) void saveQueueEdit()
      else submit()
      return
    }
    if (e.key === 'Escape' && inQueueEdit) {
      e.preventDefault()
      e.stopPropagation() // don't let the panel treat it as a close
      exitQueueEdit('restore')
      return
    }
    // Arrow semantics: while ≥1 queued message exists the arrows drive the
    // QUEUE (edit-in-place); prompt history resumes once the queue drains.
    // ↑/↓ only hijack at the caret boundaries where the native move is a no-op
    // (start for ↑, end for ↓) — inside multi-line text they move the cursor.
    // A DIRTY slot never navigates away: your keystrokes can't be lost by an
    // accidental arrow; save (Enter) or cancel (Esc) first.
    const el = editorRef.current
    const caretAtStart = el?.selectionStart === 0 && el?.selectionEnd === 0
    const caretAtEnd = el?.selectionStart === input.length && el?.selectionEnd === input.length
    if (e.key === 'ArrowUp') {
      if (inQueueEdit) {
        const pristine = editingItem !== null && input === editingItem.text
        if (pristine && caretAtStart && editIdx > 0) {
          e.preventDefault()
          selectQueueSlot(editIdx - 1)
        }
        return
      }
      if (queuedMessages.length > 0) {
        if (caretAtStart) {
          e.preventDefault()
          enterQueueEdit(queuedMessages.length - 1) // start from the LAST queued
        }
        return
      }
      if (!inHistory && input === '' && history.length > 0) {
        e.preventDefault()
        recall(history.length - 1)
      } else if (inHistory) {
        e.preventDefault()
        recall(Math.max(0, histIndex - 1))
      }
      return
    }
    if (e.key === 'ArrowDown') {
      if (inQueueEdit) {
        const pristine = editingItem !== null && input === editingItem.text
        if (pristine && caretAtEnd) {
          e.preventDefault()
          if (editIdx < queuedMessages.length - 1) selectQueueSlot(editIdx + 1)
          else exitQueueEdit('restore') // past the newest → back to the draft
        }
        return
      }
      if (queuedMessages.length > 0) return // history nav suspended while queued
      if (inHistory) {
        e.preventDefault()
        if (histIndex < history.length - 1) recall(histIndex + 1)
        else {
          setHistIndex(null)
          setInput('')
        }
      }
      return
    }
    if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && inHistory) {
      setHistIndex(null)
    }
  }

  return (
    <div className="shrink-0">
      {/* flex-wrap: with a workspace pane (Jobs/Code) narrowing the center
          column, the tier chip must wrap under the selectors instead of
          overflowing the composer card. */}
      <div className="mb-2 flex flex-wrap items-center gap-2">
        {/* The project pin is chosen while composing a NEW conversation (EMPTY
            state); once a conversation exists the pin is fixed here. The Kanban
            floating panel hides this copy — its header carries the selector. */}
        {active === null && !hideProjectSelector && (
          <AgentProjectSelector
            pinnedProjectId={draftPinnedProjectId}
            onSelect={(id) => void setPinnedProject(id)}
          />
        )}
        <AgentToolbarSelector
          label={t('provider.label')}
          value={provider}
          options={selectableProviders.map((p) => ({
            value: p,
            label: t(`provider.${p}`, { defaultValue: p }),
          }))}
          icon={Bot}
          onSelect={(nextProvider) => {
            void setProvider(nextProvider).catch(() => toast.error(t('error.generic')))
          }}
          testId="agent-provider-selector"
        />
        <AgentModelSelector
          models={models}
          model={active ? active.model : draftModel}
          status={providerCatalog.status}
          customModelAliases={customModelAliases}
          onSelect={(m) => {
            void setModel(m).catch(() => toast.error(t('error.generic')))
          }}
        />
        {efforts.length > 0 && (
          <AgentToolbarSelector
            label={t('effort.label')}
            value={effort}
            options={efforts.map((level) => ({ value: level, label: t(`effort.${level}`) }))}
            icon={Gauge}
            onSelect={(nextEffort) => {
              void setEffort(nextEffort).catch(() => toast.error(t('error.generic')))
            }}
            testId="agent-effort-selector"
          />
        )}
        <div className="ml-auto">
          <AgentTierChip level={active?.tier_level ?? draftTierLevel} onCycle={() => void cycleTier()} />
        </div>
      </div>
      {inQueueEdit && editingItem && (
        <div
          data-testid="queue-edit-chip"
          className="mb-1 flex items-center gap-1.5 rounded-md border border-accent-highlight/30 bg-accent-highlight/10 px-2 py-1 text-[11px] text-accent-highlight"
        >
          <Pencil className="h-3 w-3 shrink-0" />
          <span className="font-medium">{t('queueEdit.editing', { n: editIdx + 1, m: queuedMessages.length })}</span>
          <span className="truncate text-foreground/45">{t('queueEdit.hint')}</span>
          <button
            type="button"
            onClick={() => exitQueueEdit('restore')}
            aria-label={t('queueEdit.cancel')}
            title={t('queueEdit.cancel')}
            className="ml-auto rounded-sm p-0.5 text-foreground/50 hover:bg-muted hover:text-foreground"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      )}
      {inHistory && (
        <div className="mb-1 flex items-center gap-1.5 px-1 text-[11px] text-foreground/50">
          <History className="h-3 w-3" />
          {t('history.hint')}
        </div>
      )}
      {attached.length > 0 && (
        <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
          {attached.map((a) => (
            <AgentComposerAttachmentChip
              key={a.id}
              conversationId={activeId}
              attachment={a}
              removeLabel={t('close')}
              onRemove={() => removeAttachment(a.id)}
            />
          ))}
        </div>
      )}
      {(backgroundProcesses.length > 0 || activeId && backgroundProjectId) && (
        <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
          {activeId && backgroundProjectId && <button type="button" onClick={() => setProcessHistoryScope({ chatId: activeId, projectId: backgroundProjectId })} aria-label={t('backgroundProcess.history.open')} className="inline-flex items-center gap-1.5 rounded-lg border border-border/50 px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary"><Terminal className="h-3 w-3" aria-hidden />{t('backgroundProcess.history.button')}{backgroundProcessHistory.length > 0 && <span className="font-mono text-[10px]">{backgroundProcessHistory.length}</span>}</button>}
          {compactProcesses.map((process, index) => (
            <BackgroundProcessChip
              key={backgroundProcessKey(process)}
              process={process}
              accentVariant={backgroundAccentVariants[index % backgroundAccentVariants.length]}
              onKill={killBackgroundProcess}
              onOpen={setSelectedProcess}
            />
          ))}
        </div>
      )}
      <div
        className={`relative flex items-end gap-2 rounded-xl border bg-background/60 px-3 py-2 ${
          inQueueEdit ? 'border-accent-highlight/50' : inHistory ? 'border-accent-info/40' : 'border-border/60'
        }`}
        onDragOver={(e) => { if (canAttach) { e.preventDefault() } }}
        onDrop={(e) => {
          if (!canAttach) return
          e.preventDefault()
          const files = Array.from(e.dataTransfer.files)
          if (files.length) void uploadFiles(files)
        }}
      >
        {paletteOpen && (
          <AgentContextPalette
            items={visiblePaletteItems}
            mode={paletteTrigger.mode}
            query={paletteTrigger.query}
            activeIndex={activePaletteIndex}
            onActiveIndexChange={setActivePaletteIndex}
            onSelect={selectPaletteItem}
          />
        )}
        {canAttach && (
          <>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                const files = Array.from(e.target.files ?? [])
                if (files.length) void uploadFiles(files)
                e.target.value = ''
              }}
            />
          </>
        )}
        {!inQueueEdit && <AgentPlusMenu
          open={plusOpen}
          canAttach={canAttach}
          uploading={uploading}
          onToggle={() => {
            setPlusOpen((open) => !open)
            setPaletteTrigger(null)
          }}
          onClose={() => setPlusOpen(false)}
          onOpenMode={openPaletteMode}
          onAttachFile={() => {
            setPlusOpen(false)
            fileInputRef.current?.click()
          }}
          canBrowserCapture={isBrowserCaptureEnabled() && !!(pinnedProjectId ?? activeProjectId)}
          onOpenBrowser={() => {
            setPlusOpen(false)
            openBrowser()
          }}
        />}
        <div className="min-w-0 flex-1">
          <AgentComposerEditor
            key={draftKey}
            ref={editorRef}
            value={input}
            references={inQueueEdit ? [] : inlineReferences}
            autoFocus={autoFocus}
            onChange={(value, references, caret) => {
              // Editing a queued slot: keep the keystrokes OUT of the draft store
              // (it still holds the stashed draft) and stay in the mode — Enter
              // saves, Esc cancels.
              if (inQueueEdit) {
                setQueueEdit((current) => (current ? { ...current, text: value } : current))
                return
              }
              if (inHistory) setHistIndex(null)
              setInput(value, references)
              syncPalette(value, caret, references)
            }}
            onSelect={(start) => {
              // Existing atomic references are already resolved, so placing the
              // cursor next to one must not reopen its autocomplete menu.
              if (!inQueueEdit) syncPalette(editorRef.current?.value ?? input, start)
            }}
            onKeyDown={onKeyDown}
            onPaste={(e) => {
              if (!canAttach) return
              const files = Array.from(e.clipboardData.files)
              if (files.length) { e.preventDefault(); void uploadFiles(files) }
            }}
            disabled={blocked}
            placeholder={blocked ? t('noProvider.placeholder') : isStreaming ? t('queue.placeholder') : t('composerPlaceholder')}
            title={inQueueEdit ? t('queueEdit.hint') : inHistory ? t('history.hint') : undefined}
            className={`min-h-[3.25rem] max-h-64 min-w-0 w-full resize-y overflow-y-auto bg-transparent text-sm outline-none ${
              inHistory ? 'italic text-foreground/50' : 'text-foreground'
            }`}
          />
        </div>
        {/* Stop remains separate from Send/Save so typing never hides it. */}
        {isStreaming && (
          <button type="button" onClick={() => void abort()} aria-label={t('stop')} title={t('stop')}
            className="rounded-lg bg-destructive p-1.5 text-white transition-colors hover:opacity-90">
            <Square className="h-4 w-4" fill="currentColor" />
          </button>
        )}
        {inQueueEdit ? (
          <button
            type="button"
            onClick={() => void saveQueueEdit()}
            disabled={blocked || !input.trim()}
            aria-label={t('queueEdit.save')}
            title={t('queueEdit.save')}
            className="rounded-lg bg-accent-highlight p-1.5 text-white transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            <Check className="h-4 w-4" />
          </button>
        ) : isStreaming ? (
          <button
            type="button"
            onClick={submit}
            disabled={blocked || !hasDraft || submitting}
            aria-label={t('queue.send')}
            title={t('queue.sendHint')}
            className="relative rounded-lg bg-accent-info p-1.5 text-white transition-colors hover:opacity-90"
          >
            <SendHorizontal className="h-4 w-4" />
          </button>
        ) : (
          <button
            type="button"
            onClick={submit}
            disabled={blocked || !hasDraft || submitting}
            aria-label={t('send')}
            className="rounded-lg bg-accent-primary p-1.5 text-white transition-opacity disabled:opacity-40"
          >
            <SendHorizontal className="h-4 w-4" />
          </button>
        )}
      </div>
      {/* Git strip: current branch (switchable) + last commit of the mission's
          pinned project. Hidden without a project or outside a git repo. */}
      {gitProjectId && <AgentGitBar projectId={gitProjectId} />}
      {selectedProcess && selectedProcess.chatId === activeId && selectedProcess.projectId === backgroundProjectId && (
        <BackgroundProcessLogsModal
          process={backgroundProcessHistory.find(process => backgroundProcessKey(process) === backgroundProcessKey(selectedProcess)) ?? selectedProcess}
          onClose={() => setSelectedProcess(null)}
          onKill={killBackgroundProcess}
        />
      )}
      {processHistoryScope && processHistoryScope.chatId === activeId && processHistoryScope.projectId === backgroundProjectId && (
        <BackgroundProcessHistoryModal processes={backgroundProcessHistory} loading={historyLoading} error={historyError} onRefresh={refreshHistory} onClose={() => setProcessHistoryScope(null)} onKill={killBackgroundProcess} />
      )}
    </div>
  )
}
