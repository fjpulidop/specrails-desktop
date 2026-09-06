import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { BackgroundProcessLogsModal, boundedBackgroundLogs, sanitizeBackgroundLog } from '../BackgroundProcessLogsModal'
import { getBackgroundProcessLogs, type BackgroundProcessLogsSnapshot } from '../../lib/background-processes-api'
import type { BackgroundProcess } from '../../types'

vi.mock('../../lib/background-processes-api', async importOriginal => ({
  ...await importOriginal<typeof import('../../lib/background-processes-api')>(),
  getBackgroundProcessLogs: vi.fn(),
}))

const process: BackgroundProcess = { processId: 'process-a', projectId: 'project-a', chatId: 'chat-a', pid: 42, command: 'npm run dev', cwd: '/repos/web', startedAt: 1_700_000_000_000, status: 'running' }
const line = (sequence: number, text: string, source: 'stdout' | 'stderr' = 'stdout') => ({ sequence, line: text, source, at: 1_700_000_000_000 + sequence })
function snapshot(overrides: Partial<BackgroundProcessLogsSnapshot> = {}): BackgroundProcessLogsSnapshot {
  return { process, lines: [line(1, 'Server ready'), line(2, 'Warning: fixture only', 'stderr')], truncated: false, droppedLines: 0, maxLines: 2000, maxLineChars: 4000, retentionMs: 120_000, nextSequence: 2, ...overrides }
}
const api = vi.mocked(getBackgroundProcessLogs)
function renderModal(props: Partial<Parameters<typeof BackgroundProcessLogsModal>[0]> = {}) {
  const onClose = vi.fn(), onKill = vi.fn().mockResolvedValue(undefined)
  return { ...render(<BackgroundProcessLogsModal process={process} onClose={onClose} onKill={onKill} {...props} />), onClose, onKill }
}
beforeEach(() => { api.mockReset(); api.mockResolvedValue(snapshot()) })
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks() })

