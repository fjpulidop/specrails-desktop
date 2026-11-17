import { useCallback, useEffect, useRef, useState } from 'react'
import { getApiBase } from '../../../lib/api'

export type AnalysisCategory = 'provider_limit' | 'missing_artifact' | 'configuration' | 'tests' | 'environment' | 'agent_error' | 'interrupted' | 'other'

export interface FailureAnalysis {
  headline: string
  cause: string
  category: AnalysisCategory
  failedStep: string | null
  evidence: string[]
  nextSteps: string[]
}

export type FailureAnalysisState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'running' }
  | { status: 'ready'; analysis: FailureAnalysis; provider: string; model: string | null; createdAt: string; stale: boolean }
  | { status: 'error'; detail: string | null }

interface ReadyBody { status: 'ready'; analysis: FailureAnalysis; provider: string; model: string | null; createdAt: string; stale: boolean }

/**
 * The AI reading of why a failed job stopped (`/jobs/:id/failure-analysis`).
 * Reads the saved one; with `auto`, asks for one when there is none. The server
 * dedupes and keeps one per job, so reopening the job costs nothing.
 */
export function useFailureAnalysis(projectId: string | undefined, jobId: string, language: string, { auto }: { auto: boolean }) {
  const [state, setState] = useState<FailureAnalysisState>({ status: 'idle' })
  const current = useRef(0)
  // No project id: the active project (board surfaces). No project at all: nothing to ask.
  let url: string | null = null
  try { url = `${getApiBase(projectId)}/jobs/${encodeURIComponent(jobId)}/failure-analysis` } catch { url = null }

  const run = useCallback(async (force = false) => {
    if (!url) return
    const request = ++current.current
    setState({ status: 'running' })
    try {
      const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ language, ...(force ? { force: true } : {}) }) })
      const body = await response.json().catch(() => ({})) as Partial<ReadyBody> & { detail?: string; error?: string }
      if (request !== current.current) return
      if (!response.ok || body.status !== 'ready' || !body.analysis) setState({ status: 'error', detail: body.detail ?? body.error ?? null })
      else setState(body as ReadyBody)
    } catch (error) {
      if (request === current.current) setState({ status: 'error', detail: error instanceof Error ? error.message : null })
    }
  }, [url, language])

  useEffect(() => {
    if (!url) return
    const request = ++current.current
    setState({ status: 'loading' })
    void fetch(`${url}?language=${encodeURIComponent(language)}`).then(async response => {
      const body = await response.json().catch(() => ({})) as Partial<ReadyBody>
      if (request !== current.current) return
      if (response.ok && body.status === 'ready' && body.analysis) setState(body as ReadyBody)
      else if (auto && response.ok) void run()
      else setState({ status: 'idle' })
    }).catch(() => { if (request === current.current) setState({ status: 'idle' }) })
    return () => { current.current++ }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, language])

  return { state, run }
}
