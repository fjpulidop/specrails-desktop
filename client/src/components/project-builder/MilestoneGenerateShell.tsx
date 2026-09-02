import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Hammer, Loader2, Rocket, Send, X } from 'lucide-react'
import { Button } from '../ui/button'
import { cn } from '../../lib/utils'
import { useSharedWebSocket } from '../../hooks/useSharedWebSocket'
import { getApiBase } from '../../lib/api'
import { BlueprintPanel } from './BlueprintPanel'
import {
  cutUnterminatedBlock,
  parseBlueprintDraftBlocks,
  type Blueprint,
} from '../../lib/blueprint-draft'
import { analyzeBlueprintSpecQuality } from '../../lib/blueprint-spec-quality'
import { providerSupportsToolPolicy } from '../../lib/provider-capabilities'

// "Generate M<n>" (add-project-builder D7): PROJECT-level grounded milestone
// generation. Spawns through the existing ChatManager (kind='milestone' —
// real code reading available), reuses the blueprint-draft protocol, and
// commits the batch via POST /blueprint/commit-milestone (tickets labeled
// M<n>, milestone flipped to committed).

interface MilestoneGenerateShellProps {
  open: boolean
  onClose: () => void
  /** Invalidates the parent blueprint after a successful milestone commit. */
  onCommitted?: () => void
  projectId: string
  milestoneId: string // e.g. "m2"
  blueprint: Blueprint
  provider?: string
}

interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

