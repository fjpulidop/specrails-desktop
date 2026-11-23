import { describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('../../lib/app-updater', () => ({ checkAppUpdate: vi.fn() }))

import type { DownloadEvent } from '@tauri-apps/plugin-updater'
import { readUpdateCommand, runRemoteUpdate, type RemoteUpdateDeps, type UpdateCommand } from '../useDesktopUpdateRemote'
import type { DesktopUpdate } from '../useDesktopUpdateNotifier'

// The install the server relays (desktop.update_command) runs the app's own flow; nothing real installs here.

const update = (version = '3.6.0'): DesktopUpdate => ({
  currentVersion: '3.5.0',
  version,
  async downloadAndInstall(onEvent: (event: DownloadEvent) => void) {
    onEvent({ event: 'Started', data: { contentLength: 100 } } as DownloadEvent)
    for (let i = 0; i < 4; i += 1) onEvent({ event: 'Progress', data: { chunkLength: 25 } } as DownloadEvent)
    onEvent({ event: 'Finished' } as DownloadEvent)
  },
})

function deps(overrides: Partial<RemoteUpdateDeps> = {}) {
  const reports: Array<Record<string, unknown>> = []
  const value: RemoteUpdateDeps = {
    check: vi.fn(async () => update()),
    report: vi.fn(async (body) => { reports.push(body) }),
    activeWork: vi.fn(async () => ({ missions: 0, runs: 0, total: 0 })),
    restart: vi.fn(async () => undefined),
    sleep: vi.fn(async () => undefined),
    offer: vi.fn(),
    ...overrides,
  }
  return { value, reports, phases: () => reports.map((r) => r.phase) }
}

const command = (restart: UpdateCommand['restart']): UpdateCommand => ({ op: 'apply', version: '3.6.0', restart, requestId: 'r1' })

describe('desktop update relay', () => {
  it('reads only well-formed commands', () => {
    expect(readUpdateCommand({ type: 'desktop.update_command', op: 'apply', version: '3.6.0', requestId: 'r', restart: 'bogus' })).toEqual({ op: 'apply', version: '3.6.0', restart: 'when_idle', requestId: 'r' })
    expect(readUpdateCommand({ type: 'desktop.update_command', op: 'rm -rf', version: '1', requestId: 'r' })).toBeNull()
    expect(readUpdateCommand({ type: 'other' })).toBeNull()
  })

  it('installs, reports progress and restarts once idle', async () => {
    let busy = 2
    const d = deps({ activeWork: vi.fn(async () => ({ missions: 0, runs: busy, total: busy-- > 0 ? 1 : 0 })) })
    await runRemoteUpdate(command('when_idle'), d.value)
    expect(d.phases()).toEqual(['checking', 'downloading', 'downloading', 'downloading', 'downloading', 'downloading', 'installing', 'waiting', 'restarting'])
    expect(d.reports.every((r) => r.requestId === 'r1')).toBe(true)
    expect(d.value.sleep).toHaveBeenCalledTimes(2)
    expect(d.value.restart).toHaveBeenCalledTimes(1)
    expect(d.value.offer).toHaveBeenCalled()
  })

  it('never restarts on its own when asked not to', async () => {
    const d = deps()
    await runRemoteUpdate(command('never'), d.value)
    expect(d.phases().at(-1)).toBe('ready')
    expect(d.value.restart).not.toHaveBeenCalled()
  })

  it('refuses a version the person did not confirm', async () => {
    const d = deps({ check: vi.fn(async () => update('3.7.0')) })
    await runRemoteUpdate(command('now'), d.value)
    expect(d.phases()).toEqual(['checking', 'error'])
    expect(String(d.reports[1].error)).toContain('3.7.0')
    expect(d.value.restart).not.toHaveBeenCalled()
  })

  it('reports a failed download', async () => {
    const broken = { ...update(), downloadAndInstall: async () => { throw new Error('signature mismatch') } }
    const d = deps({ check: vi.fn(async () => broken) })
    await runRemoteUpdate(command('now'), d.value)
    expect(d.reports.at(-1)).toMatchObject({ phase: 'error', error: 'signature mismatch' })
  })
})
