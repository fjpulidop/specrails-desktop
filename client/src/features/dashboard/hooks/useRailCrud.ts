/**
 * Rail lifecycle actions of the board: add (server-backed with a local
 * fallback), delete (server guards decide) and rename (synced to the server
 * so other clients see it live).
 */
import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { notifyError } from '../../../lib/notify-error'
import { getApiBase } from '../../../lib/api'
import type { RailState } from '../../rails/components/RailsBoard'
import { railIdFromIndex, railIndexFromId, MAX_RAILS } from '../../rails/lib/rail-id'
import type { RailsUpdater, SpecOrderUpdater } from './useBoardRails'

export function useRailCrud(rails: RailState[], updateRails: RailsUpdater, updateSpecOrder: SpecOrderUpdater) {
  const { t } = useTranslation('dashboard')

  // ── Add / Delete rails ──────────────────────────────────────────────────────
  const handleAddRail = useCallback(async () => {
    // SERVER-BACKED creation: the new rail gets durable identity (survives a
    // reload, visible to the agent/MCP, mobile and other windows). Falls back
    // to a local-only slot when the request fails (offline) — a local rail
    // becomes server-backed on its first name/ticket sync anyway.
    try {
      const res = await fetch(`${getApiBase()}/rails`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      if (res.ok) {
        const data = await res.json() as { rail?: { railIndex?: number } }
        const idx = data.rail?.railIndex
        if (typeof idx === 'number') {
          const id = railIdFromIndex(idx)
          updateRails((prev) => prev.some((r) => r.id === id)
            ? prev
            : [...prev, { id, label: `Rail ${idx + 1}`, ticketIds: [], mode: 'implement', status: 'idle' }])
          toast.success(t('toasts.railAdded', { n: idx + 1 }))
          return
        }
      } else {
        const data = await res.json().catch(() => ({ error: '' })) as { error?: string; maxRails?: number }
        if (data.error === 'rail_limit_reached') {
          notifyError(t('toasts.railLimitReached', { max: data.maxRails ?? MAX_RAILS }))
          return
        }
      }
    } catch { /* offline — fall through to the local-only slot */ }
    // Local fallback (legacy behavior): find the next available rail number.
    const existingNums = rails.map((r) => railIndexFromId(r.id)).filter((n): n is number => n !== null)
    const nextNum = existingNums.length > 0 ? Math.max(...existingNums) + 2 : 1
    const newRail: RailState = {
      id: `rail-${nextNum}`,
      label: `Rail ${nextNum}`,
      ticketIds: [],
      mode: 'implement',
      status: 'idle',
    }
    updateRails((prev) => [...prev, newRail])
    toast.success(t('toasts.railAdded', { n: nextNum }))
  }, [rails, updateRails, t])

  const handleDeleteRail = useCallback(async (railId: string) => {
    const rail = rails.find((r) => r.id === railId)
    if (!rail || rail.status === 'running') return
    const removeLocally = () => {
      // Return tickets to specs
      if (rail.ticketIds.length > 0) {
        updateSpecOrder((prev) => {
          const current = prev ?? []
          return [...current, ...rail.ticketIds]
        })
      }
      updateRails((prev) => prev.filter((r) => r.id !== railId))
      toast.info(t('toasts.railRemoved', { rail: rail.label }))
    }
    const railIndex = railIndexFromId(railId)
    if (railIndex === null) { removeLocally(); return }
    try {
      // The server releases assignments and removes the rail atomically after
      // validating last-rail, active-run, and pending-PR guards.
      const res = await fetch(`${getApiBase()}/rails/${railIndex}`, { method: 'DELETE' })
      // 404 = the server never knew this rail (legacy local-only) — still drop it.
      if (res.ok || res.status === 404) { removeLocally(); return }
      // 409 rail_active / pr_decision_pending, 400 last-rail:
      // the server knows something this board doesn't — keep the rail visible
      // and say exactly which guard refused the delete.
      const body = (await res.json().catch(() => null)) as { error?: unknown } | null
      const code = typeof body?.error === 'string' ? body.error : null
      if (code === 'rail_active') notifyError(t('toasts.railRunningStopFirst', { rail: rail.label }))
      else if (code === 'pr_decision_pending') notifyError(t('toasts.railDeletePrPending', { rail: rail.label }))
      else if (res.status === 400 || code === 'cannot_delete_last_rail') notifyError(t('toasts.railDeleteLastRail'))
      else notifyError(t('toasts.railDeleteFailed'), { retry: () => void handleDeleteRail(railId) })
    } catch {
      // Unknown server state: keep the rail visible until a successful retry
      // or refresh reconciles it. Optimistic removal here can desync the board.
      notifyError(t('toasts.railDeleteFailed'), { retry: () => void handleDeleteRail(railId) })
    }
  }, [rails, updateRails, updateSpecOrder, t])

  const handleRenameRail = useCallback((railId: string, newLabel: string) => {
    updateRails((prev) => prev.map((r) => (r.id === railId ? { ...r, label: `Rail ${newLabel}` } : r)))
    // Sync the name to the server so the mobile companion (and any other
    // desktop client) reflects it live via rail.updated. EVERY rail has server
    // identity now — the PUT also materializes a legacy local-only rail's
    // rail_meta row, making it server-backed from then on.
    const idx = railIndexFromId(railId)
    if (idx !== null) {
      fetch(`${getApiBase()}/rails/${idx}/name`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newLabel }),
      }).catch(() => { /* best-effort; localStorage already holds the label */ })
    }
  }, [updateRails])

  return { handleAddRail, handleDeleteRail, handleRenameRail }
}
