import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Terminal } from '@xterm/xterm'
import { revealItemInDir } from '../tauri-shell'
import { saveScrollbackToFile } from '../save-scrollback'
import { notifyCommandFinished } from '../terminal-notifications'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))
const host = window as unknown as { __TAURI_INTERNALS__?: unknown }
const terminal = { buffer: { active: { length: 2, getLine: (i: number) => ({ translateToString: () => ['first line', 'second line'][i] }) } } } as unknown as Terminal

describe('explicit native desktop actions', () => {
  beforeEach(() => { invoke.mockReset().mockResolvedValue(true); host.__TAURI_INTERNALS__ = {} })
  afterEach(() => { delete host.__TAURI_INTERNALS__; vi.unstubAllGlobals() })

  it('passes the complete path to the host reveal command and surfaces failures', async () => {
    const path = 'C:\\A B\\file & test.txt'
    await revealItemInDir(path)
    expect(invoke).toHaveBeenCalledWith('desktop_reveal_path', { path })
    invoke.mockRejectedValueOnce(new Error('unavailable'))
    await expect(revealItemInDir(path)).rejects.toThrow('unavailable')
  })

  it('uses only the host save dialog and does not download after cancellation or failure', async () => {
    const anchor = vi.spyOn(document, 'createElement')
    invoke.mockResolvedValueOnce(false)
    await saveScrollbackToFile(terminal, 'terminal.txt')
    expect(invoke).toHaveBeenCalledWith('desktop_save_text', { suggestedName: 'terminal.txt', text: 'first line\nsecond line' })
    expect(anchor).not.toHaveBeenCalledWith('a')
    invoke.mockRejectedValueOnce(new Error('disk full'))
    await expect(saveScrollbackToFile(terminal)).rejects.toThrow('disk full')
    expect(anchor).not.toHaveBeenCalledWith('a')
    anchor.mockRestore()
  })

  it('uses host notifications without falling back to a web permission prompt', async () => {
    const notification = vi.fn()
    Object.assign(notification, { permission: 'default', requestPermission: vi.fn() })
    vi.stubGlobal('Notification', notification)
    await notifyCommandFinished('native-success', { command: 'npm test', exitCode: 0, elapsedMs: 1000 })
    expect(invoke).toHaveBeenCalledWith('desktop_notify', { title: expect.stringContaining('npm test'), body: expect.any(String) })
    invoke.mockRejectedValueOnce(new Error('notifications disabled'))
    await expect(notifyCommandFinished('native-denied', { command: 'test', exitCode: 1, elapsedMs: 1000 })).resolves.toBeUndefined()
    expect(notification).not.toHaveBeenCalled()
    expect(Notification.requestPermission).not.toHaveBeenCalled()
  })

  it('keeps reveal a no-op in ordinary browsers', async () => {
    delete host.__TAURI_INTERNALS__
    await revealItemInDir('/tmp/example')
    expect(invoke).not.toHaveBeenCalled()
  })
})
