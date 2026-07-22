import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { SendHorizontal, History, Square, Paperclip, X, Clock, Check, Pencil, Bot, Gauge } from 'lucide-react'
import { useAgentChat } from '../../context/AgentChatContext'
import { useAgentWorkspace } from '../../context/AgentWorkspaceContext'
import { useBackgroundProcesses } from '../../context/BackgroundProcessesContext'
import { useDesktop } from '../../hooks/useDesktop'
import { API_ORIGIN } from '../../lib/origin'
import { uploadAgentAttachment, deleteAgentAttachment, type AgentAttachment } from '../../lib/agent-api'
import {
  buildPaletteItems,
  buildNoResultPaletteItems,
  chipKey,
  detectAgentPaletteTrigger,
  filterPaletteItems,
  insertPaletteSelection,
  toContextReference,
  type AgentContextChip,
  type AgentPaletteItem,
  type AgentPaletteMode,
  type AgentPaletteTrigger,
} from '../../lib/agent-context-palette'
import type { JobSummary, LocalTicket } from '../../types'
import { AgentProjectSelector } from './AgentProjectSelector'
import { AgentTierChip } from './AgentTierChip'
import { AgentModelSelector } from './AgentModelSelector'
import { AgentToolbarSelector } from './AgentToolbarSelector'
import { useAgentProviderCatalog } from './useAgentProviderCatalog'
import { AgentGitBar } from './AgentGitBar'
import { AgentComposerContextChips, AgentContextPalette, AgentPlusMenu } from './AgentContextPalette'
import { BackgroundProcessChip, type BackgroundProcessAccent } from '../BackgroundProcessChip'
import { useAvailableProviders } from '../../hooks/useAvailableProviders'
import { reasoningEffortsForProvider, defaultReasoningEffortForProvider } from '../../lib/provider-capabilities'

function removePaletteTriggerText(
  text: string,
  trigger: Pick<AgentPaletteTrigger, 'start' | 'end'> | null,
): { text: string; caret: number } {
  if (!trigger) return { text, caret: text.length }
  let before = text.slice(0, trigger.start)
  let after = text.slice(trigger.end)
  if (/\s$/.test(before) && /^\s/.test(after)) after = after.replace(/^\s+/, '')
  const bridge = before && after && !/\s$/.test(before) && !/^\s/.test(after) ? ' ' : ''
  const next = `${before}${bridge}${after}`
  return { text: next, caret: before.length + bridge.length }
}

// Session-scoped composer drafts (design D15 — context/session state, never the
// URL): the Mission⇄Board mode switch UNMOUNTS the composer, so a typed-but-
// unsent prompt must survive outside component state. Keyed per conversation;
// the EMPTY "new mission" compose screen shares one draft slot.
const composerDrafts = new Map<string, string>()
const composerAttachmentDrafts = new Map<string, AgentAttachment[]>()
const NEW_MISSION_DRAFT_KEY = '__new-mission__'

/** Test-only: reset the session draft store between cases. */
export function __clearComposerDrafts(): void {
  composerDrafts.clear()
  composerAttachmentDrafts.clear()
}

/**
 * Shared agent composer — controls row (project · provider · model · effort · tier),
 * prompt-history textarea, send/stop. Context-driven so the floating panel and
 * the inline Agent-Mode surface render the exact same input (attachment parity
 * lands here in a later phase). The project selector is re-homed here so it
 * survives in both variants.
 */