export function MilestoneGenerateShell({
  open,
  onClose,
  onCommitted,
  projectId,
  milestoneId,
  blueprint,
  provider = 'claude',
}: MilestoneGenerateShellProps) {
  const { t } = useTranslation('builder')
  const { registerHandler, unregisterHandler } = useSharedWebSocket()

  const [conversationId, setConversationId] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [streamBuffer, setStreamBuffer] = useState<string | null>(null)
  const [draft, setDraft] = useState<Blueprint | null>(null)
  // Exact model JSON for quality validation and commit; `draft` is only the
  // compatibility-normalized render model.
  const [rawDraft, setRawDraft] = useState<unknown | null>(null)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [committing, setCommitting] = useState(false)

  const conversationIdRef = useRef<string | null>(null)
  const projectIdRef = useRef(projectId)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  // Kept in sync from the effect for every OTHER way the id can change; the
  // bootstrap below ALSO writes it synchronously, because the seeded turn is
  // POSTed in the same tick and its first WS frame can land before React has
  // flushed this effect — the handler's guard would then drop it as foreign.
  useEffect(() => { conversationIdRef.current = conversationId }, [conversationId])
  useEffect(() => { projectIdRef.current = projectId }, [projectId])

  const milestone = blueprint.milestones.find((m) => m.id === milestoneId)
  const label = milestoneId.toUpperCase()
  const generationAvailable = providerSupportsToolPolicy(provider, 'read-only')
  const specQuality = useMemo(
    () => analyzeBlueprintSpecQuality(
      rawDraft ?? draft,
      { milestoneLabel: label, minSpecs: 1, maxSpecs: 10, requireScaffold: false },
    ),
    [draft, rawDraft, label],
  )

  // Bootstrap the milestone conversation and fire the seeded first turn.
  useEffect(() => {
    if (!open || conversationId || !generationAvailable) return
    let cancelled = false
    fetch(`${getApiBase()}/chat/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'milestone', milestone: milestoneId }),
    })
      .then((r) => r.json())
      .then((data: { conversation?: { id: string } }) => {
        if (cancelled || !data.conversation) return
        // Synchronous, so the WS guard is armed BEFORE the seeded turn is sent.
        conversationIdRef.current = data.conversation.id
        setConversationId(data.conversation.id)
        const planned = milestone?.plannedSpecs ?? []
        // The seed is BOTH the model instruction and the first user bubble, so
        // it rides the active locale (the model follows instructions in any of
        // the 8 languages; the blueprint-draft protocol is structural).
        const seedVars = { label, title: milestone?.title ?? label, planned: planned.join('; ') }
        const seed = planned.length > 0
          ? t('prompts.milestoneSeedWithPlanned', seedVars)
          : t('prompts.milestoneSeed', seedVars)
        setMessages([{ role: 'user', content: seed }])
        setBusy(true)
        fetch(`${getApiBase()}/chat/conversations/${data.conversation.id}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: seed }),
        }).catch(() => {
          setBusy(false)
          toast.error(t('errors.turnFailed'))
        })
      })
      .catch(() => {
        if (!cancelled) toast.error(t('errors.startFailed'))
      })
    return () => { cancelled = true }
  }, [open, conversationId, milestoneId, milestone, label, generationAvailable, t])

  useEffect(() => {
    if (!open) return
    const id = `milestone-generate-${milestoneId}`
    registerHandler(id, (raw) => {
      const msg = raw as { type?: string; conversationId?: string; projectId?: string } & Record<string, unknown>
      if (msg.conversationId !== conversationIdRef.current) return
      if (msg.projectId && msg.projectId !== projectIdRef.current) return
      if (msg.type === 'chat_stream') {
        setStreamBuffer((prev) => (prev ?? '') + String(msg.delta ?? ''))
      } else if (msg.type === 'chat_done') {
        setStreamBuffer(null)
        setBusy(false)
        const fullText = String(msg.fullText ?? '')
        const parsed = parseBlueprintDraftBlocks(fullText)
        setMessages((prev) => [...prev, { role: 'assistant', content: parsed.stripped.trim() || fullText }])
        if (parsed.blueprint) {
          setDraft(parsed.blueprint)
          setRawDraft(parsed.rawBlueprint)
        }
      } else if (msg.type === 'chat_error') {
        setStreamBuffer(null)
        setBusy(false)
        toast.error(t('errors.turnFailed'), { description: String(msg.error ?? '') })
      }
    })
    return () => unregisterHandler(id)
  }, [open, milestoneId, registerHandler, unregisterHandler, t])

  useEffect(() => {
    scrollRef.current?.scrollTo?.({ top: scrollRef.current.scrollHeight })
  }, [messages, streamBuffer])

  const send = useCallback(
    (text: string) => {
      const conv = conversationIdRef.current
      const trimmed = text.trim()
      if (!conv || !trimmed || busy) return
      setMessages((prev) => [...prev, { role: 'user', content: trimmed }])
      setInput('')
      setBusy(true)
      fetch(`${getApiBase()}/chat/conversations/${conv}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: trimmed }),
      }).catch(() => {
        setBusy(false)
        toast.error(t('errors.turnFailed'))
      })
    },
    [busy, t],
  )

  const commit = useCallback(() => {
    const source = rawDraft ?? draft
    const sourceRecord = source && typeof source === 'object' && !Array.isArray(source)
      ? source as Record<string, unknown>
      : null
    const specs = Array.isArray(sourceRecord?.m1Specs) ? sourceRecord.m1Specs : []
    if (!specQuality.valid || committing) return
    setCommitting(true)
    fetch(`${getApiBase()}/blueprint/commit-milestone`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ milestoneId, specsComplete: sourceRecord?.specsComplete, specs }),
    })
      .then(async (r) => {
        if (r.status === 201) {
          const body = (await r.json()) as { insertedIds: number[] }
          toast.success(t('milestone.commitToast', { count: body.insertedIds.length, label }))
          onCommitted?.()
          onClose()
        } else {
          const body = await r.json().catch(() => ({}))
          const failure = body as { error?: string; detail?: string }
          toast.error(t('milestone.commitFailed'), { description: failure.detail ?? failure.error })
        }
      })
      .catch(() => toast.error(t('milestone.commitFailed')))
      .finally(() => setCommitting(false))
  }, [draft, rawDraft, specQuality.valid, committing, milestoneId, label, onClose, onCommitted, t])

  if (!open) return null

  const specCount = draft?.m1Specs.length ?? 0

  if (!generationAvailable) {
    return (
      <div className="fixed inset-0 z-50 flex flex-col bg-background/95 backdrop-blur-sm" data-testid="milestone-shell">
        <header className="flex items-center gap-2 border-b border-border/40 px-4 py-2.5">
          <Hammer className="h-4 w-4 text-accent-primary" />
          <h1 className="text-sm font-semibold">{t('milestone.title', { label })}</h1>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label={t('shell.close')}
            data-testid="milestone-close"
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        <p
          className="m-4 rounded-md border border-accent-warning/30 bg-accent-warning/10 p-3 text-sm text-accent-warning"
          data-testid="milestone-provider-unavailable"
        >
          {t('milestone.providerUnavailable')}
        </p>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background/95 backdrop-blur-sm" data-testid="milestone-shell">
      <header className="flex items-center gap-2 border-b border-border/40 px-4 py-2.5">
        <Hammer className="h-4 w-4 text-accent-primary" />
        <h1 className="text-sm font-semibold">{t('milestone.title', { label })}</h1>
        {milestone && <span className="text-xs text-muted-foreground">{milestone.title}</span>}
        <button
          type="button"
          onClick={onClose}
          className="ml-auto rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label={t('shell.close')}
          data-testid="milestone-close"
        >
          <X className="h-4 w-4" />
        </button>
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col border-r border-border/40">
          <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
            {messages.map((m, i) => (
              <div
                key={i}
                className={cn(
                  'max-w-[85%] whitespace-pre-wrap rounded-lg px-3 py-2 text-xs leading-relaxed',
                  m.role === 'user' ? 'ml-auto bg-accent-primary/15' : 'bg-surface/70',
                )}
              >
                {m.content}
              </div>
            ))}
            {streamBuffer !== null && (
              <div className="max-w-[85%] whitespace-pre-wrap rounded-lg bg-surface/70 px-3 py-2 text-xs leading-relaxed">
                {cutUnterminatedBlock(streamBuffer)}
                <span className="ml-0.5 inline-block h-3 w-1.5 animate-pulse bg-accent-primary/70 align-middle" />
              </div>
            )}
          </div>
          <div className="flex items-end gap-2 border-t border-border/40 p-3">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  send(input)
                }
              }}
              rows={2}
              placeholder={t('milestone.inputPlaceholder')}
              className="min-h-[2.5rem] flex-1 resize-none rounded-md border border-border/40 bg-surface/50 px-3 py-2 text-xs focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
            <Button size="sm" onClick={() => send(input)} disabled={busy || !input.trim() || !conversationId}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
            </Button>
          </div>
        </div>

        <aside className="flex w-80 shrink-0 flex-col lg:w-96">
          <BlueprintPanel blueprint={draft} milestoneLabel={label} />
          <div className="border-t border-border/40 p-3">
            <Button className="w-full" size="sm" disabled={!specQuality.valid || committing} onClick={commit} data-testid="milestone-commit">
              {committing ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Rocket className="mr-1.5 h-3.5 w-3.5" />}
              {t('milestone.commit', { count: specCount, label })}
            </Button>
            {!specQuality.valid && (
              <p className="mt-1.5 text-center text-[10px] text-muted-foreground" data-testid="milestone-quality-detail">
                {specQuality.issues[0]?.message}
              </p>
            )}
          </div>
        </aside>
      </div>
    </div>
  )
}
