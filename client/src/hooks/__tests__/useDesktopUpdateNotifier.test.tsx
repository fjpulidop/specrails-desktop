import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor, render, screen, fireEvent } from '../../test-utils'

const customMock = vi.fn()
const dismissMock = vi.fn()
const successMock = vi.fn()
const checkMock = vi.fn()
const relaunchMock = vi.fn()
const invokeMock = vi.fn()

vi.mock('sonner', () => ({
  toast: {
    custom: (...args: unknown[]) => customMock(...args),
    dismiss: (...args: unknown[]) => dismissMock(...args),
    success: (...args: unknown[]) => successMock(...args),
  },
}))

// The notifier checks through the channel-aware helper (latest|stable).
vi.mock('../../lib/app-updater', () => ({
  checkAppUpdate: (...args: unknown[]) => checkMock(...args),
}))

vi.mock('@tauri-apps/plugin-process', () => ({
  relaunch: (...args: unknown[]) => relaunchMock(...args),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}))

const activeWorkMock = vi.fn()
const noteUpdateRestartMock = vi.fn()
vi.mock('../../lib/continuity-api', () => ({
  fetchActiveWork: (...args: unknown[]) => activeWorkMock(...args),
  noteUpdateRestart: (...args: unknown[]) => noteUpdateRestartMock(...args),
}))

import { useDesktopUpdateNotifier, DesktopUpdateToast } from '../useDesktopUpdateNotifier'

type ToastUpdate = Parameters<typeof DesktopUpdateToast>[0]['update']
type DownloadEventArg = Parameters<Parameters<ToastUpdate['downloadAndInstall']>[0]>[0]

function createTauriUpdate(): ToastUpdate {
  return {
    currentVersion: '1.50.0',
    version: '99.0.0-test',
    downloadAndInstall: vi.fn(async () => {}),
  }
}

describe('useDesktopUpdateNotifier', () => {
  beforeEach(() => {
    customMock.mockReset()
    dismissMock.mockReset()
    successMock.mockReset()
    checkMock.mockReset()
    relaunchMock.mockReset()
    invokeMock.mockReset()
    localStorage.clear()
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
    checkMock.mockResolvedValue(createTauriUpdate())
  })

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
  })

  it('calls toast.custom with unstyled:true and the documented options', async () => {
    renderHook(() => useDesktopUpdateNotifier())

    await waitFor(() => {
      expect(customMock).toHaveBeenCalled()
    })

    const [, options] = customMock.mock.calls[0]
    expect(options).toMatchObject({
      id: 'specrails-desktop-desktop-update',
      duration: Infinity,
      dismissible: false,
      unstyled: true,
      closeButton: false,
    })
  })

  it('does not surface a toast for a previously-dismissed version', async () => {
    localStorage.setItem('specrails-desktop:dismissedDesktopUpdateVersion', '99.0.0-test')
    renderHook(() => useDesktopUpdateNotifier())

    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(customMock).not.toHaveBeenCalled()
  })

  it('does nothing outside a Tauri runtime when mock mode is off', async () => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
    renderHook(() => useDesktopUpdateNotifier())

    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(checkMock).not.toHaveBeenCalled()
    expect(customMock).not.toHaveBeenCalled()
  })

  it('swallows a failed update check without surfacing a toast', async () => {
    checkMock.mockRejectedValue(new Error('network down'))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    renderHook(() => useDesktopUpdateNotifier())

    await waitFor(() => {
      expect(warnSpy).toHaveBeenCalled()
    })
    expect(customMock).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})

