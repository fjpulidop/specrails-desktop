import { useCallback, useEffect, useReducer, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useSharedWebSocket } from './useSharedWebSocket'
import { getApiBase } from '../lib/api'

export type RefinePhase =
  | 'idle'
  | 'reading'
  | 'drafting'
  | 'validating'
  | 'testing'
  | 'done'

export type RefineUiState =
  | 'closed'
  | 'composing'
  | 'streaming'
  | 'reviewing'
  | 'applying'
  | 'error'
  | 'cancelled'
  | 'applied'

export interface RefineHistoryTurn {
  role: 'user' | 'assistant' | 'system'
  content: string
  kind?: string
  timestamp: number
}

export interface AutoTestResult {
  output: string
  /** Null when the provider does not report usage (for example Kimi). */
  tokens: number | null
  durationMs: number
}

export interface AgentRefineState {
  refineId: string | null
  agentId: string | null
  uiState: RefineUiState
  phase: RefinePhase
  history: RefineHistoryTurn[]
  /** Streaming buffer for the in-flight assistant turn (cleared on ready). */
  streamingText: string
  draftBody: string | null
  /** Body the diff is computed against (the on-disk body at session start). */
  baseBody: string | null
  autoTest: boolean
  testResult: AutoTestResult | null
  appliedVersion: number | null
  errorMessage: string | null
  applyConflict: 'disk_changed' | 'name_changed' | null
}

type Action =
  | { type: 'OPEN'; agentId: string; baseBody: string }
  | { type: 'START_TURN'; refineId: string; userTurn: RefineHistoryTurn }
  | { type: 'STREAM_DELTA'; refineId: string; delta: string }
  | { type: 'PHASE'; refineId: string; phase: RefinePhase }
  | { type: 'READY'; refineId: string; draftBody: string }
  | { type: 'TEST_RESULT'; refineId: string; result: AutoTestResult }
  | { type: 'APPLIED'; refineId: string; version: number }
  | { type: 'CANCELLED'; refineId: string }
  | { type: 'ERROR'; refineId: string | null; message: string }
  | { type: 'CONFLICT'; refineId: string; reason: 'disk_changed' | 'name_changed' }
  | { type: 'TOGGLE_AUTO_TEST'; enabled: boolean }
  | { type: 'REHYDRATE'; payload: Partial<AgentRefineState> }
  | { type: 'CLOSE' }

const initialState: AgentRefineState = {
  refineId: null,
  agentId: null,
  uiState: 'closed',
  phase: 'idle',
  history: [],
  streamingText: '',
  draftBody: null,
  baseBody: null,
  autoTest: false,
  testResult: null,
  appliedVersion: null,
  errorMessage: null,
  applyConflict: null,
}

function stripToolMarkers(s: string): string {
  return s.replace(/<!--tool:[^>]+-->/g, '')
}

function reducer(state: AgentRefineState, action: Action): AgentRefineState {
  switch (action.type) {
    case 'OPEN':
      return {
        ...initialState,
        agentId: action.agentId,
        baseBody: action.baseBody,
        uiState: 'composing',
      }
    case 'START_TURN':
      return {
        ...state,
        refineId: action.refineId,
        uiState: 'streaming',
        phase: 'reading',
        streamingText: '',
        errorMessage: null,
        applyConflict: null,
        history: [...state.history, action.userTurn],
      }
    case 'STREAM_DELTA':
      if (state.refineId !== action.refineId) return state
      return { ...state, streamingText: state.streamingText + action.delta }
    case 'PHASE':
      if (state.refineId !== action.refineId) return state
      return { ...state, phase: action.phase }
    case 'READY':
      if (state.refineId !== action.refineId) return state
      return {
        ...state,
        uiState: 'reviewing',
        phase: 'done',
        draftBody: action.draftBody,
        streamingText: '',
        history: [
          ...state.history,
          { role: 'assistant', content: stripToolMarkers(action.draftBody), timestamp: Date.now() },
        ],
      }
    case 'TEST_RESULT':
      if (state.refineId !== action.refineId) return state
      return {
        ...state,
        testResult: action.result,
        history: [
          ...state.history,
          { role: 'system', kind: 'test_result', content: action.result.output, timestamp: Date.now() },
        ],
      }
    case 'APPLIED':
      if (state.refineId !== action.refineId) return state
      return { ...state, uiState: 'applied', appliedVersion: action.version }
    case 'CANCELLED':
      return { ...state, uiState: 'cancelled' }
    case 'ERROR':
      if (action.refineId !== null && state.refineId !== action.refineId) return state
      return { ...state, uiState: 'error', errorMessage: action.message }
    case 'CONFLICT':
      if (state.refineId !== action.refineId) return state
      return { ...state, applyConflict: action.reason }
    case 'TOGGLE_AUTO_TEST':
      return { ...state, autoTest: action.enabled }
    case 'REHYDRATE':
      return { ...state, ...action.payload }
    case 'CLOSE':
      return initialState
    default:
      return state
  }
}

