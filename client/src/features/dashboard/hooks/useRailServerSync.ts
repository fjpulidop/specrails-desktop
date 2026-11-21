/**
 * Server reconciliation of the client-local rails projection: the
 * bidirectional reconcile against `GET /rails` on mount / project switch /
 * reconnect, and adoption of server-side rail names (desktop ⇄ mobile sync).
 */
import { useEffect, type Dispatch, type SetStateAction } from 'react'
import { getApiBase } from '../../../lib/api'
import type { RailState } from '../../rails/components/RailsBoard'
import { deriveRailMode, adoptedSelectedLoopId } from '../../rails/lib/rail-loops'
import { railIdFromIndex, railIndexFromId } from '../../rails/lib/rail-id'
import { INITIAL_RAILS, loadRails, saveRails, toRailMode } from '../lib/board-rails'

export function useRailServerSync(
  activeProjectId: string | null,
  connectionStatus: string,
  setRails: Dispatch<SetStateAction<RailState[]>>,
) {
  // ── Reconcile rails against the server on mount / project switch / reconnect ─
  // The Kanban's rail state is a client-local projection (localStorage + live WS
  // while THIS component is mounted). Launches can happen while it is unmounted
  // — the global agent via MCP (Agent Mode), the mobile companion, another
  // window — and after a server restart stale 'running' state persists locally.
  // So this reconcile is BIDIRECTIONAL and always runs:
  //   • server-active rail, local idle  → ADOPT (running + activeJobId + the
  //     server's ticket assignment), so an agent-launched rail lights up here;
  //   • local running, server inactive  → CLEAR (finished while we were away);
  //   • both running                    → restore a lost activeJobId only.
  useEffect(() => {
    if (connectionStatus !== 'connected' || !activeProjectId) return

    let cancelled = false
    // Snapshot BEFORE the fetch: a rail that goes running only AFTER this point
    // was launched locally while the request was in flight — the (stale)
    // response must not clear that optimistic state back to idle.
    const preRails = loadRails(activeProjectId) ?? INITIAL_RAILS
    const preById = new Map(preRails.map((p) => [p.id, p]))
    fetch(`${getApiBase()}/rails`)
      .then((res) => res.ok ? res.json() : null)
      .then((data: {
        rails?: { railIndex: number; ticketIds?: number[]; mode?: string; name?: string | null }[]
        activeJobs?: Record<string, { jobId: string; mode?: string }>
        activeLoopRuns?: Record<string, { loopRunId: string; loopId?: string }>
      } | null) => {
        if (cancelled || !data) return
        const activeJobs = data.activeJobs ?? {}
        // Loop-mode rails track an active LOOP run (not a queue job), so a rail
        // running a loop must be treated as still-running here too — otherwise
        // refresh wrongly clears it and releases its in-flight ticket.
        const activeLoopRuns = data.activeLoopRuns ?? {}
        const activeIndices = new Set<number>([
          ...Object.keys(activeJobs).map(Number),
          ...Object.keys(activeLoopRuns).map(Number),
        ])
        const serverRails = data.rails ?? []
        const serverTicketsByIndex = new Map<number, number[]>()
        for (const r of serverRails) {
          serverTicketsByIndex.set(r.railIndex, Array.isArray(r.ticketIds) ? r.ticketIds : [])
        }
        const serverIndices = new Set(serverRails.map((r) => r.railIndex))
        setRails((prev) => {
          let changed = false
          const adoptedTickets = new Map<string, number[]>()
          const next = prev.map((r, pos) => {
            // IDENTITY, not position: rail id `rail-N` ↔ server railIndex N-1
            // (a reordered board or a deleted middle rail breaks the positional
            // assumption). Exotic ids (test fixtures) fall back to position.
            const idx = railIndexFromId(r.id) ?? pos
            const loopRun = activeLoopRuns[String(idx)]
            const serverJobId = activeJobs[String(idx)]?.jobId ?? loopRun?.loopRunId
            if (activeIndices.has(idx)) {
              if (r.status === 'running') {
                // Still running — restore the active id (job or loop run) if lost.
                if (serverJobId && !r.activeJobId) {
                  changed = true
                  return { ...r, activeJobId: serverJobId }
                }
                return r
              }
              // Was running when the fetch STARTED but idle now: a completion WS
              // event landed during the round-trip — the response is stale, do
              // not resurrect the finished run.
              if (preById.get(r.id)?.status === 'running') return r
              // Idle locally but EXECUTING server-side: launched while this board
              // was unmounted (agent via MCP, mobile, another window). Adopt the
              // run + the server's ticket assignment. Desktop launches always
              // register as LOOP runs (factory:implement etc.) — derive the real
              // mode from the loopId instead of hardcoding 'loop'.
              const serverTickets = serverTicketsByIndex.get(idx) ?? []
              const jobMode = activeJobs[String(idx)]?.mode
              const serverMode = toRailMode(jobMode) ?? (loopRun ? deriveRailMode(loopRun.loopId) : undefined)
              const ticketIds = serverTickets.length ? serverTickets : r.ticketIds
              adoptedTickets.set(r.id, ticketIds)
              changed = true
              return {
                ...r,
                status: 'running' as const,
                activeJobId: serverJobId,
                ticketIds,
                mode: serverMode ?? r.mode,
                // A custom loop needs its id selected for the rail header to
                // label the run; factory loops keep the rail's own selection.
                ...(adoptedSelectedLoopId(loopRun?.loopId) ? { selectedLoopId: adoptedSelectedLoopId(loopRun?.loopId) } : {}),
              }
            }
            if (r.status !== 'running') return r
            // Launched locally AFTER the fetch started (optimistic 202 state):
            // the response predates the launch — leave it alone.
            if (preById.get(r.id)?.status !== 'running') return r
            // Rail was running but server has no active job → job finished while
            // we were away. Clear tickets so they reappear in Specs/Done based
            // on their current server-side status (useTickets re-fetches on mount).
            changed = true
            return { ...r, status: 'idle' as const, activeJobId: undefined, ticketIds: [] }
          })
          // ADOPT server rails this board doesn't know yet (created via the
          // agent/MCP create_rail, mobile, another window) so every rail has a
          // board row — including its assignment and any in-flight run.
          const knownIds = new Set(next.map((r) => r.id))
          const appended: RailState[] = []
          for (const sr of serverRails) {
            const id = railIdFromIndex(sr.railIndex)
            if (knownIds.has(id)) continue
            const loopRun = activeLoopRuns[String(sr.railIndex)]
            const jobMode = activeJobs[String(sr.railIndex)]?.mode
            const mode = toRailMode(jobMode)
              ?? (loopRun ? deriveRailMode(loopRun.loopId) : toRailMode(sr.mode) ?? 'implement')
            const running = activeIndices.has(sr.railIndex)
            const ticketIds = serverTicketsByIndex.get(sr.railIndex) ?? []
            appended.push({
              id,
              label: sr.name ? `Rail ${sr.name}` : `Rail ${sr.railIndex + 1}`,
              ticketIds,
              mode,
              status: running ? ('running' as const) : ('idle' as const),
              activeJobId: activeJobs[String(sr.railIndex)]?.jobId ?? loopRun?.loopRunId,
              ...(adoptedSelectedLoopId(loopRun?.loopId) ? { selectedLoopId: adoptedSelectedLoopId(loopRun?.loopId) } : {}),
            })
            if (ticketIds.length > 0) adoptedTickets.set(id, ticketIds)
            changed = true
          }
          // DROP local rails the server deleted elsewhere — only when they are
          // safe to drop (idle + empty), so an optimistic local state is never
          // destroyed. Guarded on a non-empty server list (a failed/odd payload
          // must not wipe the board), and a rail that did NOT exist when the
          // fetch STARTED was added while the request was in flight (Add rail's
          // optimistic append) — the stale response must not remove it.
          let merged = appended.length > 0 ? [...next, ...appended] : next
          if (serverRails.length > 0) {
            const kept = merged.filter((r) => {
              const idx = railIndexFromId(r.id)
              if (idx === null || serverIndices.has(idx)) return true
              if (!preById.has(r.id)) return true
              return r.status === 'running' || r.ticketIds.length > 0
            })
            if (kept.length !== merged.length) {
              merged = kept
              changed = true
            }
          }
          if (!changed) return prev
          // An adopted ticket may still sit on ANOTHER rail from a local drag —
          // strip it there (mirrors handleMoveTicketToRail) so no ticket renders
          // on two rails at once (duplicate dnd ids / double-launch risk).
          const adoptedIdSet = new Set([...adoptedTickets.values()].flat())
          const deduped = adoptedIdSet.size
            ? merged.map((r) => {
                if (adoptedTickets.has(r.id)) return r
                const filtered = r.ticketIds.filter((id) => !adoptedIdSet.has(id))
                return filtered.length === r.ticketIds.length ? r : { ...r, ticketIds: filtered }
              })
            : merged
          saveRails(activeProjectId, deduped)
          return deduped
        })
      })
      .catch(() => {})

    return () => { cancelled = true }
  }, [activeProjectId, connectionStatus, setRails])

  // ── Adopt server-side rail names on load/switch (desktop ⇄ mobile sync) ──────
  // Names only — never ticketIds — so a fresh load can't clobber locally-dragged
  // assignments. A null server name leaves the local label untouched (so an
  // existing desktop-only custom label survives until explicitly renamed).
  useEffect(() => {
    if (!activeProjectId) return
    let cancelled = false
    fetch(`${getApiBase()}/rails`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { rails?: { railIndex: number; name?: string | null }[] } | null) => {
        if (cancelled || !data?.rails) return
        const nameByIndex = new Map<number, string | null>()
        for (const r of data.rails) nameByIndex.set(r.railIndex, r.name ?? null)
        setRails((prev) => {
          let changed = false
          const next = prev.map((r, pos) => {
            const idx = railIndexFromId(r.id) ?? pos
            const name = nameByIndex.get(idx) ?? null
            if (!name) return r
            const label = `Rail ${name}`
            if (label === r.label) return r
            changed = true
            return { ...r, label }
          })
          if (!changed) return prev
          saveRails(activeProjectId, next)
          return next
        })
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [activeProjectId, setRails])
}
