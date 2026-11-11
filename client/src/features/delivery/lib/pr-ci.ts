/**
 * PR CI loop (pr-ci-loop) client calls, shared by the mission offer card, the
 * mission PR card and the dashboard rail strip. Project-scoped by the CARD's
 * project id (the mission chat is app-global), never by the active project.
 */
import { useEffect, useState } from 'react'
import { API_ORIGIN } from '../../../lib/origin'

export type PrCiLaunchOutcome = { kind: 'started'; loopRunIds: string[]; prDeliveryId: string | null } | { kind: 'failed'; status: number; code: string | null; detail: string }

/** Start "Watch and fix the PR's CI" on one delivery (POST /rails/:railIndex/pr-ci). Never throws. */
export async function postPrCiLaunch(projectId: string, railIndex: number, body: { prDeliveryId: string; originConversationId?: string | null }): Promise<PrCiLaunchOutcome> {
  try {
    const res = await fetch(`${API_ORIGIN}/api/projects/${encodeURIComponent(projectId)}/rails/${railIndex}/pr-ci`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prDeliveryId: body.prDeliveryId, ...(body.originConversationId ? { originConversationId: body.originConversationId, originSurface: 'agent-chat' } : { originSurface: 'dashboard' }) }),
    })
    const data = await res.json().catch(() => ({})) as Record<string, unknown>
    if (res.status === 202) return { kind: 'started', loopRunIds: Array.isArray(data.loopRunIds) ? data.loopRunIds.filter((id): id is string => typeof id === 'string') : [], prDeliveryId: typeof data.prDeliveryId === 'string' ? data.prDeliveryId : null }
    const code = typeof data.error === 'string' ? data.error : typeof data.code === 'string' ? data.code : null
    return { kind: 'failed', status: res.status, code, detail: [typeof data.detail === 'string' ? data.detail : code, typeof data.action === 'string' ? data.action : null].filter(Boolean).join(' — ') }
  } catch (error) {
    return { kind: 'failed', status: 0, code: null, detail: error instanceof Error ? error.message : String(error) }
  }
}

/** "Not now" on the CI offer of one delivery generation. Never throws. */
export async function postPrCiDismiss(projectId: string, prDeliveryId: string): Promise<boolean> {
  try {
    const res = await fetch(`${API_ORIGIN}/api/projects/${encodeURIComponent(projectId)}/rails/pr-ci-offer/dismiss`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prDeliveryId }),
    })
    return res.ok
  } catch { return false }
}

/** Whether the project's Core can run the CI loop (feature flag + `hostTasks`). Any failure reads as false. */
export async function fetchPrCiAvailability(projectId: string): Promise<boolean> {
  try {
    const res = await fetch(`${API_ORIGIN}/api/projects/${encodeURIComponent(projectId)}/rails/pr-ci-availability`)
    if (!res.ok) return false
    const data = await res.json() as { available?: unknown }
    return data.available === true
  } catch { return false }
}


/** Whether the CARD's project can run the CI loop; refetched per project, never cached across projects. */
export function usePrCiAvailability(projectId: string | null | undefined): boolean {
  const [available, setAvailable] = useState(false)
  useEffect(() => {
    setAvailable(false)
    if (!projectId) return
    let live = true
    void fetchPrCiAvailability(projectId).then((value) => { if (live) setAvailable(value) })
    return () => { live = false }
  }, [projectId])
  return available
}

/** The built-in loop the offer starts. */
export const PR_CI_LOOP_ID = 'factory:pr-ci'

/** Mirror of the server's `ciFixAllowed` for the cards: every repository still under review has its PR. */
export function prCiFixable(input: {
  decision: string
  prUrl: string | null
  operation?: string | null
  repositoryDeliveries?: ReadonlyArray<{ decision: string; prUrl: string | null; branch: string | null; deliverySha: string | null }> | null
}): boolean {
  if ((input.decision !== 'pr_draft' && input.decision !== 'pr_ready') || input.operation) return false
  if (!input.repositoryDeliveries?.length) return Boolean(input.prUrl)
  const active = input.repositoryDeliveries.filter(repository => !['merged', 'completed', 'no_changes'].includes(repository.decision))
  return active.length > 0 && active.every(repository => Boolean(repository.prUrl && repository.branch && repository.deliverySha) && (repository.decision === 'pr_draft' || repository.decision === 'pr_ready'))
}
