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

export type PrCiLiveState = 'green' | 'red' | 'pending' | 'none' | 'conflict' | 'closed' | 'unknown'
export interface PrCiLivePr { repository: string; prUrl: string; prNumber: number | null; state: PrCiLiveState; total: number; pending: number; failing: string[] }
/** The PR card's CI view: one state for the delivery, with the failing checks per PR. */
export interface PrCiLiveView { state: PrCiLiveState; failing: Array<{ pr: string; checks: string[] }>; pending: number; byPrUrl: Record<string, PrCiLiveState> }

const STATE_ORDER: PrCiLiveState[] = ['red', 'conflict', 'pending', 'green', 'none', 'closed', 'unknown']

/** Combine per-PR states: any red wins, then conflict, then running, then green. */
export function prCiLiveView(prs: readonly PrCiLivePr[]): PrCiLiveView | null {
  const known = prs.filter((pr) => pr.state !== 'unknown')
  if (!known.length) return null
  const state = STATE_ORDER.find((candidate) => known.some((pr) => pr.state === candidate)) ?? 'unknown'
  const many = prs.length > 1
  return {
    state,
    pending: known.reduce((sum, pr) => sum + pr.pending, 0),
    byPrUrl: Object.fromEntries(prs.map((pr) => [pr.prUrl, pr.state])),
    failing: known.filter((pr) => pr.failing.length).map((pr) => ({ pr: many ? [pr.repository, pr.prNumber !== null ? `#${pr.prNumber}` : ''].filter(Boolean).join(' ') : '', checks: pr.failing })),
  }
}

/** Live CI of a delivery's open PR(s) (GET /rails/pr-ci-status). Never throws; null when unknown. */
export async function fetchPrCiStatus(projectId: string, deliveryId: string): Promise<PrCiLivePr[] | null> {
  try {
    const res = await fetch(`${API_ORIGIN}/api/projects/${encodeURIComponent(projectId)}/rails/pr-ci-status?deliveryId=${encodeURIComponent(deliveryId)}`)
    if (!res.ok) return null
    const data = await res.json() as { prs?: unknown }
    return Array.isArray(data.prs) ? data.prs as PrCiLivePr[] : null
  } catch { return null }
}

/** Polls while checks run (and once per `refreshKey`), so the card follows CI without a reload. */
export function usePrCiStatus(projectId: string | null | undefined, deliveryId: string, enabled: boolean, refreshKey: unknown): PrCiLiveView | null {
  const [view, setView] = useState<PrCiLiveView | null>(null)
  useEffect(() => {
    setView(null)
    if (!projectId || !enabled) return
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = async () => {
      const prs = await fetchPrCiStatus(projectId, deliveryId)
      if (!live) return
      const next = prs ? prCiLiveView(prs) : null
      setView(next)
      if (next?.state === 'pending') timer = setTimeout(() => { void load() }, 60_000)
    }
    void load()
    return () => { live = false; if (timer) clearTimeout(timer) }
  }, [projectId, deliveryId, enabled, refreshKey])
  return view
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
