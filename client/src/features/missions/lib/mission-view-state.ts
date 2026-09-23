import { useSyncExternalStore } from 'react'
import type { MissionWindowSnapshot } from './mission-windows'

// Renderer-local state is transferred explicitly, never raced through shared
// localStorage. Revisions remount the same conversation after reintegration.
const code = new Map<string, { path: string | null; repositoryId: string | null }>()
export function readMissionCode(projectId: string, conversationId: string) { return code.get(`${projectId}:${conversationId}`) ?? { path: null, repositoryId: null } }
export function saveMissionCode(projectId: string, conversationId: string, value: Partial<{ path: string | null; repositoryId: string | null }>) {
  code.set(`${projectId}:${conversationId}`, { ...readMissionCode(projectId, conversationId), ...value })
}
const scroll = new Map<string, MissionWindowSnapshot['scroll']>()
const revisions = new Map<string, number>()
const blockers = new Map<string, Set<symbol>>()
const listeners = new Set<() => void>()
export function saveMissionScroll(id: string, value: MissionWindowSnapshot['scroll']) { scroll.set(id, value) }
export function readMissionScroll(id: string) { return scroll.get(id) ?? null }
export function restoreMissionView(id: string, value: MissionWindowSnapshot['scroll']) {
  scroll.set(id, value)
  revisions.set(id, (revisions.get(id) ?? 0) + 1)
  listeners.forEach(listener => listener())
}
export function useMissionViewRevision(id: string) {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener) } }, () => revisions.get(id) ?? 0)
}
export function blockMissionTransfer(id: string): () => void {
  const token = Symbol()
  const entries = blockers.get(id) ?? new Set<symbol>()
  entries.add(token)
  blockers.set(id, entries)
  return () => { entries.delete(token); if (!entries.size) blockers.delete(id) }
}
export function missionTransferBlocked(id: string) { return Boolean(blockers.get(id)?.size) }