export function AgentComposer({
  autoFocus = false,
  hideProjectSelector = false,
}: {
  autoFocus?: boolean
  /** Kanban floating panel: its window header carries the project selector
   *  (next to the Agent title), so the composer's own copy is hidden. Agent
   *  Mode keeps the composer selector on the EMPTY compose screen. */
  hideProjectSelector?: boolean
}) {
  const { t } = useTranslation('agent')
  const {
    active, messages, conversations, isStreaming, providersReady, draftPinnedProjectId,
    draftProvider, draftModel, draftTierLevel, draftEffort, setEffort,
    send, abort, cycleTier, setProvider, setModel, setPinnedProject, materializeDraftConversation,
    queuedMessages, editQueuedMessage, wasQueueConsumed,
  } = useAgentChat()
  const { pendingCaptures, consumePendingCaptures } = useAgentWorkspace()
  const { processes: backgroundProcesses, kill: killBackgroundProcess } = useBackgroundProcesses()
  const { projects, activeProjectId } = useDesktop()
  const draftKey = active?.id ?? NEW_MISSION_DRAFT_KEY
  const [input, setInputState] = useState(() => composerDrafts.get(draftKey) ?? '')
  // Every keystroke mirrors into the session draft store so an unmount
  // (mode switch, panel close) never loses a typed-but-unsent prompt.
  const setInput = (v: string): void => {
    setInputState(v)
    if (v) composerDrafts.set(draftKey, v)
    else composerDrafts.delete(draftKey)
  }
  const [histIndex, setHistIndex] = useState<number | null>(null)
  const [attached, setAttached] = useState<AgentAttachment[]>(() => composerAttachmentDrafts.get(draftKey) ?? [])
  const attachmentDraftKeyRef = useRef(draftKey)
  attachmentDraftKeyRef.current = draftKey
  const setAttachmentDraft = (
    key: string,
    updater: AgentAttachment[] | ((prev: AgentAttachment[]) => AgentAttachment[]),
  ): void => {
    const prev = composerAttachmentDrafts.get(key) ?? []
    const next = typeof updater === 'function' ? updater(prev) : updater
    if (next.length > 0) composerAttachmentDrafts.set(key, next)
    else composerAttachmentDrafts.delete(key)
    const currentKey = attachmentDraftKeyRef.current
    if (currentKey === key || (currentKey === NEW_MISSION_DRAFT_KEY && key !== NEW_MISSION_DRAFT_KEY)) {
      setAttached(next)
    }
  }
  const [uploading, setUploading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const [contextChips, setContextChips] = useState<AgentContextChip[]>([])
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
  const [editingQueueId, setEditingQueueId] = useState<string | null>(null)
  // The unsent draft stashed when entering the mode — restored on exit. The
  // session draft store keeps holding it, so an unmount mid-edit loses only the
  // in-progress edit (the queued message itself is untouched server-side).
  const stashedDraftRef = useRef('')
  // The slot's text at selection time: dirty-detection that survives the slot
  // vanishing mid-edit (drain race).
  const editBaseTextRef = useRef('')
  const editIdx = editingQueueId === null ? -1 : queuedMessages.findIndex((q) => q.queueId === editingQueueId)
  const editingItem = editIdx >= 0 ? queuedMessages[editIdx] : null
  const inQueueEdit = editingQueueId !== null
  const blocked = providersReady === false
  // Attachments upload to a conversation-keyed endpoint. On the EMPTY compose
  // screen we materialise the draft conversation just before the upload.
  const canAttach = !blocked
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
    () => (paletteTrigger ? buildPaletteItems(paletteTrigger.mode, paletteSource) : []),
    [paletteTrigger, paletteSource],
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
  // The composer survives conversation switches (no key/remount): pending chips
  // are keyed to the conversation they were uploaded to (foreign ids silently
  // no-op server-side) and a stale histIndex could index past the new history.
  useEffect(() => {
    setAttached(composerAttachmentDrafts.get(activeId ?? NEW_MISSION_DRAFT_KEY) ?? [])
    setHistIndex(null)
    setPaletteTrigger(null)
    setPlusOpen(false)
    setContextChips([])
    // A queue-edit in progress belongs to the previous conversation — drop it
    // (the queued message is untouched server-side; the draft store below still
    // holds the stashed draft, which is exactly what gets restored).
    setEditingQueueId(null)
    // Restore the target conversation's own unsent draft (or the new-mission one).
    setInputState(composerDrafts.get(activeId ?? NEW_MISSION_DRAFT_KEY) ?? '')
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

  const adoptNewMissionDrafts = (conversationId: string): void => {
    const prompt = composerDrafts.get(NEW_MISSION_DRAFT_KEY)
    if (prompt) {
      if (!composerDrafts.has(conversationId)) composerDrafts.set(conversationId, prompt)
      composerDrafts.delete(NEW_MISSION_DRAFT_KEY)
      setInputState(composerDrafts.get(conversationId) ?? prompt)
    }
    const draftAttachments = composerAttachmentDrafts.get(NEW_MISSION_DRAFT_KEY)
    if (draftAttachments?.length) {
      const existing = composerAttachmentDrafts.get(conversationId) ?? []
      setAttachmentDraft(conversationId, [...existing, ...draftAttachments])
      composerAttachmentDrafts.delete(NEW_MISSION_DRAFT_KEY)
    }
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
  const removeAttachment = (id: string) => {
    setAttachmentDraft(draftKey, (prev) => prev.filter((a) => a.id !== id))
    if (active) void deleteAgentAttachment(active.id, id)
  }

  const syncPalette = (text: string, caret: number): void => {
    const trigger = detectAgentPaletteTrigger(text, caret)
    setPaletteTrigger(trigger)
    if (trigger) setPlusOpen(false)
  }
  const triggerForMode = (mode: AgentPaletteMode): AgentPaletteTrigger['trigger'] => (
    mode === 'reference' ? '@' : mode === 'trace' ? '#' : '/'
  )
  const focusTextareaAt = (caret: number): void => {
    requestAnimationFrame(() => {
      textareaRef.current?.focus()
      textareaRef.current?.setSelectionRange(caret, caret)
    })
  }
  const openPaletteMode = (mode: AgentPaletteMode): void => {
    if (inQueueEdit) return
    const trigger = triggerForMode(mode)
    const el = textareaRef.current
    const start = el?.selectionStart ?? input.length
    const end = el?.selectionEnd ?? start
    const next = `${input.slice(0, start)}${trigger}${input.slice(end)}`
    setInput(next)
    setHistIndex(null)
    setPlusOpen(false)
    setPaletteTrigger({ mode, trigger, query: '', start, end: start + 1 })
    focusTextareaAt(start + 1)
  }
  const selectPaletteItem = (item: AgentPaletteItem): void => {
    const next = item.chip
      ? removePaletteTriggerText(input, paletteTrigger)
      : insertPaletteSelection(input, paletteTrigger, item)
    setInput(next.text)
    setHistIndex(null)
    setPaletteTrigger(null)
    setPlusOpen(false)
    if (item.chip) {
      setContextChips((prev) => (
        prev.some((chip) => chipKey(chip) === chipKey(item.chip!)) ? prev : [...prev, item.chip!]
      ))
    }
    focusTextareaAt(next.caret)
  }
  const removeContextChip = (chip: AgentContextChip): void => {
    const key = chipKey(chip)
    setContextChips((prev) => prev.filter((item) => chipKey(item) !== key))
  }

  // ── Queue-edit helpers ──────────────────────────────────────────────────────
  /** Show one queue slot in the composer (entry point and ↑/↓ moves). */
  const selectQueueSlot = (i: number): void => {
    const item = queuedMessages[i]
    if (!item) return
    setEditingQueueId(item.queueId)
    editBaseTextRef.current = item.text
    setInputState(item.text) // NOT setInput — the draft store keeps the stash
  }
  const enterQueueEdit = (i: number): void => {
    // Entering from history browsing: the real draft was '' (history nav only
    // starts from an empty box) — stash that, not the recalled history entry.
    stashedDraftRef.current = inHistory ? '' : input
    setHistIndex(null)
    selectQueueSlot(i)
  }
  /** Leave the mode. 'restore' brings back the stashed draft; 'keep' promotes
   *  the current text to the draft (never-lose-input on conflict/drain). */
  const exitQueueEdit = (mode: 'restore' | 'keep', text?: string): void => {
    setEditingQueueId(null)
    if (mode === 'keep') setInput(text ?? input)
    else setInputState(stashedDraftRef.current)
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
    if (editingQueueId === null || queuedMessages.some((q) => q.queueId === editingQueueId)) return
    const dirty = input !== editBaseTextRef.current
    if (wasQueueConsumed(editingQueueId)) toast.info(t('queueEdit.dispatched'))
    exitQueueEdit(dirty ? 'keep' : 'restore')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingQueueId, queuedMessages])

  const submit = () => {
    // Text is required (server contract: 400 on empty text) — an attachment-only
    // submit must NOT clear the chips into a silently-dropped turn.
    if (blocked || !hasDraft) return
    const textForTurn = input.trim() || contextChips.map((chip) => chip.token).join(' ')
    const opts = {
      ...(attached.length ? { attachmentIds: attached.map((a) => a.id) } : {}),
      ...(contextChips.length ? { contextRefs: contextChips.map(toContextReference) } : {}),
    }
    void send(textForTurn, attached.length || contextChips.length ? opts : undefined)
    setInput('')
    setAttachmentDraft(draftKey, [])
    setContextChips([])
    setPaletteTrigger(null)
    setPlusOpen(false)
    setHistIndex(null)
  }
  const recall = (i: number) => {
    if (history[i] === undefined) {
      setHistIndex(null)
      return
    }
    setHistIndex(i)
    setInput(history[i])
  }
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Shift+Tab cycles the tier ladder from INSIDE the textarea too. Handled
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
    if (e.key === 'Backspace' && input.length === 0 && contextChips.length > 0 && !inQueueEdit) {
      e.preventDefault()
      setContextChips((prev) => prev.slice(0, -1))
      return
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
    const el = e.currentTarget
    const caretAtStart = el.selectionStart === 0 && el.selectionEnd === 0
    const caretAtEnd = el.selectionStart === input.length && el.selectionEnd === input.length
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
        <div className="mb-1.5 flex flex-wrap gap-1.5">
          {attached.map((a) => (
            <span key={a.id} className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-surface/70 px-2 py-0.5 text-[11px] text-foreground/80">
              <Paperclip className="h-3 w-3 text-accent-primary" />
              <span className="max-w-[160px] truncate">{a.filename}</span>
              <button type="button" onClick={() => removeAttachment(a.id)} aria-label={t('close')} className="rounded-sm hover:bg-muted">
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      {backgroundProcesses.length > 0 && (
        <div className="mb-1.5 flex flex-wrap gap-1.5">
          {backgroundProcesses.map((process, index) => (
            <BackgroundProcessChip
              key={process.pid}
              process={process}
              accentVariant={backgroundAccentVariants[index % backgroundAccentVariants.length]}
              onKill={(pid) => void killBackgroundProcess(pid)}
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
        <AgentPlusMenu
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
        />
        <div className="flex min-h-[3.25rem] flex-1 flex-wrap items-start gap-1.5">
          {!inQueueEdit && (
            <AgentComposerContextChips
              chips={contextChips}
              onRemove={removeContextChip}
            />
          )}
          <textarea
            ref={textareaRef}
            value={input}
            autoFocus={autoFocus}
            onChange={(e) => {
              // Editing a queued slot: keep the keystrokes OUT of the draft store
              // (it still holds the stashed draft) and stay in the mode — Enter
              // saves, Esc cancels.
              if (inQueueEdit) {
                setInputState(e.target.value)
                return
              }
              if (inHistory) setHistIndex(null)
              setInput(e.target.value)
              syncPalette(e.target.value, e.target.selectionStart ?? e.target.value.length)
            }}
            onClick={(e) => syncPalette(e.currentTarget.value, e.currentTarget.selectionStart ?? e.currentTarget.value.length)}
            onKeyDown={onKeyDown}
            onPaste={(e) => {
              if (!canAttach) return
              const files = Array.from(e.clipboardData.files)
              if (files.length) { e.preventDefault(); void uploadFiles(files) }
            }}
            rows={2}
            disabled={blocked}
            placeholder={contextChips.length > 0 ? '' : blocked ? t('noProvider.placeholder') : isStreaming ? t('queue.placeholder') : t('composerPlaceholder')}
            data-agent-interactive
            title={inQueueEdit ? t('queueEdit.hint') : inHistory ? t('history.hint') : undefined}
            className={`min-h-[3.25rem] max-h-64 min-w-[12rem] flex-1 resize-y bg-transparent text-sm outline-none placeholder:text-foreground/40 disabled:opacity-60 ${
              inHistory ? 'italic text-foreground/50' : 'text-foreground'
            }`}
          />
        </div>
        {/* Tri-state action: idle → send; streaming + empty box → red stop;
            streaming + text → "send to queue" (the agent keeps working, the
            message parks behind the in-flight turn). Queue-edit mode overrides
            all three: the action is SAVE-in-place (Enter), never a new send. */}
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
        ) : isStreaming && !hasDraft ? (
          <button
            type="button"
            onClick={() => void abort()}
            aria-label={t('stop')}
            title={t('stop')}
            className="rounded-lg bg-destructive p-1.5 text-white transition-colors hover:opacity-90"
          >
            <Square className="h-4 w-4" fill="currentColor" />
          </button>
        ) : isStreaming ? (
          <button
            type="button"
            onClick={submit}
            disabled={blocked}
            aria-label={t('queue.send')}
            title={t('queue.sendHint')}
            className="relative rounded-lg bg-accent-info p-1.5 text-white transition-colors hover:opacity-90"
          >
            <SendHorizontal className="h-4 w-4" />
            <span className="absolute -right-1 -top-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-background ring-1 ring-border">
              <Clock className="h-2.5 w-2.5 text-accent-info" />
            </span>
          </button>
        ) : (
          <button
            type="button"
            onClick={submit}
            disabled={blocked || !hasDraft}
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
    </div>
  )
}