describe('BackgroundProcessLogsModal', () => {
  it('loads scoped logs, searches and filters plain output, and closes without stopping', async () => {
    const view = renderModal()
    expect(screen.getByText('Loading logs…')).toBeInTheDocument()
    await screen.findByText('Server ready')
    expect(api).toHaveBeenCalledWith(process, expect.objectContaining({ limit: 2000, signal: expect.any(AbortSignal) }))
    expect(screen.getByText('/repos/web')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Output source'), { target: { value: 'stderr' } })
    expect(screen.queryByText('Server ready')).toBeNull()
    expect(screen.getByText('Warning: fixture only')).toBeInTheDocument()
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'missing' } })
    expect(screen.getByText('No matching output.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Close logs' }))
    expect(view.onClose).toHaveBeenCalledOnce()
    expect(view.onKill).not.toHaveBeenCalled()
  })

  it('replaces same-sequence partial output, pauses polling, resumes and stops polling after exit', async () => {
    vi.useFakeTimers()
    api.mockResolvedValueOnce(snapshot({ lines: [{ ...line(1, 'Build'), partial: true }] }))
      .mockResolvedValueOnce(snapshot({ lines: [line(1, 'Build complete')] }))
      .mockResolvedValue(snapshot({ process: { ...process, status: 'exited', exitCode: 0, endedAt: process.startedAt + 1000 }, lines: [line(1, 'Finished')] }))
    renderModal()
    await act(async () => {})
    expect(screen.getByText('Build')).toBeInTheDocument()
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(screen.queryByText('Build')).toBeNull()
    expect(screen.getByText('Build complete')).toBeInTheDocument()
    expect(document.querySelectorAll('[data-log-source]')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(api).toHaveBeenCalledTimes(2)
    expect(screen.getByText('View paused. The process continues running.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }))
    await act(async () => {})
    expect(screen.getByText('Finished')).toBeInTheDocument()
    expect(screen.getByText('Exit code: 0')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Stop process' })).toBeNull()
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(api).toHaveBeenCalledTimes(3)
  })

  it('keeps loaded output on failure or retention expiry and retries', async () => {
    vi.useFakeTimers()
    api.mockResolvedValueOnce(snapshot()).mockRejectedValueOnce(new Error('Process retention expired')).mockResolvedValue(snapshot({ lines: [line(3, 'Recovered')] }))
    renderModal()
    await act(async () => {})
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(screen.getByRole('alert')).toHaveTextContent('Logs could not be loaded.')
    expect(screen.getByText('Server ready')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await act(async () => {})
    expect(screen.getByText('Recovered')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('aborts pending reads and ignores late responses when selecting another process with the same PID', async () => {
    let resolveOld!: (value: BackgroundProcessLogsSnapshot) => void
    api.mockReturnValueOnce(new Promise(resolve => { resolveOld = resolve }))
    const view = renderModal()
    const signal = api.mock.calls[0][1]!.signal!
    const next = { ...process, processId: 'process-b', chatId: 'chat-b', command: 'npm test' }
    api.mockResolvedValue(snapshot({ process: next, lines: [line(1, 'Different process')] }))
    view.rerender(<BackgroundProcessLogsModal process={next} onClose={view.onClose} onKill={view.onKill} />)
    expect(signal.aborted).toBe(true)
    await screen.findByText('Different process')
    await act(async () => { resolveOld(snapshot({ lines: [line(1, 'Stale secret')] })) })
    expect(screen.queryByText('Stale secret')).toBeNull()
    view.unmount()
    expect(api.mock.calls.at(-1)![1]!.signal!.aborted).toBe(true)
  })

  it('rejects a response from another process without displaying its logs', async () => {
    api.mockResolvedValue(snapshot({ process: { ...process, processId: 'foreign' }, lines: [line(1, 'Foreign output')] }))
    renderModal()
    await screen.findByRole('alert')
    expect(screen.queryByText('Foreign output')).toBeNull()
  })

  it('sanitizes terminal escapes and treats markup as text in the view and copy', async () => {
    const copy = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: copy }, configurable: true })
    api.mockResolvedValue(snapshot({ truncated: true, lines: [line(1, '\u001b[31m<img src=x onerror=alert(1)>\u001b[0m\u001b]8;;https://example.test\u0007link\u001b]8;;\u0007'), line(2, 'Only error', 'stderr')] }))
    renderModal()
    await screen.findByText('<img src=x onerror=alert(1)>link')
    expect(document.querySelector('img')).toBeNull()
    expect(screen.getByText(/Showing a limited log window/)).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Output source'), { target: { value: 'stderr' } })
    fireEvent.click(screen.getByRole('button', { name: 'Copy visible logs' }))
    await waitFor(() => expect(copy).toHaveBeenCalledOnce())
    expect(copy.mock.calls[0][0]).toContain('Only error')
    expect(copy.mock.calls[0][0]).not.toContain('<img')
    expect(copy.mock.calls[0][0]).not.toContain('\u001b')
  })

  it('downloads only the current filtered output and handles export failures', async () => {
    const create = vi.fn(() => 'blob:fixture'), revoke = vi.fn()
    Object.defineProperty(URL, 'createObjectURL', { value: create, configurable: true })
    Object.defineProperty(URL, 'revokeObjectURL', { value: revoke, configurable: true })
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    renderModal(); await screen.findByText('Server ready')
    fireEvent.click(screen.getByRole('button', { name: 'Download visible logs' }))
    expect(create).toHaveBeenCalledOnce(); expect(click).toHaveBeenCalledOnce(); expect(revoke).toHaveBeenCalledWith('blob:fixture')
    create.mockImplementation(() => { throw new Error('Not available') })
    fireEvent.click(screen.getByRole('button', { name: 'Download visible logs' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Could not export logs.')
  })

  it('stops using full process identity and keeps failures actionable', async () => {
    const stop = vi.fn().mockRejectedValueOnce(new Error('Denied')).mockResolvedValue(undefined)
    renderModal({ onKill: stop }); await screen.findByText('Server ready')
    fireEvent.click(screen.getByRole('button', { name: 'Stop process' }))
    await screen.findByText('Could not stop the process. Try again.')
    expect(stop).toHaveBeenCalledWith(process)
    fireEvent.click(screen.getByRole('button', { name: 'Stop process' }))
    await waitFor(() => expect(stop).toHaveBeenCalledTimes(2))
    expect(screen.queryByText('Could not stop the process. Try again.')).toBeNull()
  })

  it('lets a final log snapshot supersede an earlier stopping websocket state', async () => {
    api.mockResolvedValue(snapshot({ process: { ...process, status: 'killed', endedAt: process.startedAt + 1000 } }))
    renderModal({ process: { ...process, status: 'stopping' } })
    await screen.findByText('Server ready')
    expect(screen.getByTestId('background-process-status')).toHaveTextContent('Stopped')
    expect(screen.queryByRole('button', { name: 'Stopping' })).toBeNull()
  })

  it('shows repository context and permits retrying a stopping process after a signal error', async () => {
    api.mockResolvedValue(snapshot({ process: { ...process, status: 'stopping', error: 'Could not signal process', repositoryId: 'repo-web', repositoryName: 'Web frontend' } }))
    const view = renderModal({ process: { ...process, status: 'stopping' } })
    await screen.findByText('Could not signal process')
    expect(screen.getByText('Web frontend')).toBeInTheDocument()
    const stop = screen.getByRole('button', { name: 'Stop process' })
    expect(stop).toBeEnabled()
    await act(async () => { fireEvent.click(stop) })
    expect(view.onKill).toHaveBeenCalledOnce()
  })
})

describe('bounded plain process output', () => {
  it('removes incomplete OSC and control bytes without interpreting HTML', () => {
    expect(sanitizeBackgroundLog('ok\u001b]0;window title')).toBe('ok')
    expect(sanitizeBackgroundLog('a\u0000\u0008\u001b[2Jb\n\t<c>')).toBe('ab\n\t<c>')
  })
  it('bounds retained lines, long lines and aggregate characters', () => {
    const capped = boundedBackgroundLogs(Array.from({ length: 2500 }, (_, i) => line(i, `line ${i}`)))
    expect(capped.truncated).toBe(true)
    expect(capped.lines).toHaveLength(2000)
    expect(capped.lines[0].sequence).toBe(500)
    const large = boundedBackgroundLogs(Array.from({ length: 2000 }, (_, i) => line(i, 'x'.repeat(9000))))
    expect(large.truncated).toBe(true)
    expect(large.lines.reduce((sum, item) => sum + item.line.length, 0)).toBeLessThanOrEqual(512 * 1024)
    expect(large.lines.every(item => item.line.length <= 4000)).toBe(true)
  })
})
