import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { useSharedWebSocket } from './useSharedWebSocket'
import { useDesktop } from './useDesktop'
import {
  coerceBlueprint,
  deriveDimensions,
  describeStreamingSnapshot,
  parseBlueprintDraftBlocks,
  type Blueprint,
  type BlueprintRejectionReason,
} from '../lib/blueprint-draft'
import type { CommitFormValue } from '../components/project-builder/BlueprintCommitForm'
import { launchMilestone, milestoneLabel, readMilestoneLaunchMode, readMilestoneAutoAdvance } from '../lib/milestone-launch'
import { analyzeBlueprintSpecQuality, type BuilderSpecQualityIssue } from '../lib/blueprint-spec-quality'
import { deriveReadiness, localizeQualityIssue, type ReadinessReport } from '../lib/blueprint-readiness'
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

/** A user turn sent from a one-click decision card (kept on the row). */
export type BuilderTurnIntent = 'surprise' | 'approve'

export interface BuilderChatMessage {
  role: 'user' | 'assistant'
  content: string
  /** Present when the turn came from a decision card — rendered as the settled card. */
  intent?: BuilderTurnIntent | null
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

export const M1_READINESS_BOUNDS = { minSpecs: 5, maxSpecs: 10 } as const

export type BuilderRepairKind = 'invalid_json' | 'truncated' | 'quality'

/** What the app knows about the Builder's LAST snapshot block — the precise
 *  answer to "why is Create specs disabled" (harden-project-builder-snapshots). */
export type BuilderGenerationPhase = 'outline' | 'details' | 'audit' | 'repair'

export interface BuilderGenerationDescriptor {
  phase: BuilderGenerationPhase
  from: number
  to: number
  total: number
  turn: number
  totalTurns: number
}

export type BuilderSnapshotState =
  | { status: 'idle' }
  | { status: 'repairing'; kind: BuilderRepairKind; manual: boolean; attempt: number }
  /** App-driven batched generation in flight (premium-milestone-progress D7). */
  | { status: 'generating'; generation: BuilderGenerationDescriptor }
  /** `generationHalted`: the app-driven batch stopped before every spec was
   *  written (the snapshot is usable, the readiness panel offers "Continue"). */
  | { status: 'accepted'; repaired: boolean; repairAttempted: boolean; at: string; generationHalted?: boolean }
  | { status: 'rejected'; reason: BlueprintRejectionReason; detail: string; repairAttempted: boolean; at: string }

/** One unfinished Builder conversation as the "continue where you left off"
 *  list renders it (server summary — never the full snapshot). */
export interface RecentBlueprint {
  id: string
  title: string | null
  productName: string | null
  platform: string | null
  provider: string
  model: string | null
  updatedAt: string
  messageCount: number
  specCount: number
  specsComplete: boolean
  dimensionsFilled: number
  hasSnapshot: boolean
  pendingIssue: BlueprintRejectionReason | null
}

interface WireSnapshotStatus {
  status?: 'accepted' | 'rejected' | 'none'
  reason?: BlueprintRejectionReason
  detail?: string
  repaired?: boolean
  repairAttempted?: boolean
  claimsComplete?: boolean
  qualityIssues?: BuilderSpecQualityIssue[]
  generation?: BuilderGenerationDescriptor
  continuing?: boolean
  generationHalted?: boolean
}

export function coerceGenerationDescriptor(raw: unknown): BuilderGenerationDescriptor | null {
  const g = (raw && typeof raw === 'object' ? raw : null) as Record<string, unknown> | null
  if (!g) return null
  const phase = g.phase
  if (phase !== 'outline' && phase !== 'details' && phase !== 'audit' && phase !== 'repair') return null
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  return { phase, from: n(g.from), to: n(g.to), total: n(g.total), turn: n(g.turn), totalTurns: n(g.totalTurns) }
}

function snapshotFromWire(raw: unknown, previous: BuilderSnapshotState): BuilderSnapshotState {
  const wire = (raw && typeof raw === 'object' ? raw : {}) as WireSnapshotStatus
  const at = new Date().toISOString()
  if (wire.continuing) {
    // Batched generation is still running: stay in the generating state so the
    // progress surface keeps its phase; the final frame lands below.
    const generation = coerceGenerationDescriptor(wire.generation)
    return generation ? { status: 'generating', generation } : previous
  }
  if (wire.status === 'accepted') {
    return {
      status: 'accepted',
      repaired: wire.repaired === true,
      repairAttempted: wire.repairAttempted === true,
      at,
      ...(wire.generationHalted === true ? { generationHalted: true } : {}),
    }
  }
  if (wire.status === 'rejected') {
    return {
      status: 'rejected',
      reason: wire.reason ?? 'invalid_json',
      detail: wire.detail ?? '',
      repairAttempted: wire.repairAttempted === true,
      at,
    }
  }
  // No block this turn: whatever was settled before stays current (a repair
  // that produced nothing falls back to the pre-repair state).
  return previous.status === 'repairing' || previous.status === 'generating' ? { status: 'idle' } : previous
}

function mapRecent(raw: unknown): RecentBlueprint[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((row): row is Record<string, unknown> => !!row && typeof row === 'object' && typeof (row as { id?: unknown }).id === 'string')
    .map((row) => ({
      id: String(row.id),
      title: typeof row.title === 'string' ? row.title : null,
      productName: typeof row.productName === 'string' ? row.productName : null,
      platform: typeof row.platform === 'string' ? row.platform : null,
      provider: typeof row.provider === 'string' ? row.provider : 'claude',
      model: typeof row.model === 'string' ? row.model : null,
      updatedAt: typeof row.updated_at === 'string' ? row.updated_at : '',
      messageCount: typeof row.messageCount === 'number' ? row.messageCount : 0,
      specCount: typeof row.specCount === 'number' ? row.specCount : 0,
      specsComplete: row.specsComplete === true,
      dimensionsFilled: typeof row.dimensionsFilled === 'number' ? row.dimensionsFilled : 0,
      hasSnapshot: row.hasSnapshot === true,
      pendingIssue: row.pendingIssue === 'invalid_json' || row.pendingIssue === 'truncated' || row.pendingIssue === 'missing_version'
        ? row.pendingIssue
        : null,
    }))
}

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
  /** True once Milestone 1 was launched from the done screen (the live
   *  milestone card replaces the Launch button; Open the project stays). */
  launched: boolean
  submitting: boolean
  conversationReady: boolean
  /** The persisted conversation id (null until the first send / a resume). */
  conversationId: string | null
  /** True once the blueprint gained any content — gates the exit confirm. */
  dirty: boolean
  canProposeCommit: boolean
  /** Localized first blocker for the commit CTA, or null when ready. */
  specQualityDetail: string | null
  /** Three-step readiness (blueprint · specs · audit) behind the CTA. */
  readiness: ReadinessReport
  /** What happened to the Builder's last snapshot block. */
  snapshot: BuilderSnapshotState
  /** Live progress while a snapshot block is still streaming in. */
  generation: { generating: boolean; specsStarted: number }
  /** Unfinished Builder conversations the user can resume (hero state). */
  recent: RecentBlueprint[]
  recentLoading: boolean
  /** Rehydrate a persisted conversation (transcript + snapshot + session). */
  resume: (conversationId: string) => Promise<void>
  /** Delete an unfinished conversation from the resume list. */
  discardRecent: (conversationId: string) => Promise<void>
  /** Ask the Builder to re-emit / fix its last snapshot (manual repair). */
  repairSnapshot: () => Promise<void>
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
  send: (text: string, opts?: { intent?: BuilderTurnIntent }) => void
  surpriseMe: () => void
  /** One-click approval of the blueprint: sends the canonical approval prompt
   *  (tagged `approve`) so the Builder starts the Milestone-1 generation. */
  approveBlueprint: () => void
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
  const [launched, setLaunched] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [provider, setProviderState] = useState('claude')
  const [model, setModelState] = useState<string | null>(null)
  const [models, setModels] = useState<Array<{ value: string; label: string }>>([])
  const [defaultModel, setDefaultModel] = useState('')
  const [providerEfforts, setProviderEfforts] = useState<string[]>([])
  const [effort, setEffort] = useState('medium')
  const [draft, setDraft] = useState('')
  const [snapshot, setSnapshot] = useState<BuilderSnapshotState>({ status: 'idle' })
  const [recent, setRecent] = useState<RecentBlueprint[]>([])
  const [recentLoading, setRecentLoading] = useState(false)
  const [resuming, setResuming] = useState(false)
  const effectiveModel = model ?? defaultModel
  const efforts = useMemo(() => {
    const allowed = reasoningEffortsForProvider(provider, effectiveModel)
    return providerEfforts.filter((level) => (allowed as readonly string[]).includes(level))
  }, [effectiveModel, provider, providerEfforts])

