import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { repositoryApiBase } from '../../../projects/lib/project-repositories'
import type { RuntimeRun } from '../../../settings/lib/agent-runtime'

export type RuntimeRunAction = 'resume' | 'approve' | 'recover' | 'answer' | 'cancel' | 'settle' | 'dismiss'

export interface UseRuntimeRunsOptions {
  /** Scope the list to ONE execution (the job-detail surfaces). */
  jobId?: string
  /** Scope the list to a rail's executions (legacy rail cards). */
  railIndex?: number
  /** `false` skips polling entirely (no project to ask). Default true. */
  enabled?: boolean
}

export interface RuntimeRunsState {
  runs: RuntimeRun[]
  error: string
  /** runId of the action in flight, null when idle. */
  busy: string | null
  answers: Record<string, string>
  setAnswer: (runId: string, value: string) => void
  act: (run: RuntimeRun, action: RuntimeRunAction) => Promise<void>
  refresh: () => void
}

/**
 * Polls `GET /agent-runtime/runs[/:jobId | ?railIndex]` every 10 s and exposes
 * the continuation actions. Shared by the Settings "Saved executions" list and
 * the job-run header on both job surfaces — one polling/action implementation.
 * Explicit continuation keeps frozen scope; it never starts a fresh delivery.
 */
export function useRuntimeRuns(projectId: string | null | undefined, options: UseRuntimeRunsOptions = {}): RuntimeRunsState {
  const { jobId, railIndex, enabled = true } = options
  const { t } = useTranslation('agentRuntime')
  const [runs, setRuns] = useState<RuntimeRun[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const mounted = useRef(true)
  const active = enabled && !!projectId
  const endpoint = projectId ? `${repositoryApiBase(projectId)}/agent-runtime/runs` : ''
  const statusEndpoint = jobId
    ? `${endpoint}/${encodeURIComponent(jobId)}`
    : railIndex !== undefined ? `${endpoint}?railIndex=${railIndex}` : endpoint

  useEffect(() => {
    mounted.current = true
    if (!active) { setRuns([]); setError(''); return () => { mounted.current = false } }
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    async function refresh() {
      try {
        const response = await fetch(statusEndpoint, { cache: 'no-store' })
        if (!response.ok) throw new Error()
        const data = await response.json() as { runs?: RuntimeRun[] }
        if (!Array.isArray(data.runs)) throw new Error()
        if (!cancelled) { setRuns(data.runs); setError('') }
      } catch { if (!cancelled) setError(t('runs.loadFailed')) }
      finally { if (!cancelled) timer = setTimeout(() => void refresh(), 10000) }
    }
    void refresh()
    return () => { cancelled = true; mounted.current = false; clearTimeout(timer) }
  }, [active, statusEndpoint, revision, t])

  const act = useCallback(async (run: RuntimeRun, action: RuntimeRunAction) => {
    setBusy(run.runId); setError('')
    try {
      const body = action === 'approve'
        ? { approve: [run.pendingApproval!.stepId] }
        : action === 'recover'
          ? { recover: run.recoverableSteps }
          : action === 'answer'
            ? { answer: (answers[run.runId] ?? '').trim() }
            : {}
      const verb = action === 'cancel' ? 'cancel' : action === 'settle' ? 'settle' : action === 'dismiss' ? 'dismiss' : 'resume'
      const response = await fetch(`${endpoint}/${encodeURIComponent(run.runId)}/${verb}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      })
      if (!response.ok) {
        const data = await response.json() as { message?: string }
        throw new Error(data.message ?? t('runs.actionFailed'))
      }
      if (mounted.current) {
        if (action === 'answer') setAnswers((value) => ({ ...value, [run.runId]: '' }))
        setRevision((value) => value + 1)
      }
    } catch (err) { if (mounted.current) setError(err instanceof Error ? err.message : t('runs.actionFailed')) }
    finally { if (mounted.current) setBusy(null) }
  }, [answers, endpoint, t])

  const setAnswer = useCallback((runId: string, value: string) => {
    setAnswers((prev) => ({ ...prev, [runId]: value }))
  }, [])
  const refresh = useCallback(() => setRevision((value) => value + 1), [])

  return { runs, error, busy, answers, setAnswer, act, refresh }
}
