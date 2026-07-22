import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { useSharedWebSocket } from './useSharedWebSocket'
import { useDesktop } from './useDesktop'
import {
  coerceBlueprint,
  deriveDimensions,
  parseBlueprintDraftBlocks,
  type Blueprint,
} from '../lib/blueprint-draft'
import type { CommitFormValue } from '../components/project-builder/BlueprintCommitForm'
import { launchMilestone } from '../lib/milestone-launch'
import { useMilestoneSequencer, readMilestoneLaunchMode } from '../context/MilestoneSequencerContext'
import { analyzeBlueprintSpecQuality } from '../lib/blueprint-spec-quality'
import {
  defaultReasoningEffortForProvider,
  reasoningEffortsForProvider,
} from '../lib/provider-capabilities'

// Builder session logic (reskin-project-builder-into-agent-panel D1) —
// extracted from the retired ProjectBuilderShell so the agent surfaces (the
// floating panel, the Agent Mode surface, and the workspace sidebar) can all
// consume ONE session: conversation bootstrap, `blueprint.*` WS handling, the
// four phases, the last valid blueprint snapshot, and the commit/launch
// actions. The transport stays the day-0 `/api/blueprint/*` REST + WS — never
// the agent transport.

export type BuilderPhase = 'chat' | 'commit' | 'progress' | 'done'

export interface BuilderChatMessage {
  role: 'user' | 'assistant'
  content: string
  /** ISO instant, set at push time — feeds AgentMessage's timestamp row so the
   *  builder chat is 1:1 with the mission chat. */
  createdAt: string
}

export interface BuilderCommitStep {
  step: string
  status: 'running' | 'done' | 'warning' | 'failed'
  detail?: string
  /** Machine-readable failure classification (github step: gh_not_installed…). */
  code?: string
}

/** Known github-step warning codes with an i18n message; anything else falls back to generic. */
export const GH_ERROR_CODES = new Set([
  'gh_not_installed',
  'gh_not_authenticated',
  'gh_scope',
  'gh_repo_exists',
  'gh_network',
])

export function githubErrorKey(code: string | undefined): string {
  return `progress.githubErrors.${code && GH_ERROR_CODES.has(code) ? code : 'generic'}`
}

// Fallback used by tests + as the i18n English source (`builder:prompts.surpriseMe`).
// The surprise-me prompt is BOTH sent to the model AND shown as a user bubble,
// so the live value comes from the active locale (see `surpriseMe` below) — a
// Spanish UI must not surface an English bubble.
export const SURPRISE_ME_PROMPT =
  'Surprise me — propose sensible defaults for every blueprint dimension, keep m1Specs empty, and let me approve the plan before generating detailed specs.'

export const COMMIT_STEP_ORDER = ['create-dir', 'git-init', 'assemble', 'blueprint', 'tickets', 'register', 'github'] as const

export interface BuilderSession {
  phase: BuilderPhase
  messages: BuilderChatMessage[]
  streamBuffer: string | null
  blueprint: Blueprint | null
  busy: boolean
  commitError: string | null
  commitErrorDetail: string | null
  commitSteps: BuilderCommitStep[]
  createdProjectId: string | null
  launching: boolean
  submitting: boolean
  conversationReady: boolean
  /** True once the blueprint gained any content — gates the exit confirm. */
  dirty: boolean
  canProposeCommit: boolean
  specQualityDetail: string | null
  showSurpriseMe: boolean
  /** Provider/model/effort for the builder conversation — the composer's
   *  selector row (coherent with the mission composer). Provider/model PATCH
   *  the blueprint conversation; effort rides each send (ephemeral). */
  provider: string
  model: string | null
  models: Array<{ value: string; label: string }>
  efforts: string[]
  effort: string
  /** Composer draft lives in the session so board/Agent-mode surface swaps do
   *  not discard what the user was typing. */
  draft: string
  setDraft: (draft: string) => void
  setEffort: (effort: string) => void
  setProvider: (provider: string) => void
  setModel: (model: string) => void
  send: (text: string) => void
  surpriseMe: () => void
  goToCommit: () => void
  backToChat: () => void
  submitCommit: (value: CommitFormValue) => void
  launchM1: () => Promise<void>
  openProject: () => void
  /** Abort any in-flight turn and reset every state slice (exit path). */
  abortAndReset: () => void
}