interface ApiSession {
  id: string
  agentId: string
  status: string
  phase: string
  autoTest: boolean
  draftBody: string | null
  history: RefineHistoryTurn[]
  baseVersion: number
  createdAt: number
  updatedAt: number
}

function uiStateFromServer(s: ApiSession): RefineUiState {
  switch (s.status) {
    case 'streaming': return 'streaming'
    case 'ready': return 'reviewing'
    case 'applied': return 'applied'
    case 'cancelled': return 'cancelled'
    case 'error': return 'error'
    default: return s.draftBody ? 'reviewing' : 'composing'
  }
}

export function useAgentRefine(projectId: string | null): {
  state: AgentRefineState
  open: (agentId: string, baseBody: string) => void
  start: (instruction: string) => Promise<void>
  sendTurn: (instruction: string) => Promise<void>
  cancel: () => Promise<void>
  apply: (force?: boolean) => Promise<void>
  toggleAutoTest: (enabled: boolean) => Promise<void>
  rehydrate: (refineId: string, agentId: string) => Promise<void>
  close: () => void
} {
  const [state, dispatch] = useReducer(reducer, initialState)
  const { t } = useTranslation('aiedit')
  const { registerHandler, unregisterHandler } = useSharedWebSocket()

  const refineIdRef = useRef<string | null>(null)
  refineIdRef.current = state.refineId
  const agentIdRef = useRef<string | null>(null)
  agentIdRef.current = state.agentId
  const projectIdRef = useRef<string | null>(projectId)
  projectIdRef.current = projectId

  // Reset on project switch — refine sessions are per-project.
  const prevProjectId = useRef(projectId)
  useEffect(() => {
    if (projectId !== prevProjectId.current) {
      prevProjectId.current = projectId
      dispatch({ type: 'CLOSE' })
    }
  }, [projectId])

  useEffect(() => {
    const handlerId = `agent-refine-${Math.random().toString(36).slice(2, 9)}`
    registerHandler(handlerId, (raw) => {
      const msg = raw as Record<string, unknown>
      if (typeof msg.type !== 'string') return
      if (msg.projectId !== projectIdRef.current) return
      if (msg.refineId !== refineIdRef.current) return
      const refineId = msg.refineId as string
      switch (msg.type) {
        case 'agent_refine_stream':
          dispatch({ type: 'STREAM_DELTA', refineId, delta: msg.delta as string })
          break
        case 'agent_refine_phase':
          dispatch({ type: 'PHASE', refineId, phase: msg.phase as RefinePhase })
          break
        case 'agent_refine_ready':
          dispatch({ type: 'READY', refineId, draftBody: msg.draftBody as string })
          break
        case 'agent_refine_test':
          dispatch({ type: 'TEST_RESULT', refineId, result: msg.result as AutoTestResult })
          break
        case 'agent_refine_applied':
          dispatch({ type: 'APPLIED', refineId, version: msg.version as number })
          break
        case 'agent_refine_cancelled':
          dispatch({ type: 'CANCELLED', refineId })
          break
        case 'agent_refine_error':
          dispatch({ type: 'ERROR', refineId, message: msg.error as string })
          break
      }
    })
    return () => unregisterHandler(handlerId)
  }, [registerHandler, unregisterHandler])

  const open = useCallback((agentId: string, baseBody: string) => {
    dispatch({ type: 'OPEN', agentId, baseBody })
  }, [])

  const close = useCallback(() => {
    dispatch({ type: 'CLOSE' })
  }, [])

  const start = useCallback(async (instruction: string) => {
    const agentId = agentIdRef.current
    if (!agentId) return
    try {
      const res = await fetch(
        `${getApiBase()}/profiles/catalog/${encodeURIComponent(agentId)}/refine`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ instruction, autoTest: state.autoTest }),
        },
      )
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string }
        dispatch({ type: 'ERROR', refineId: null, message: data.error ?? t('refine.serverError', { status: res.status }) })
        return
      }
      const data = await res.json() as { refineId: string }
      // Set ref before dispatch so WS messages arriving immediately are accepted.
      refineIdRef.current = data.refineId
      dispatch({
        type: 'START_TURN',
        refineId: data.refineId,
        userTurn: { role: 'user', content: instruction, timestamp: Date.now() },
      })
    } catch (err) {
      dispatch({ type: 'ERROR', refineId: null, message: t('refine.connectionFailed', { message: (err as Error).message }) })
    }
  }, [state.autoTest, t])

  const sendTurn = useCallback(async (instruction: string) => {
    const refineId = refineIdRef.current
    const agentId = agentIdRef.current
    if (!refineId || !agentId) return
    dispatch({
      type: 'START_TURN',
      refineId,
      userTurn: { role: 'user', content: instruction, timestamp: Date.now() },
    })
    try {
      const res = await fetch(
        `${getApiBase()}/profiles/catalog/${encodeURIComponent(agentId)}/refine/${refineId}/turn`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ instruction }),
        },
      )
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string }
        dispatch({ type: 'ERROR', refineId, message: data.error ?? t('refine.serverError', { status: res.status }) })
      }
    } catch (err) {
      dispatch({ type: 'ERROR', refineId, message: t('refine.connectionFailed', { message: (err as Error).message }) })
    }
  }, [t])

  const cancel = useCallback(async () => {
    const refineId = refineIdRef.current
    const agentId = agentIdRef.current
    if (!refineId || !agentId) return
    try {
      await fetch(
        `${getApiBase()}/profiles/catalog/${encodeURIComponent(agentId)}/refine/${refineId}`,
        { method: 'DELETE' },
      )
    } catch { /* best-effort */ }
  }, [])

  const apply = useCallback(async (force?: boolean) => {
    const refineId = refineIdRef.current
    const agentId = agentIdRef.current
    if (!refineId || !agentId) return
    try {
      const res = await fetch(
        `${getApiBase()}/profiles/catalog/${encodeURIComponent(agentId)}/refine/${refineId}/apply`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ force: !!force }),
        },
      )
      if (res.status === 409) {
        const data = await res.json().catch(() => ({})) as { reason?: 'disk_changed' | 'name_changed' }
        if (data.reason === 'disk_changed' || data.reason === 'name_changed') {
          dispatch({ type: 'CONFLICT', refineId, reason: data.reason })
          return
        }
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string }
        dispatch({ type: 'ERROR', refineId, message: data.error ?? t('refine.applyFailed', { status: res.status }) })
        return
      }
      const data = await res.json() as { version: number }
      dispatch({ type: 'APPLIED', refineId, version: data.version })
    } catch (err) {
      dispatch({ type: 'ERROR', refineId, message: t('refine.connectionFailed', { message: (err as Error).message }) })
    }
  }, [t])

  const toggleAutoTest = useCallback(async (enabled: boolean) => {
    const refineId = refineIdRef.current
    const agentId = agentIdRef.current
    dispatch({ type: 'TOGGLE_AUTO_TEST', enabled })
    if (!refineId || !agentId) return
    try {
      await fetch(
        `${getApiBase()}/profiles/catalog/${encodeURIComponent(agentId)}/refine/${refineId}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ autoTest: enabled }),
        },
      )
    } catch { /* best-effort */ }
  }, [])

  const rehydrate = useCallback(async (refineId: string, agentId: string) => {
    try {
      // Load base body fresh from disk before pulling the refine session.
      const bodyRes = await fetch(`${getApiBase()}/profiles/catalog/${encodeURIComponent(agentId)}`)
      if (!bodyRes.ok) throw new Error(t('refine.loadAgentFailed', { status: bodyRes.status }))
      const bodyData = await bodyRes.json() as { body: string }
      const sessRes = await fetch(
        `${getApiBase()}/profiles/catalog/${encodeURIComponent(agentId)}/refine/${refineId}`,
      )
      if (!sessRes.ok) throw new Error(t('refine.loadSessionFailed', { status: sessRes.status }))
      const session = await sessRes.json() as ApiSession
      refineIdRef.current = refineId
      agentIdRef.current = agentId
      dispatch({
        type: 'REHYDRATE',
        payload: {
          refineId,
          agentId,
          baseBody: bodyData.body,
          draftBody: session.draftBody,
          history: session.history,
          autoTest: session.autoTest,
          phase: session.phase as RefinePhase,
          uiState: uiStateFromServer(session),
          streamingText: '',
        },
      })
    } catch (err) {
      dispatch({ type: 'ERROR', refineId: null, message: t('refine.rehydrateFailed', { message: (err as Error).message }) })
    }
  }, [t])

  return { state, open, start, sendTurn, cancel, apply, toggleAutoTest, rehydrate, close }
}
