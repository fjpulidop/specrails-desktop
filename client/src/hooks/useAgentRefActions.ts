import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { API_ORIGIN } from '../lib/origin'
import { useTicketDetailModal } from '../context/TicketDetailModalContext'
import type { AgentRefTarget } from '../lib/agent-refs'
import type { LoopGraph } from '../lib/loops-api'
import { openExternalUrl } from '../lib/tauri-shell'

export interface AgentJobRef {
  projectId: string
  jobId: string
}

/** What the loop preview modal needs — a stored loop or a built-in factory one. */
export interface AgentLoopRef {
  id: string
  name: string
  description: string | null
  /** 'draft' | 'published' for stored loops; null for factory (built-in) loops. */
  status: string | null
  graph: LoopGraph
  /** Built-in factory loop — locked, not editable in the builder. */
  locked: boolean
}

/** Loops are APP-GLOBAL (`/api/loops`, no project scope). Returns null on miss
 *  (unknown id, loops section disabled, network hiccup handled by caller). */
async function fetchLoopRef(loopId: string): Promise<AgentLoopRef | null> {
  if (loopId.startsWith('factory:')) {
    const res = await fetch(`${API_ORIGIN}/api/loops/factory`)
    if (!res.ok) return null
    const body = (await res.json()) as { loops?: Array<{ id: string; name: string; description: string; graph: LoopGraph }> }
    const hit = (body.loops ?? []).find((l) => l.id === loopId)
    return hit ? { id: hit.id, name: hit.name, description: hit.description, status: null, graph: hit.graph, locked: true } : null
  }
  const res = await fetch(`${API_ORIGIN}/api/loops/${encodeURIComponent(loopId)}`)
  if (!res.ok) return null
  const body = (await res.json()) as { loop?: { id: string; name: string; description: string | null; status: string; graph: LoopGraph } }
  const loop = body.loop
  return loop ? { id: loop.id, name: loop.name, description: loop.description, status: loop.status, graph: loop.graph, locked: false } : null
}

async function fetchPullRequestUrl(projectId: string, prNumber: number): Promise<string | null> {
  const res = await fetch(`${API_ORIGIN}/api/projects/${projectId}/git/pull-requests/${prNumber}`)
  if (!res.ok) return null
  const body = (await res.json()) as { url?: unknown }
  return typeof body.url === 'string' && body.url ? body.url : null
}

/**
 * Click layer for agent-chat reference chips. Lazy verification on click
 * (linkify is pattern-only — no per-message fetches): the ref is fetched from
 * its OWNING project (`API_ORIGIN` precedent — never `getApiBase()`, the
 * conversation's pinned project may differ from the active one); a miss shows
 * a subtle "not found / maybe deleted" toast instead of a dead modal.
 *
 * - Tickets → `openTicketDetailInProject` (board TicketDetailModal; switches
 *   the active project first when the pin differs — see the provider).
 * - Pull requests → open their captured URL externally, or resolve a bare
 *   `PR #N` against the owning project's GitHub repo before opening it.
 * - Jobs/loop-runs (loop-run ids ARE job row ids) → `jobRef` state; the caller
 *   mounts the mission-mode `JobDetailModal` with the explicit `projectId`.
 *   A uuid that is NOT a job row falls back to the app-global loops API — a
 *   LOOP DEFINITION id mentioned in loop-talk resolves to the loop preview
 *   instead of a dead "job not found".
 * - Loops (factory ids, uuid fallback hits) → `loopRef` state; the caller
 *   mounts the read-only `LoopPreviewModal` (loops are app-global).
 */
export function useAgentRefActions() {
  const { t } = useTranslation('agent')
  const { openTicketDetailInProject } = useTicketDetailModal()
  const [jobRef, setJobRef] = useState<AgentJobRef | null>(null)
  const [loopRef, setLoopRef] = useState<AgentLoopRef | null>(null)

  const closeJobRef = useCallback(() => setJobRef(null), [])
  const closeLoopRef = useCallback(() => setLoopRef(null), [])

  const openRef = useCallback(
    async (projectId: string, ref: AgentRefTarget): Promise<void> => {
      try {
        if (ref.kind === 'ticket') {
          const res = await fetch(`${API_ORIGIN}/api/projects/${projectId}/tickets/${ref.ticketId}`)
          if (!res.ok) {
            toast.info(t('refs.ticketNotFound', { id: ref.ticketId }))
            return
          }
          openTicketDetailInProject(projectId, ref.ticketId)
        } else if (ref.kind === 'pull-request') {
          const prUrl = ref.prUrl ?? await fetchPullRequestUrl(projectId, ref.prNumber)
          if (!prUrl) {
            toast.info(t('refs.pullRequestNotFound', { id: ref.prNumber }))
            return
          }
          await openExternalUrl(prUrl)
        } else if (ref.kind === 'loop') {
          const loop = await fetchLoopRef(ref.loopId)
          if (!loop) {
            toast.info(t('refs.loopNotFound'))
            return
          }
          setLoopRef(loop)
        } else {
          const res = await fetch(`${API_ORIGIN}/api/projects/${projectId}/jobs/${ref.jobId}`)
          if (res.ok) {
            setJobRef({ projectId, jobId: ref.jobId })
            return
          }
          // Not a job row — the uuid may be a LOOP DEFINITION id (context words
          // overlap: "loop <uuid>" gates both). Try the app-global loops API.
          const loop = await fetchLoopRef(ref.jobId)
          if (loop) {
            setLoopRef(loop)
            return
          }
          toast.info(t('refs.jobNotFound'))
        }
      } catch {
        toast.info(t('refs.lookupFailed'))
      }
    },
    [openTicketDetailInProject, t],
  )

  return { openRef, jobRef, closeJobRef, loopRef, closeLoopRef }
}