export function useBuilderSession(enabled: boolean, opts: { onFinished: () => void }): BuilderSession {
  const { t } = useTranslation('builder')
  const { registerHandler, unregisterHandler } = useSharedWebSocket()
  const { setActiveProjectId } = useDesktop()
  const { startSequential } = useMilestoneSequencer()

  const [conversationId, setConversationId] = useState<string | null>(null)
  const [messages, setMessages] = useState<BuilderChatMessage[]>([])
  const [streamBuffer, setStreamBuffer] = useState<string | null>(null)
  const [blueprint, setBlueprint] = useState<Blueprint | null>(null)
  // Exact model JSON for strict readiness + commit. `blueprint` above is the
  // compatibility-normalized render model and must not be used as the gate.
  const [rawBlueprint, setRawBlueprint] = useState<unknown | null>(null)
  const [busy, setBusy] = useState(false)
  const [phase, setPhase] = useState<BuilderPhase>('chat')
  const [commitError, setCommitError] = useState<string | null>(null)
  const [commitErrorDetail, setCommitErrorDetail] = useState<string | null>(null)
  const [commitId, setCommitId] = useState<string | null>(null)
  const [commitSteps, setCommitSteps] = useState<BuilderCommitStep[]>([])
  const [createdProjectId, setCreatedProjectId] = useState<string | null>(null)
  const [launching, setLaunching] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [provider, setProviderState] = useState('claude')
  const [model, setModelState] = useState<string | null>(null)
  const [models, setModels] = useState<Array<{ value: string; label: string }>>([])
  const [defaultModel, setDefaultModel] = useState('')
  const [providerEfforts, setProviderEfforts] = useState<string[]>([])
  const [effort, setEffort] = useState('medium')
  const [draft, setDraft] = useState('')
  const effectiveModel = model ?? defaultModel
  const efforts = useMemo(() => {
    const allowed = reasoningEffortsForProvider(provider, effectiveModel)
    return providerEfforts.filter((level) => (allowed as readonly string[]).includes(level))
  }, [effectiveModel, provider, providerEfforts])

  const conversationIdRef = useRef<string | null>(null)
  const commitIdRef = useRef<string | null>(null)
  /** One warning toast per commit attempt — the github warning upsert may repeat. */
  const ghWarnedRef = useRef(false)
  const effortRef = useRef(effort)
  const effortsRef = useRef(efforts)
  const modelRef = useRef(model)
  const submittingRef = useRef(false)
  const onFinishedRef = useRef(opts.onFinished)
  useEffect(() => { conversationIdRef.current = conversationId }, [conversationId])
  useEffect(() => { commitIdRef.current = commitId }, [commitId])
  useEffect(() => { effortRef.current = effort }, [effort])
  useEffect(() => { effortsRef.current = efforts }, [efforts])
  useEffect(() => { modelRef.current = model }, [model])
  useEffect(() => { onFinishedRef.current = opts.onFinished }, [opts.onFinished])

  // Bootstrap a conversation when the session activates (fresh each entry —
  // resume is deliberately v2).
  useEffect(() => {
    if (!enabled || conversationId) return
    let cancelled = false
    fetch('/api/blueprint/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
      .then((r) => r.json())
      .then((data: { conversation?: { id: string; provider?: string; model?: string | null } }) => {
        if (!cancelled && data.conversation) {
          setConversationId(data.conversation.id)
          if (data.conversation.provider) setProviderState(data.conversation.provider)
          setModelState(data.conversation.model ?? null)
        }
      })
      .catch(() => {
        if (!cancelled) toast.error(t('errors.startFailed'))
      })
    return () => { cancelled = true }
  }, [enabled, conversationId, t])

  // Model catalog per provider — same endpoint the builder router exposes.
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    // Do not expose or submit the previous provider's catalog while the next
    // one is loading (for example switching to Gemini, which has no effort knob).
    setModels([])
    setDefaultModel('')
    setProviderEfforts([])
    setEffort('')
    fetch(`/api/blueprint/models?provider=${encodeURIComponent(provider)}`)
      .then((r) => r.json())
      .then((data: {
        models?: Array<{ value: string; label: string }>
        defaultModel?: string
        efforts?: string[]
      }) => {
        if (cancelled) return
        setModels(data.models ?? [])
        const nextDefaultModel = data.defaultModel ?? data.models?.[0]?.value ?? ''
        const advertisedEfforts = data.efforts ?? []
        const allowed = reasoningEffortsForProvider(provider, nextDefaultModel)
        const nextEfforts = advertisedEfforts.filter((level) =>
          (allowed as readonly string[]).includes(level),
        )
        setDefaultModel(nextDefaultModel)
        setProviderEfforts(advertisedEfforts)
        // Reset to a valid effort for the new provider. Kimi has no `medium`,
        // so its first advertised tier (`low`) is the safe initial value.
        setEffort((prev) => (
          nextEfforts.includes(prev)
            ? prev
            : defaultReasoningEffortForProvider(provider, nextDefaultModel) ?? ''
        ))
      })
      .catch(() => { /* selector degrades to empty */ })
    return () => { cancelled = true }
  }, [enabled, provider])

  const setProvider = useCallback((next: string) => {
    setProviderState(next)
    setModelState(null) // provider switch resets the model (server does too)
    const conv = conversationIdRef.current
    if (!conv) return
    fetch(`/api/blueprint/conversations/${conv}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: next }),
    }).catch(() => { /* next turn falls back server-side */ })
  }, [])

  const setModel = useCallback((next: string) => {
    setModelState(next)
    const allowed = reasoningEffortsForProvider(provider, next)
    const nextEfforts = providerEfforts.filter((level) =>
      (allowed as readonly string[]).includes(level),
    )
    setEffort((previous) => (
      nextEfforts.includes(previous)
        ? previous
        : defaultReasoningEffortForProvider(provider, next) ?? ''
    ))
    const conv = conversationIdRef.current
    if (!conv) return
    fetch(`/api/blueprint/conversations/${conv}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: next }),
    }).catch(() => { /* next turn falls back server-side */ })
  }, [provider, providerEfforts])

  // WS wiring: streams, done (with blueprint snapshot), errors, commit progress.
  useEffect(() => {
    if (!enabled) return
    const id = 'builder-session'
    registerHandler(id, (raw) => {
      const msg = raw as { type?: string; conversationId?: string; commitId?: string } & Record<string, unknown>
      // Null-safe identity checks: before bootstrap/commit the refs are null and
      // must never match a message that also carries a null/absent id.
      const isOurConversation = conversationIdRef.current !== null && msg.conversationId === conversationIdRef.current
      const isOurCommit = commitIdRef.current !== null && msg.commitId === commitIdRef.current
      if (msg.type === 'blueprint.stream' && isOurConversation) {
        setStreamBuffer((prev) => (prev ?? '') + String(msg.delta ?? ''))
      } else if (msg.type === 'blueprint.done' && isOurConversation) {
        setStreamBuffer(null)
        setBusy(false)
        const fullText = String(msg.fullText ?? '')
        setMessages((prev) => [...prev, { role: 'assistant', content: fullText, createdAt: new Date().toISOString() }])
        const snapshot = coerceBlueprint(msg.blueprint)
        if (snapshot) {
          setBlueprint(snapshot)
          setRawBlueprint(msg.rawBlueprint !== undefined ? msg.rawBlueprint : msg.blueprint)
        } else {
          // Belt-and-braces: parse the settled text ourselves.
          const parsed = parseBlueprintDraftBlocks(fullText)
          if (parsed.blueprint) {
            setBlueprint(parsed.blueprint)
            setRawBlueprint(parsed.rawBlueprint)
          }
        }
      } else if (msg.type === 'blueprint.error' && isOurConversation) {
        setStreamBuffer(null)
        setBusy(false)
        toast.error(t('errors.turnFailed'), { description: String(msg.error ?? '') })
      } else if (msg.type === 'blueprint.commit_progress' && isOurCommit) {
        const step = String(msg.step)
        const status = msg.status as BuilderCommitStep['status']
        const detail = typeof msg.detail === 'string' ? msg.detail : undefined
        const code = typeof msg.code === 'string' ? msg.code : undefined
        if (step === 'github' && status === 'warning' && !ghWarnedRef.current) {
          // Non-blocking: the project was created; only the remote failed.
          ghWarnedRef.current = true
          toast.warning(t(githubErrorKey(code)), { description: detail })
        }
        setCommitSteps((prev) => {
          const next = prev.filter((s) => s.step !== step)
          return [...next, { step, status, detail, code }]
        })
      } else if (msg.type === 'blueprint.commit_done' && isOurCommit) {
        setCreatedProjectId(String(msg.projectId))
        setPhase('done')
      } else if (msg.type === 'blueprint.commit_failed' && isOurCommit) {
        submittingRef.current = false
        setSubmitting(false)
        toast.error(t('errors.commitFailed'), { description: String(msg.error ?? '') })
        setPhase('commit')
        setCommitError('commit_failed')
        setCommitErrorDetail(String(msg.error ?? ''))
      }
    })
    return () => unregisterHandler(id)
  }, [enabled, registerHandler, unregisterHandler, t])

  const send = useCallback(
    (text: string) => {
      const conv = conversationIdRef.current
      const trimmed = text.trim()
      if (!conv || !trimmed || busy) return
      setMessages((prev) => [...prev, { role: 'user', content: trimmed, createdAt: new Date().toISOString() }])
      setBusy(true)
      const selectedEffort = effortRef.current
      const supportsSelectedEffort = effortsRef.current.includes(selectedEffort)
      fetch(`/api/blueprint/conversations/${conv}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: trimmed,
          ...(modelRef.current ? { model: modelRef.current } : {}),
          ...(supportsSelectedEffort ? { reasoning_effort: selectedEffort } : {}),
        }),
      })
        .then((r) => {
          if (!r.ok && r.status !== 202) {
            setBusy(false)
            toast.error(t('errors.turnFailed'))
          }
        })
        .catch(() => {
          setBusy(false)
          toast.error(t('errors.turnFailed'))
        })
    },
    [busy, t],
  )

  const surpriseMe = useCallback(() => send(t('prompts.surpriseMe')), [send, t])

  const submitCommit = useCallback(
    (value: CommitFormValue) => {
      if (!blueprint || submittingRef.current) return
      submittingRef.current = true
      setSubmitting(true)
      setCommitError(null)
      setCommitErrorDetail(null)
      setCommitSteps([])
      ghWarnedRef.current = false
      fetch('/api/blueprint/commit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // The server must validate the exact model payload. Sending the render
        // model here would turn invalid enums/dependencies into parser defaults.
        body: JSON.stringify({ blueprint: rawBlueprint ?? blueprint, ...value }),
      })
        .then(async (r) => {
          const body = (await r.json().catch(() => ({}))) as { commitId?: string; error?: string; detail?: string }
          if (r.status === 202 && body.commitId) {
            setCommitId(body.commitId)
            commitIdRef.current = body.commitId
            setPhase('progress')
          } else {
            setCommitError(body.error ?? 'generic')
            setCommitErrorDetail(body.detail ?? null)
          }
          submittingRef.current = false
          setSubmitting(false)
        })
        .catch(() => {
          submittingRef.current = false
          setSubmitting(false)
          setCommitError('generic')
          setCommitErrorDetail(null)
        })
    },
    [blueprint, rawBlueprint],
  )

  const launchM1 = useCallback(async () => {
    if (!createdProjectId || launching) return
    setLaunching(true)
    try {
      // Honour the user's stored launch mode (sequential = chain rails at settle).
      if (readMilestoneLaunchMode() === 'sequential') {
        const started = await startSequential(createdProjectId, 1)
        if (started) {
          setActiveProjectId(createdProjectId)
          onFinishedRef.current()
        } else {
          toast.error(t('done.launchFailed'))
        }
        return
      }
      const result = await launchMilestone(createdProjectId, 1)
      if (result.ok) {
        if (result.skippedCount > 0) {
          toast.warning(t('done.launchPartialToast', { count: result.ticketCount, skipped: result.skippedCount }))
        } else {
          toast.success(t('done.launchToast', { count: result.ticketCount }))
        }
        setActiveProjectId(createdProjectId)
        onFinishedRef.current()
      } else {
        toast.error(t('done.launchFailed'), { description: result.detail ?? result.reason })
      }
    } finally {
      setLaunching(false)
    }
  }, [createdProjectId, launching, setActiveProjectId, startSequential, t])

  const openProject = useCallback(() => {
    if (createdProjectId) setActiveProjectId(createdProjectId)
    onFinishedRef.current()
  }, [createdProjectId, setActiveProjectId])

  const abortAndReset = useCallback(() => {
    const conv = conversationIdRef.current
    if (conv) {
      // Best-effort: a live turn dies server-side; the conversation row remains.
      fetch(`/api/blueprint/conversations/${conv}/abort`, { method: 'POST' }).catch(() => { /* gone */ })
    }
    setConversationId(null)
    setMessages([])
    setStreamBuffer(null)
    setBlueprint(null)
    setRawBlueprint(null)
    setBusy(false)
    setPhase('chat')
    setCommitError(null)
    setCommitErrorDetail(null)
    setCommitId(null)
    setCommitSteps([])
    ghWarnedRef.current = false
    setCreatedProjectId(null)
    setLaunching(false)
    submittingRef.current = false
    setSubmitting(false)
    setProviderState('claude')
    setModelState(null)
    setModels([])
    setDefaultModel('')
    setProviderEfforts([])
    setEffort('medium')
    setDraft('')
  }, [])

  const dims = deriveDimensions(blueprint)
  const dirty = Object.values(dims).some(Boolean) || messages.length > 0 || draft.trim().length > 0
  const specQuality = useMemo(
    () => analyzeBlueprintSpecQuality(
      rawBlueprint ?? blueprint,
      { milestoneLabel: 'M1', minSpecs: 5, maxSpecs: 10, requireScaffold: true },
    ),
    [blueprint, rawBlueprint],
  )

  return {
    phase,
    messages,
    streamBuffer,
    blueprint,
    busy,
    commitError,
    commitErrorDetail,
    commitSteps,
    createdProjectId,
    launching,
    submitting,
    conversationReady: conversationId !== null,
    dirty,
    canProposeCommit: specQuality.valid,
    specQualityDetail: specQuality.issues[0]?.message ?? null,
    showSurpriseMe: messages.length <= 1 && phase === 'chat',
    provider,
    model,
    models,
    efforts,
    effort,
    draft,
    setDraft,
    setEffort,
    setProvider,
    setModel,
    send,
    surpriseMe,
    goToCommit: () => setPhase('commit'),
    backToChat: () => setPhase('chat'),
    submitCommit,
    launchM1,
    openProject,
    abortAndReset,
  }
}
