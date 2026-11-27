import { OPEN_MISSION_EVENT, requestOpenMission } from '../../../lib/mission-events'
import { isTauri } from '../../../lib/tauri-shell'
import { isLoopWindowRoute } from './loop-windows'

/** Answer of `POST /api/pr-ci/runs` (Loops ▸ Fix PR CI ▸ Run on a PR). */
export type PrCiRunResult =
  | { ok: true; projectId: string; conversationId: string; admissionId: string; runId: string; alreadyRunning: boolean }
  | { ok: false; error: string; detail: string; projectId?: string; conversationId?: string; projects?: Array<{ id: string; name: string }> }

/** Start the built-in Fix PR CI loop on a pull request; the server picks the project by its repository. */
export async function runFixCiOnPr(prUrl: string, projectId?: string): Promise<PrCiRunResult> {
  const res = await fetch('/api/pr-ci/runs', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prUrl: prUrl.trim(), ...(projectId ? { projectId } : {}) }),
  })
  let body: Record<string, unknown> = {}
  try { body = await res.json() as Record<string, unknown> } catch { /* empty body */ }
  if (res.ok) return { ok: true, ...(body as Omit<Extract<PrCiRunResult, { ok: true }>, 'ok'>) }
  return {
    ok: false,
    error: typeof body.error === 'string' ? body.error : `http_${res.status}`,
    detail: typeof body.detail === 'string' ? body.detail : '',
    ...(typeof body.projectId === 'string' ? { projectId: body.projectId } : {}),
    ...(typeof body.conversationId === 'string' ? { conversationId: body.conversationId } : {}),
    ...(Array.isArray(body.projects) ? { projects: body.projects as Array<{ id: string; name: string }> } : {}),
  }
}

/** Show a mission where missions live: this window, or the main window from a loop editor window. */
export async function showMissionInMainWindow(conversationId: string): Promise<void> {
  if (!isLoopWindowRoute()) { requestOpenMission(conversationId); return }
  if (isTauri()) {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('loop_window_open_mission', { conversationId })
    return
  }
  const opener = window.opener as (Window & typeof globalThis) | null
  if (opener && !opener.closed) {
    opener.dispatchEvent(new opener.CustomEvent(OPEN_MISSION_EVENT, { detail: { conversationId } }))
    opener.focus()
  }
}
