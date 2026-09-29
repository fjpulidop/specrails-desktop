import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { API_ORIGIN } from '../../../lib/origin'
import { useTicketDetailModal } from '../../specs/context/TicketDetailModalContext'
import type { AgentRefTarget } from '../lib/agent-refs'
import type { LoopGraph } from '../../loops/lib/loops-api'
import { openExternalUrl } from '../../../lib/tauri-shell'

export interface AgentJobRef {
  projectId: string
  jobId: string
}

/** What the loop preview modal needs — a stored loop (built-ins included) or,
 *  when a built-in has no stored row yet, its read-only factory default. */
export interface AgentLoopRef {
  id: string
  name: string
  description: string | null
  /** 'draft' | 'published' for stored loops; null for an unseeded factory default. */
  status: string | null
  graph: LoopGraph
  /** Built-in (`factory:*`) loop — editable in the builder when stored. */
  builtin: boolean
  /** Not editable in the builder (an unseeded factory default). */
  locked: boolean
}

interface StoredLoop { id: string; name: string; description: string | null; status: string; graph: LoopGraph; builtinId?: string }
interface FactoryEntry { id: string; name: string; description: string; graph: LoopGraph; editable?: boolean; status?: string }

/** Loops are APP-GLOBAL (`/api/loops`, no project scope). Returns null on miss
 *  (unknown id, loops section disabled, network hiccup handled by caller).
 *  Built-ins are stored loops whose id is the factory id, so the stored row is
 *  tried first; `/loops/factory` (its `factoryLoops` list) is the fallback. */
async function fetchLoopRef(loopId: string): Promise<AgentLoopRef | null> {
  const res = await fetch(`${API_ORIGIN}/api/loops/${encodeURIComponent(loopId)}`)
  if (res.ok) {
    const loop = ((await res.json()) as { loop?: StoredLoop }).loop
    if (loop) return { id: loop.id, name: loop.name, description: loop.description, status: loop.status, graph: loop.graph, builtin: Boolean(loop.builtinId), locked: false }
  }
  if (!loopId.startsWith('factory:')) return null
  const factory = await fetch(`${API_ORIGIN}/api/loops/factory`)
  if (!factory.ok) return null
  const hit = (((await factory.json()) as { factoryLoops?: FactoryEntry[] }).factoryLoops ?? []).find((l) => l.id === loopId)
  return hit
    ? { id: hit.id, name: hit.name, description: hit.description, status: hit.editable ? (hit.status ?? 'published') : null, graph: hit.graph, builtin: true, locked: hit.editable !== true }
    : null
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
