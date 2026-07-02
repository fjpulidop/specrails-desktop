import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { SendHorizontal, History, Square, Paperclip, X, Clock } from 'lucide-react'
import { useAgentChat } from '../../context/AgentChatContext'
import { useAgentWorkspace } from '../../context/AgentWorkspaceContext'
import { uploadAgentAttachment, deleteAgentAttachment, getAgentModels, type AgentAttachment } from '../../lib/agent-api'
import { AgentProjectSelector } from './AgentProjectSelector'
import { AgentTierChip } from './AgentTierChip'
import { AgentModelSelector } from './AgentModelSelector'
import { AgentGitBar } from './AgentGitBar'

const PROVIDERS = ['claude', 'codex', 'gemini'] as const

// Session-scoped composer drafts (design D15 — context/session state, never the
// URL): the Mission⇄Board mode switch UNMOUNTS the composer, so a typed-but-
// unsent prompt must survive outside component state. Keyed per conversation;
// the EMPTY "new mission" compose screen shares one draft slot.
const composerDrafts = new Map<string, string>()
const NEW_MISSION_DRAFT_KEY = '__new-mission__'

/** Test-only: reset the session draft store between cases. */
export function __clearComposerDrafts(): void {
  composerDrafts.clear()
}

/**
 * Shared agent composer — controls row (project · provider · model · tier),
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
    active, messages, isStreaming, providersReady, draftPinnedProjectId,
    draftProvider, draftModel, draftTierLevel, draftEffort, setEffort,
    send, abort, cycleTier, setProvider, setModel, setPinnedProject,
  } = useAgentChat()
  const { pendingCaptures, consumePendingCaptures } = useAgentWorkspace()
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
  const [attached, setAttached] = useState<AgentAttachment[]>([])
  const [uploading, setUploading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const inHistory = histIndex !== null
  const history = useMemo(
    () => messages.filter((m) => m.role === 'user').map((m) => m.content),
    [messages],
  )
  const blocked = providersReady === false
  // Attachments upload to a conversation-keyed endpoint, so they're only offered
  // once a conversation exists (EMPTY state has none — send once to create it).
  const canAttach = !!active && !blocked
  const provider = active?.provider ?? draftProvider
  // The git strip follows the MISSION's pinned project (or the draft pin on the
  // EMPTY compose screen) — never the app's active project.
  const gitProjectId = active ? active.pinned_project_id : draftPinnedProjectId

  const activeId = active?.id ?? null
  // The composer survives conversation switches (no key/remount): pending chips
  // are keyed to the conversation they were uploaded to (foreign ids silently
  // no-op server-side) and a stale histIndex could index past the new history.
  useEffect(() => {
    setAttached([])
    setHistIndex(null)
    // Restore the target conversation's own unsent draft (or the new-mission one).
    setInputState(composerDrafts.get(activeId ?? NEW_MISSION_DRAFT_KEY) ?? '')
  }, [activeId])

  // Browser captures land as already-uploaded agent attachments — adopt them as
  // chips so they ride the next manual send.
  useEffect(() => {
    if (pendingCaptures.length === 0) return
    const captured = consumePendingCaptures()
    if (captured.length) setAttached((prev) => [...prev, ...captured])
  }, [pendingCaptures, consumePendingCaptures])

  // Image affordance gates on the provider's capability (design D22: capability,
  // never provider id — text-extractable attachments stay enabled regardless).
  // The same fetch carries the provider's reasoning-effort tiers (empty ⇒ no
  // selector — gemini has no per-spawn knob).
  const [supportsImage, setSupportsImage] = useState(true)
  const [efforts, setEfforts] = useState<string[]>([])
  useEffect(() => {
    let alive = true
    getAgentModels(provider)
      .then((r) => {
        if (!alive) return
        setSupportsImage(r.supportsImageInput)
        setEfforts(r.efforts)
      })
      .catch(() => { /* keep last known values */ })
    return () => { alive = false }
  }, [provider])
  const effort = (active ? active.reasoning_effort : draftEffort) ?? 'medium'

  const uploadFiles = async (files: File[]) => {
    if (!active || files.length === 0) return
    setUploading(true)
    for (const f of files) {
      if (!supportsImage && f.type.startsWith('image/')) {
        toast.error(t('imagesUnsupported'))
        continue
      }
      try {
        const att = await uploadAgentAttachment(active.id, f)
        setAttached((prev) => [...prev, att])
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t('workspace.uploadFailed'))
      }
    }
    setUploading(false)
  }
  const removeAttachment = (id: string) => {
    setAttached((prev) => prev.filter((a) => a.id !== id))
    if (active) void deleteAgentAttachment(active.id, id)
  }

  const submit = () => {
    // Text is required (server contract: 400 on empty text) — an attachment-only
    // submit must NOT clear the chips into a silently-dropped turn.
    if (blocked || !input.trim()) return
    void send(input, attached.length ? { attachmentIds: attached.map((a) => a.id) } : undefined)
    setInput('')
    setAttached([])
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
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
      return
    }
    if (e.key === 'ArrowUp') {
      if (!inHistory && input === '' && history.length > 0) {
        e.preventDefault()
        recall(history.length - 1)
      } else if (inHistory) {
        e.preventDefault()
        recall(Math.max(0, histIndex - 1))
      }
      return
    }
    if (e.key === 'ArrowDown' && inHistory) {
      e.preventDefault()
      if (histIndex < history.length - 1) recall(histIndex + 1)
      else {
        setHistIndex(null)
        setInput('')
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
        <select
          value={provider}
          onChange={(e) => void setProvider(e.target.value)}
          data-agent-interactive
          aria-label={t('provider.label')}
          className="rounded-md border border-border/50 bg-surface/60 px-2 py-1 text-xs text-foreground outline-none hover:bg-surface"
        >
          {PROVIDERS.map((p) => (
            <option key={p} value={p}>{t(`provider.${p}`)}</option>
          ))}
        </select>
        <AgentModelSelector
          provider={provider}
          model={active ? active.model : draftModel}
          onSelect={(m) => void setModel(m)}
        />
        {efforts.length > 0 && (
          <select
            value={effort}
            onChange={(e) => void setEffort(e.target.value)}
            data-agent-interactive
            aria-label={t('effort.label')}
            title={t('effort.label')}
            className="rounded-md border border-border/50 bg-surface/60 px-2 py-1 text-xs text-foreground outline-none hover:bg-surface"
          >
            {efforts.map((lvl) => (
              <option key={lvl} value={lvl}>{t(`effort.${lvl}`)}</option>
            ))}
          </select>
        )}
        <div className="ml-auto">
          <AgentTierChip level={active?.tier_level ?? draftTierLevel} onCycle={() => void cycleTier()} />
        </div>
      </div>
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
      <div
        className={`flex items-end gap-2 rounded-xl border bg-background/60 px-3 py-2 ${inHistory ? 'border-accent-info/40' : 'border-border/60'}`}
        onDragOver={(e) => { if (canAttach) { e.preventDefault() } }}
        onDrop={(e) => {
          if (!canAttach) return
          e.preventDefault()
          const files = Array.from(e.dataTransfer.files)
          if (files.length) void uploadFiles(files)
        }}
      >
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
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              aria-label={t('attachFile')}
              title={t('attachFile')}
              data-agent-interactive
              className="mb-1 rounded-md p-1 text-foreground/50 hover:bg-surface hover:text-foreground disabled:opacity-50"
            >
              <Paperclip className="h-4 w-4" />
            </button>
          </>
        )}
        <textarea
          value={input}
          autoFocus={autoFocus}
          onChange={(e) => {
            if (inHistory) setHistIndex(null)
            setInput(e.target.value)
          }}
          onKeyDown={onKeyDown}
          onPaste={(e) => {
            if (!canAttach) return
            const files = Array.from(e.clipboardData.files)
            if (files.length) { e.preventDefault(); void uploadFiles(files) }
          }}
          rows={2}
          disabled={blocked}
          placeholder={blocked ? t('noProvider.placeholder') : isStreaming ? t('queue.placeholder') : t('composerPlaceholder')}
          data-agent-interactive
          title={inHistory ? t('history.hint') : undefined}
          className={`min-h-[3.25rem] max-h-64 flex-1 resize-y bg-transparent text-sm outline-none placeholder:text-foreground/40 disabled:opacity-60 ${
            inHistory ? 'italic text-foreground/50' : 'text-foreground'
          }`}
        />
        {/* Tri-state action: idle → send; streaming + empty box → red stop;
            streaming + text → "send to queue" (the agent keeps working, the
            message parks behind the in-flight turn). */}
        {isStreaming && !input.trim() ? (
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
            disabled={blocked || !input.trim()}
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