  const conversationIdRef = useRef<string | null>(null)
  /** In-flight lazy creation, so two rapid sends never create two rows. */
  const creatingRef = useRef<Promise<string | null> | null>(null)
  const providerRef = useRef(provider)
  const commitIdRef = useRef<string | null>(null)
  /** One warning toast per commit attempt — the github warning upsert may repeat. */
  const ghWarnedRef = useRef(false)
  const effortRef = useRef(effort)
  const effortsRef = useRef(efforts)
  const modelRef = useRef(model)
  const submittingRef = useRef(false)
  const onFinishedRef = useRef(opts.onFinished)
  useEffect(() => { conversationIdRef.current = conversationId }, [conversationId])
  useEffect(() => { providerRef.current = provider }, [provider])
  useEffect(() => { commitIdRef.current = commitId }, [commitId])
  useEffect(() => { effortRef.current = effort }, [effort])
  useEffect(() => { effortsRef.current = efforts }, [efforts])
  useEffect(() => { modelRef.current = model }, [model])
  useEffect(() => { onFinishedRef.current = opts.onFinished }, [opts.onFinished])

  // No eager bootstrap: the conversation row is created on the FIRST send (or
  // rehydrated by `resume`), so opening and closing the Builder never leaves
  // an empty orphan row behind. `ensureConversation` is idempotent and
  // single-flight.
  const ensureConversation = useCallback(async (): Promise<string | null> => {
    const existing = conversationIdRef.current
    if (existing) return existing
    if (creatingRef.current) return creatingRef.current
    const pending = fetch('/api/blueprint/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: providerRef.current,
        ...(modelRef.current ? { model: modelRef.current } : {}),
      }),
    })
      .then((r) => r.json())
      .then((data: { conversation?: { id: string; provider?: string; model?: string | null } }) => {
        if (!data.conversation) return null
        conversationIdRef.current = data.conversation.id
        setConversationId(data.conversation.id)
        return data.conversation.id
      })
      .catch(() => null)
      .finally(() => { creatingRef.current = null })
    creatingRef.current = pending
    return pending
  }, [])

  // Unfinished blueprints to resume — loaded whenever the Builder opens.
  const refreshRecent = useCallback(async () => {
    setRecentLoading(true)
    try {
      const r = await fetch('/api/blueprint/conversations?resumable=1')
      const data = (await r.json()) as { conversations?: unknown }
      setRecent(mapRecent(data.conversations))
    } catch {
      setRecent([])
    } finally {
      setRecentLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!enabled) return
    void refreshRecent()
  }, [enabled, refreshRecent])

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
      } else if (msg.type === 'blueprint.repairing' && isOurConversation) {
        // The app is re-asking the Builder for its snapshot; the turn is still
        // live (busy stays true) and the progress surface says why.
        const kind = msg.kind === 'truncated' || msg.kind === 'quality' ? msg.kind : 'invalid_json'
        setBusy(true)
        setSnapshot({ status: 'repairing', kind, manual: msg.manual === true, attempt: typeof msg.attempt === 'number' ? msg.attempt : 1 })
      } else if (msg.type === 'blueprint.generating' && isOurConversation) {
        // Batched generation: the app is about to run a detail/audit turn.
        const generation = coerceGenerationDescriptor(msg)
        setStreamBuffer(null)
        setBusy(true)
        if (generation) setSnapshot({ status: 'generating', generation })
      } else if (msg.type === 'blueprint.done' && isOurConversation) {
        const continuing = msg.continuing === true
        setStreamBuffer(null)
        // A continuing frame keeps the turn busy — the panel fills in while the
        // app drives the next generation turn.
        setBusy(continuing)
        const fullText = String(msg.fullText ?? '')
        // A block-only reply has no prose — never append an empty bubble.
        if (fullText.trim() && !continuing) {
          setMessages((prev) => [...prev, { role: 'assistant', content: fullText, createdAt: new Date().toISOString() }])
        }
        let accepted = coerceBlueprint(msg.blueprint)
        let acceptedRaw: unknown = msg.rawBlueprint !== undefined ? msg.rawBlueprint : msg.blueprint
        if (!accepted && msg.snapshot === undefined) {
          // Legacy server without a snapshot status: parse the settled text.
          const parsed = parseBlueprintDraftBlocks(fullText)
          accepted = parsed.blueprint
          acceptedRaw = parsed.rawBlueprint
        }
        if (accepted) {
          setBlueprint(accepted)
          setRawBlueprint(acceptedRaw)
        }
        setSnapshot((prev) => (msg.snapshot === undefined
          ? (accepted ? { status: 'accepted', repaired: false, repairAttempted: false, at: new Date().toISOString() } : prev)
          : snapshotFromWire(msg.snapshot, prev)))
      } else if (msg.type === 'blueprint.error' && isOurConversation) {
        setStreamBuffer(null)
        setBusy(false)
        setSnapshot((prev) => (prev.status === 'repairing' || prev.status === 'generating' ? { status: 'idle' } : prev))
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
    (text: string, opts: { intent?: BuilderTurnIntent } = {}) => {
      const trimmed = text.trim()
      if (!trimmed || busy || resuming) return
      setMessages((prev) => [...prev, { role: 'user', content: trimmed, createdAt: new Date().toISOString(), ...(opts.intent ? { intent: opts.intent } : {}) }])
      setBusy(true)
      const selectedEffort = effortRef.current
      const supportsSelectedEffort = effortsRef.current.includes(selectedEffort)
      void ensureConversation().then((conv) => {
        if (!conv) {
          setBusy(false)
          toast.error(t('errors.startFailed'))
          return
        }
        return fetch(`/api/blueprint/conversations/${conv}/send`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: trimmed,
            ...(modelRef.current ? { model: modelRef.current } : {}),
            ...(supportsSelectedEffort ? { reasoning_effort: selectedEffort } : {}),
            ...(opts.intent ? { intent: opts.intent } : {}),
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
      })
    },
    [busy, resuming, ensureConversation, t],
  )

  // ── Resume / discard / manual repair (harden-project-builder-snapshots)
  const resume = useCallback(async (id: string) => {
    if (busy) return
    setResuming(true)
    try {
      const r = await fetch(`/api/blueprint/conversations/${id}`)
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const data = (await r.json()) as {
        conversation?: { id: string; provider?: string; model?: string | null }
        messages?: Array<{ role: 'user' | 'assistant'; content: string; created_at?: string; intent?: string | null }>
        blueprint?: unknown
        rawBlueprint?: unknown
        snapshot?: WireSnapshotStatus
      }
      if (!data.conversation) throw new Error('missing conversation')
      conversationIdRef.current = data.conversation.id
      setConversationId(data.conversation.id)
      if (data.conversation.provider) setProviderState(data.conversation.provider)
      setModelState(data.conversation.model ?? null)
      setMessages((data.messages ?? [])
        .filter((m) => typeof m.content === 'string' && m.content.trim() !== '')
        .map((m) => ({
          role: m.role,
          content: m.content,
          createdAt: m.created_at ?? new Date().toISOString(),
          ...(m.intent === 'surprise' || m.intent === 'approve' ? { intent: m.intent } : {}),
        })))
      const restored = coerceBlueprint(data.blueprint)
      setBlueprint(restored)
      setRawBlueprint(restored ? (data.rawBlueprint ?? data.blueprint) : null)
      setSnapshot(snapshotFromWire(data.snapshot, { status: 'idle' }))
      setStreamBuffer(null)
      setBusy(false)
      setPhase('chat')
      setCommitError(null)
      setCommitErrorDetail(null)
      setCommitSteps([])
      setDraft('')
    } catch {
      toast.error(t('recent.resumeFailed'))
    } finally {
      setResuming(false)
    }
  }, [busy, t])

  const discardRecent = useCallback(async (id: string) => {
    try {
      const r = await fetch(`/api/blueprint/conversations/${id}`, { method: 'DELETE' })
      if (!r.ok && r.status !== 404) throw new Error(`HTTP ${r.status}`)
      setRecent((prev) => prev.filter((c) => c.id !== id))
    } catch {
      toast.error(t('recent.discardFailed'))
    }
  }, [t])

  const repairSnapshot = useCallback(async () => {
    const conv = conversationIdRef.current
    if (!conv || busy) return
    setBusy(true)
    try {
      const r = await fetch(`/api/blueprint/conversations/${conv}/repair-snapshot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(effort ? { reasoningEffort: effort } : {}),
      })
      if (r.status === 202) return // `blueprint.repairing` → stream → `blueprint.done`
      const body = (await r.json().catch(() => ({}))) as { error?: string }
      setBusy(false)
      if (body.error === 'nothing_to_repair') toast.info(t('snapshot.nothingToRepair'))
      else if (body.error === 'no_session') toast.error(t('snapshot.noSession'))
      else if (body.error === 'streaming') toast.info(t('snapshot.alreadyStreaming'))
      else toast.error(t('errors.turnFailed'))
    } catch {
      setBusy(false)
      toast.error(t('errors.turnFailed'))
    }
  }, [busy, effort, t])

  const surpriseMe = useCallback(() => send(t('prompts.surpriseMe'), { intent: 'surprise' }), [send, t])
  const approveBlueprint = useCallback(() => send(t('prompts.approve'), { intent: 'approve' }), [send, t])

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
        body: JSON.stringify({
          blueprint: rawBlueprint ?? blueprint,
          ...value,
          ...(conversationIdRef.current ? { conversationId: conversationIdRef.current } : {}),
        }),
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
      // Server-owned launch (premium-milestone-progress): ≤3-spec rails,
      // sequential chunks stacked server-side. The done screen then shows the
      // live milestone card — "Open the project" remains the exit.
      const mode = readMilestoneLaunchMode()
      const autoAdvance = readMilestoneAutoAdvance()
      const result = await launchMilestone(createdProjectId, 1, mode, { autoAdvance })
      const label = milestoneLabel(1)
      if (result.ok) {
        const totalRails = result.launched.length + result.pending.length
        if (mode === 'sequential' && result.pending.length > 0) {
          toast.success(t(autoAdvance ? 'milestoneProgress.toast.launched' : 'milestoneProgress.toast.launchedCheckpoint', { milestone: label, count: result.ticketCount, n: totalRails }))
        } else if (result.skippedCount > 0) {
          toast.warning(t('milestoneProgress.toast.launchedPartial', { milestone: label, count: result.ticketCount, skipped: result.skippedCount }))
        } else {
          toast.success(t('milestoneProgress.toast.launchedAll', { milestone: label, count: result.ticketCount, n: totalRails }))
        }
        setActiveProjectId(createdProjectId)
        setLaunched(true)
      } else if (result.reason === 'chain_active') {
        toast.info(t('milestoneProgress.toast.chainActive', { milestone: label }))
        setActiveProjectId(createdProjectId)
        setLaunched(true)
      } else {
        toast.error(t('done.launchFailed'), { description: result.detail ?? result.error })
      }
    } finally {
      setLaunching(false)
    }
  }, [createdProjectId, launching, setActiveProjectId, t])

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
    conversationIdRef.current = null
    creatingRef.current = null
    setMessages([])
    setStreamBuffer(null)
    setBlueprint(null)
    setRawBlueprint(null)
    setSnapshot({ status: 'idle' })
    setRecent([])
    setResuming(false)
    setBusy(false)
    setPhase('chat')
    setCommitError(null)
    setCommitErrorDetail(null)
    setCommitId(null)
    setCommitSteps([])
    ghWarnedRef.current = false
    setCreatedProjectId(null); setLaunched(false)
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
      { milestoneLabel: 'M1', minSpecs: M1_READINESS_BOUNDS.minSpecs, maxSpecs: M1_READINESS_BOUNDS.maxSpecs, requireScaffold: true },
    ),
    [blueprint, rawBlueprint],
  )
  const generating = snapshot.status === 'generating'
  const readiness = useMemo(
    () => deriveReadiness(blueprint, rawBlueprint ?? blueprint, specQuality, M1_READINESS_BOUNDS, { generating }),
    [blueprint, rawBlueprint, specQuality, generating],
  )
  const specQualityDetail = useMemo(() => {
    if (specQuality.valid) return null
    const first = specQuality.issues[0]
    return first ? localizeQualityIssue(t, first) : null
  }, [specQuality, t])
  const generation = useMemo(() => describeStreamingSnapshot(streamBuffer), [streamBuffer])

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
    launched,
    submitting,
    conversationReady: enabled && !resuming,
    conversationId,
    dirty,
    canProposeCommit: specQuality.valid,
    specQualityDetail,
    readiness,
    snapshot,
    generation,
    recent,
    recentLoading,
    resume,
    discardRecent,
    repairSnapshot,
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
    approveBlueprint,
    goToCommit: () => setPhase('commit'),
    backToChat: () => setPhase('chat'),
    submitCommit,
    launchM1,
    openProject,
    abortAndReset,
  }
}
