import { useContext, useEffect, useId } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { relaunch } from '@tauri-apps/plugin-process'
import type { DownloadEvent } from '@tauri-apps/plugin-updater'
import { API_ORIGIN } from '../lib/origin'
import { checkAppUpdate } from '../lib/app-updater'
import { fetchActiveWork, noteUpdateRestart, type ActiveWork } from '../lib/continuity-api'
import { SharedWebSocketContext } from './useSharedWebSocket'
import { IDLE_POLL_MS, desktopUpdateOffer, isTauriRuntime, type DesktopUpdate } from './useDesktopUpdateNotifier'

/**
 * Desktop updates asked for over HTTP (server `desktop-router-updates.ts`,
 * MCP `specrails_system(updates, op: apply)`): the window is the only place
 * the Tauri updater runs, so the server relays the person's confirmed request
 * as `desktop.update_command` and this hook runs the app's own install flow,
 * reporting each phase back. Restart honours the request: `when_idle` waits
 * until nothing runs, `now` restarts, `never` leaves the ready card to the person.
 */

export const REPORT_HEARTBEAT_MS = 5 * 60 * 1000

export interface UpdateCommand { op: 'apply'; version: string; restart: 'when_idle' | 'now' | 'never'; requestId: string }

export interface RemoteUpdateDeps {
  check: () => Promise<DesktopUpdate | null>
  report: (body: Record<string, unknown>) => Promise<void>
  activeWork: () => Promise<ActiveWork | null>
  restart: () => Promise<void>
  sleep: (ms: number) => Promise<void>
  offer: (update: DesktopUpdate) => void
  signal?: AbortSignal
}

export function readUpdateCommand(message: unknown): UpdateCommand | null {
  const m = (message ?? {}) as Record<string, unknown>
  if (m.type !== 'desktop.update_command' || m.op !== 'apply' || typeof m.version !== 'string' || typeof m.requestId !== 'string') return null
  const restart = m.restart === 'now' || m.restart === 'never' ? m.restart : 'when_idle'
  return { op: 'apply', version: m.version, restart, requestId: m.requestId }
}

/** One confirmed install: check → download/install (progress) → restart per policy. */
export async function runRemoteUpdate(command: UpdateCommand, deps: RemoteUpdateDeps): Promise<void> {
  const report = (phase: string, extra: Record<string, unknown> = {}) => deps.report({ phase, requestId: command.requestId, version: command.version, ...extra }).catch(() => undefined)
  try {
    await report('checking')
    const update = await deps.check()
    if (!update) { await report('error', { error: 'No update is available from the app updater.' }); return }
    if (update.version !== command.version) { await report('error', { error: `The updater offers ${update.version}, not ${command.version}.` }); return }
    let total: number | null = null
    let downloaded = 0
    let lastReported = -1
    await report('downloading', { progress: 0 })
    await update.downloadAndInstall((event: DownloadEvent) => {
      if (event.event === 'Started') { total = event.data.contentLength ?? null; return }
      if (event.event === 'Progress') {
        downloaded += event.data.chunkLength
        const progress = total ? Math.min(100, Math.round((downloaded / total) * 100)) : null
        if (progress !== null && progress >= lastReported + 10) { lastReported = progress; void report('downloading', { progress }) }
        return
      }
      void report('installing')
    })
    deps.offer(update)
    if (command.restart === 'never' || update.isMock) { await report('ready'); return }
    if (command.restart === 'when_idle') {
      await report('waiting')
      for (;;) {
        if (deps.signal?.aborted) return
        const work = await deps.activeWork()
        if (work && work.total === 0) break
        await deps.sleep(IDLE_POLL_MS)
      }
    }
    await report('restarting')
    await deps.restart()
  } catch (err) {
    await report('error', { error: (err as Error)?.message || 'The update failed.' })
  }
}

async function postReport(body: Record<string, unknown>): Promise<void> {
  await fetch(`${API_ORIGIN}/api/desktop-updates/report`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
}

async function restartApp(): Promise<void> {
  await noteUpdateRestart()
  // Same path as the update card: the Rust command stops the sidecar first (no port conflict).
  void invoke('restart_app').catch(() => { void relaunch() })
}

export function useDesktopUpdateRemote(): void {
  const ws = useContext(SharedWebSocketContext)
  const handlerId = `desktop-update-remote:${useId()}`
  const registerHandler = ws?.registerHandler
  const unregisterHandler = ws?.unregisterHandler
  useEffect(() => {
    if (!isTauriRuntime() || !registerHandler || !unregisterHandler) return
    const controller = new AbortController()
    let busy = false
    // Presence: the server only relays an install while a window reported recently.
    const hello = () => { if (!busy) void postReport({ phase: desktopUpdateOffer.get() ? 'available' : 'idle' }).catch(() => undefined) }
    hello()
    const heartbeat = setInterval(hello, REPORT_HEARTBEAT_MS)
    registerHandler(handlerId, (message) => {
      const command = readUpdateCommand(message)
      if (!command || busy) return
      busy = true
      void runRemoteUpdate(command, {
        check: () => checkAppUpdate(),
        report: postReport,
        activeWork: () => fetchActiveWork(controller.signal),
        restart: restartApp,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        offer: (update) => { if (!desktopUpdateOffer.get()) desktopUpdateOffer.set(update) },
        signal: controller.signal,
      }).finally(() => { busy = false })
    })
    return () => { controller.abort(); clearInterval(heartbeat); unregisterHandler(handlerId) }
  }, [registerHandler, unregisterHandler, handlerId])
}
