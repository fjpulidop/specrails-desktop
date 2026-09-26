import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { getApiBase } from '../../../lib/api'
import { repositoryApiBase } from '../../projects/lib/project-repositories'
import type { LoopStepSegment } from '../components/loop-log/loop-log-model'

/** A retry keeps the same durable request; a project change discards late UI
 * responses without cancelling an already-admitted server operation. */
export function useDefinitionFork(runId: string | undefined, projectId?: string) {
  const { t } = useTranslation('jobs')
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [created, setCreated] = useState<string | null>(null)
  const scope = `${projectId ?? 'active'}:${runId ?? ''}`, current = useRef(scope), inFlight = useRef(false)
  current.current = scope
  useEffect(() => {
    current.current = scope
    setBusy(false); setError(''); setCreated(null); inFlight.current = false
    return () => { current.current = '' }
  }, [scope])
  async function fork(attempt: LoopStepSegment) {
    if (!runId || inFlight.current || !attempt.meta.nodePath || !attempt.meta.scopeId || !attempt.meta.iteration) return
    const owner = scope
    inFlight.current = true; setBusy(true); setError('')
    try {
      const base = projectId ? repositoryApiBase(projectId) : getApiBase()
      const endpoint = `${base}/loop-runs/${encodeURIComponent(runId)}`
      const recoveryResponse = await fetch(`${endpoint}/recovery`, { cache: 'no-store' })
      if (!recoveryResponse.ok) throw new Error(t('loopExplorer.forkFailed'))
      const recovery = await recoveryResponse.json() as { forkRequest?: { requestId: string; fromNodePath: string; scopeId?: string; visit?: number }; forkRunId?: string; forkAdopted?: boolean }
      if (current.current !== owner) return
      if (recovery.forkAdopted && recovery.forkRunId) { setCreated(recovery.forkRunId); return }
      const cut = { fromNodePath: attempt.meta.nodePath, scopeId: attempt.meta.scopeId, visit: attempt.meta.iteration }
      if (recovery.forkRequest && (recovery.forkRequest.fromNodePath !== cut.fromNodePath || recovery.forkRequest.scopeId !== cut.scopeId || recovery.forkRequest.visit !== cut.visit)) throw new Error(t('loopExplorer.forkPending'))
      const body = recovery.forkRequest ?? { ...cut, requestId: crypto.randomUUID() }
      const response = await fetch(`${endpoint}/fork`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const result = await response.json() as { loopRunId?: string; detail?: string }
      if (!response.ok || !result.loopRunId) throw new Error(result.detail ?? t('loopExplorer.forkFailed'))
      if (current.current === owner) setCreated(result.loopRunId)
    } catch (failure) { if (current.current === owner) setError(failure instanceof Error ? failure.message : t('loopExplorer.forkFailed')) }
    finally { if (current.current === owner) { inFlight.current = false; setBusy(false) } }
  }
  return { busy, error, created, fork }
}
