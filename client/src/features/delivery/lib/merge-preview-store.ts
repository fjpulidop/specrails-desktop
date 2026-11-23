import type { DeliveryMergePreview } from './merge-preview'

/**
 * One shared copy of a project's merge previews for every delivery strip on
 * screen: one request per refresh (not one per card), refreshed when a strip
 * mounts after {@link FRESH_MS} and, debounced, on the WebSocket events that
 * can change a merge (a delivery state, a run ending, a server-side refresh).
 * Keyed by project; a strip only reads its own project's entry.
 */
const FRESH_MS = 15_000
const NUDGE_DEBOUNCE_MS = 1_000
export const MERGE_PREVIEW_NUDGES = new Set(['rail.pr_state', 'rail.job_completed', 'rail.job_stopped', 'rail.merge_preview'])

interface ProjectEntry {
  previews: Map<string, DeliveryMergePreview>
  fetchedAt: number
  inflight: Promise<void> | null
  timer: ReturnType<typeof setTimeout> | null
  listeners: Set<() => void>
  version: number
  /** The project's API base (`getApiBase(projectId)`), from the subscribing hook. */
  base: string
}

const projects = new Map<string, ProjectEntry>()

function entry(projectId: string): ProjectEntry {
  let e = projects.get(projectId)
  if (!e) {
    e = { previews: new Map(), fetchedAt: 0, inflight: null, timer: null, listeners: new Set(), version: 0, base: '' }
    projects.set(projectId, e)
  }
  return e
}

export function refreshMergePreviews(projectId: string): Promise<void> {
  const e = entry(projectId)
  if (e.inflight) return e.inflight
  if (!e.base) return Promise.resolve()
  e.inflight = (async () => {
    try {
      const res = await fetch(`${e.base}/rails/merge-preview`)
      if (!res.ok) return
      const body = await res.json() as { previews?: DeliveryMergePreview[] }
      const next = new Map((body.previews ?? []).map((p) => [p.deliveryId, p]))
      if (JSON.stringify([...next]) !== JSON.stringify([...e.previews])) {
        e.previews = next
        e.version++
        for (const listener of e.listeners) listener()
      }
      e.fetchedAt = Date.now()
    } catch { /* keep what we had */ } finally {
      e.inflight = null
    }
  })()
  return e.inflight
}

export function subscribeMergePreviews(projectId: string, base: string, listener: () => void): () => void {
  const e = entry(projectId)
  e.base = base
  e.listeners.add(listener)
  if (Date.now() - e.fetchedAt > FRESH_MS) void refreshMergePreviews(projectId)
  return () => { e.listeners.delete(listener) }
}

export function mergePreviewVersion(projectId: string): number {
  return projects.get(projectId)?.version ?? 0
}

export function readMergePreview(projectId: string, deliveryId: string): DeliveryMergePreview | null {
  return projects.get(projectId)?.previews.get(deliveryId) ?? null
}

/** A WebSocket frame arrived: refresh this project's previews (debounced) when it can change them. */
export function nudgeMergePreviews(projectId: string, message: unknown): void {
  const m = message as { type?: unknown; projectId?: unknown } | null
  if (!m || typeof m.type !== 'string' || !MERGE_PREVIEW_NUDGES.has(m.type) || m.projectId !== projectId) return
  const e = entry(projectId)
  if (e.listeners.size === 0) return
  if (e.timer) clearTimeout(e.timer)
  e.timer = setTimeout(() => { e.timer = null; void refreshMergePreviews(projectId) }, NUDGE_DEBOUNCE_MS)
}

/** Test-only. */
export function __resetMergePreviewStore(): void {
  for (const e of projects.values()) if (e.timer) clearTimeout(e.timer)
  projects.clear()
}