describe('DesktopUpdateToast', () => {
  beforeEach(() => {
    activeWorkMock.mockReset()
    activeWorkMock.mockResolvedValue({ missions: 0, runs: 0, total: 0 })
    noteUpdateRestartMock.mockReset()
    noteUpdateRestartMock.mockResolvedValue(undefined)
    dismissMock.mockReset()
    successMock.mockReset()
    relaunchMock.mockReset()
    invokeMock.mockReset()
    invokeMock.mockResolvedValue(undefined)
    localStorage.clear()
  })

  it('renders the available state with a version delta pill', () => {
    render(<DesktopUpdateToast update={createTauriUpdate()} />)
    expect(screen.getByText('Update available')).toBeInTheDocument()
    expect(screen.getByText('1.50.0 → 99.0.0-test')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Update' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument()
  })

  it('shows determinate progress with a progressbar role while downloading', async () => {
    let resolveInstall: (() => void) | undefined
    const update: ToastUpdate = {
      currentVersion: '1.50.0',
      version: '99.0.0-test',
      downloadAndInstall: vi.fn(
        (onEvent: (e: DownloadEventArg) => void) =>
          new Promise<void>((resolve) => {
            onEvent({ event: 'Started', data: { contentLength: 1000 } } as DownloadEventArg)
            onEvent({ event: 'Progress', data: { chunkLength: 500 } } as DownloadEventArg)
            resolveInstall = resolve
          }),
      ),
    }
    render(<DesktopUpdateToast update={update} />)
    fireEvent.click(screen.getByRole('button', { name: 'Update' }))

    const bar = await screen.findByRole('progressbar')
    expect(bar).toHaveAttribute('aria-valuenow', '50')
    expect(screen.getByText(/50% ·/)).toBeInTheDocument()

    resolveInstall?.()
    await screen.findByRole('button', { name: 'Restart' })
  })

  it('renders an indeterminate installing state with a disabled button', async () => {
    const update: ToastUpdate = {
      currentVersion: '1.50.0',
      version: '99.0.0-test',
      downloadAndInstall: vi.fn(
        (onEvent: (e: DownloadEventArg) => void) =>
          new Promise<void>(() => {
            onEvent({ event: 'Started', data: { contentLength: 1000 } } as DownloadEventArg)
            onEvent({ event: 'Progress', data: { chunkLength: 1000 } } as DownloadEventArg)
            onEvent({ event: 'Finished' } as DownloadEventArg)
          }),
      ),
    }
    render(<DesktopUpdateToast update={update} />)
    fireEvent.click(screen.getByRole('button', { name: 'Update' }))

    expect(await screen.findByText('Installing update')).toBeInTheDocument()
    const btn = screen.getByRole('button', { name: 'Installing…' })
    expect(btn).toBeDisabled()
  })

  it('reaches the ready state and restarts via the restart_app command', async () => {
    const update: ToastUpdate = {
      currentVersion: '1.50.0',
      version: '99.0.0-test',
      downloadAndInstall: vi.fn(async (onEvent: (e: DownloadEventArg) => void) => {
        onEvent({ event: 'Started', data: { contentLength: 1000 } } as DownloadEventArg)
        onEvent({ event: 'Progress', data: { chunkLength: 1000 } } as DownloadEventArg)
        onEvent({ event: 'Finished' } as DownloadEventArg)
      }),
    }
    render(<DesktopUpdateToast update={update} />)
    fireEvent.click(screen.getByRole('button', { name: 'Update' }))

    const restart = await screen.findByRole('button', { name: 'Restart' })
    expect(screen.getByText('Update ready')).toBeInTheDocument()
    fireEvent.click(restart)
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('restart_app'))
    expect(noteUpdateRestartMock).toHaveBeenCalled()
    expect(relaunchMock).not.toHaveBeenCalled()
  })

  it('falls back to relaunch() when the restart command is unavailable', async () => {
    invokeMock.mockRejectedValue(new Error('command not found'))
    const update: ToastUpdate = {
      currentVersion: '1.50.0',
      version: '99.0.0-test',
      downloadAndInstall: vi.fn(async (onEvent: (e: DownloadEventArg) => void) => {
        onEvent({ event: 'Finished' } as DownloadEventArg)
      }),
    }
    render(<DesktopUpdateToast update={update} />)
    fireEvent.click(screen.getByRole('button', { name: 'Update' }))
    const restart = await screen.findByRole('button', { name: 'Restart' })
    fireEvent.click(restart)
    await waitFor(() => expect(relaunchMock).toHaveBeenCalled())
  })

  it('mock updates confirm with a success toast instead of restarting', async () => {
    const update: ToastUpdate = {
      currentVersion: '1.40.1',
      version: '99.0.0-test',
      isMock: true,
      downloadAndInstall: vi.fn(async (onEvent: (e: DownloadEventArg) => void) => {
        onEvent({ event: 'Finished' } as DownloadEventArg)
      }),
    }
    render(<DesktopUpdateToast update={update} />)
    fireEvent.click(screen.getByRole('button', { name: 'Update' }))
    const restart = await screen.findByRole('button', { name: 'Restart' })
    fireEvent.click(restart)
    await waitFor(() => expect(successMock).toHaveBeenCalled())
    expect(dismissMock).toHaveBeenCalledWith('specrails-desktop-desktop-update')
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('surfaces an error state with a Try again action and alert role', async () => {
    const update: ToastUpdate = {
      currentVersion: '1.50.0',
      version: '99.0.0-test',
      downloadAndInstall: vi.fn(async () => {
        throw new Error('signature mismatch')
      }),
    }
    render(<DesktopUpdateToast update={update} />)
    fireEvent.click(screen.getByRole('button', { name: 'Update' }))

    expect(await screen.findByText('Update failed')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })

  it('persists the dismissed version and closes the toast on Dismiss', () => {
    const onClose = vi.fn()
    render(<DesktopUpdateToast update={createTauriUpdate()} onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))

    expect(localStorage.getItem('specrails-desktop:dismissedDesktopUpdateVersion')).toBe('99.0.0-test')
    expect(dismissMock).toHaveBeenCalledWith('specrails-desktop-desktop-update')
    expect(onClose).toHaveBeenCalled()
  })

  it('closes without persisting when choosing Later from the ready state', async () => {
    const onClose = vi.fn()
    const update: ToastUpdate = {
      currentVersion: '1.50.0',
      version: '99.0.0-test',
      downloadAndInstall: vi.fn(async (onEvent: (e: DownloadEventArg) => void) => {
        onEvent({ event: 'Finished' } as DownloadEventArg)
      }),
    }
    render(<DesktopUpdateToast update={update} onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: 'Update' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Later' }))

    expect(dismissMock).toHaveBeenCalledWith('specrails-desktop-desktop-update')
    expect(localStorage.getItem('specrails-desktop:dismissedDesktopUpdateVersion')).toBeNull()
    expect(onClose).toHaveBeenCalled()
  })

  describe('install when nothing is running', () => {
    function readyUpdate(): ToastUpdate {
      return {
        currentVersion: '1.50.0',
        version: '99.0.0-test',
        downloadAndInstall: vi.fn(async (onEvent: (e: DownloadEventArg) => void) => { onEvent({ event: 'Finished' } as DownloadEventArg) }),
      }
    }

    it('says what a restart would stop and waits until it is idle', async () => {
      activeWorkMock.mockResolvedValue({ missions: 2, runs: 1, total: 3 })
      render(<DesktopUpdateToast update={readyUpdate()} />)
      fireEvent.click(screen.getByRole('button', { name: 'Update' }))
      fireEvent.click(await screen.findByRole('button', { name: 'Restart' }))
      expect(await screen.findByText('Work is still running')).toBeInTheDocument()
      expect(screen.getByText('Restarting now stops 2 mission turns · 1 run.')).toBeInTheDocument()
      expect(invokeMock).not.toHaveBeenCalled()

      fireEvent.click(screen.getByRole('button', { name: 'Install when nothing is running' }))
      expect(await screen.findByText('Waiting to restart')).toBeInTheDocument()
      expect(invokeMock).not.toHaveBeenCalled()
      // The last turn ends: the card restarts by itself (polling).
      activeWorkMock.mockResolvedValue({ missions: 0, runs: 0, total: 0 })
      await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('restart_app'), { timeout: 8000 })
      expect(noteUpdateRestartMock).toHaveBeenCalled()
    }, 15_000)

    it('Restart now overrides the wait; Cancel goes back to ready', async () => {
      activeWorkMock.mockResolvedValue({ missions: 1, runs: 0, total: 1 })
      render(<DesktopUpdateToast update={readyUpdate()} />)
      fireEvent.click(screen.getByRole('button', { name: 'Update' }))
      fireEvent.click(await screen.findByRole('button', { name: 'Restart' }))
      fireEvent.click(await screen.findByRole('button', { name: 'Install when nothing is running' }))
      fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
      expect(await screen.findByText('Update ready')).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'Restart' }))
      fireEvent.click(await screen.findByRole('button', { name: 'Restart now' }))
      await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('restart_app'))
    })
  })
})
