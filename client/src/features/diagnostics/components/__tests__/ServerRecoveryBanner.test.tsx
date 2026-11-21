import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import type { CrashNotice } from '../../lib/diagnostics-api'

const api = vi.hoisted(() => ({ getCrashNotices: vi.fn(), acknowledgeCrashes: vi.fn() }))
vi.mock('../../lib/diagnostics-api', () => api)
const toast = vi.hoisted(() => ({ loading: vi.fn(), dismiss: vi.fn() }))
vi.mock('sonner', () => ({ toast }))

import { ServerRecoveryBanner } from '../ServerRecoveryBanner'

const notice = (atMs: number, patch: Partial<CrashNotice> = {}): CrashNotice => ({
  id: `${atMs}-1`, atMs, outcome: 'restarted', exitCode: null, signal: 9, uptimeMs: 1000, wasReady: true, recentRestarts: 1, maxRestarts: 3, ...patch,
})
const flush = async () => { await act(async () => { for (let i = 0; i < 4; i++) await Promise.resolve() }) }

beforeEach(() => { api.acknowledgeCrashes.mockResolvedValue(undefined) })
afterEach(() => { vi.clearAllMocks() })

describe('ServerRecoveryBanner', () => {
  it('stays hidden when nothing crashed', async () => {
    api.getCrashNotices.mockResolvedValue({ available: true, acknowledgedThroughMs: 0, notices: [] })
    render(<ServerRecoveryBanner connectionStatus="connected" onReportProblem={() => {}} />)
    await flush()
    expect(screen.queryByTestId('server-recovery-banner')).toBeNull()
  })

  it('explains an automatic restart with its cause and offers Report a problem', async () => {
    api.getCrashNotices.mockResolvedValue({ available: true, acknowledgedThroughMs: 0, notices: [notice(Date.UTC(2026, 10, 18, 9, 30))] })
    const onReport = vi.fn()
    render(<ServerRecoveryBanner connectionStatus="connected" onReportProblem={onReport} />)
    await flush()
    const banner = screen.getByTestId('server-recovery-banner')
    expect(banner).toHaveTextContent('stopped unexpectedly')
    expect(banner).toHaveTextContent('signal 9')
    expect(banner).toHaveTextContent('restarted it')
    fireEvent.click(screen.getByRole('button', { name: 'Report a problem' }))
    expect(onReport).toHaveBeenCalled()
    expect(api.acknowledgeCrashes).toHaveBeenCalledWith(Date.UTC(2026, 10, 18, 9, 30))
    expect(screen.queryByTestId('server-recovery-banner')).toBeNull()
  })

  it('counts repeated restarts and says when Specrails stopped restarting', async () => {
    api.getCrashNotices.mockResolvedValueOnce({ available: true, acknowledgedThroughMs: 0, notices: [notice(1), notice(2)] })
    const { unmount } = render(<ServerRecoveryBanner connectionStatus="connected" onReportProblem={() => {}} />)
    await flush()
    expect(screen.getByTestId('server-recovery-banner')).toHaveTextContent('2 times since')
    unmount()
    api.getCrashNotices.mockResolvedValueOnce({ available: true, acknowledgedThroughMs: 0, notices: [notice(1), notice(2, { outcome: 'stopped', recentRestarts: 3, signal: null, exitCode: 1 })] })
    render(<ServerRecoveryBanner connectionStatus="connected" onReportProblem={() => {}} />)
    await flush()
    const banner = screen.getByTestId('server-recovery-banner')
    expect(banner).toHaveTextContent('exit code 1')
    expect(banner).toHaveTextContent('stopped restarting it after 3 attempts')
  })

  it('dismissing acknowledges through the newest crash', async () => {
    api.getCrashNotices.mockResolvedValue({ available: true, acknowledgedThroughMs: 0, notices: [notice(10), notice(30)] })
    render(<ServerRecoveryBanner connectionStatus="connected" onReportProblem={() => {}} />)
    await flush()
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(api.acknowledgeCrashes).toHaveBeenCalledWith(30)
    expect(screen.queryByTestId('server-recovery-banner')).toBeNull()
  })

  it('reads the notices again when the connection comes back', async () => {
    api.getCrashNotices.mockResolvedValue({ available: true, acknowledgedThroughMs: 0, notices: [] })
    const { rerender } = render(<ServerRecoveryBanner connectionStatus="connected" onReportProblem={() => {}} />)
    await flush()
    expect(api.getCrashNotices).toHaveBeenCalledTimes(1)
    rerender(<ServerRecoveryBanner connectionStatus="connecting" onReportProblem={() => {}} />)
    await flush()
    expect(api.getCrashNotices).toHaveBeenCalledTimes(1)
    api.getCrashNotices.mockResolvedValue({ available: true, acknowledgedThroughMs: 0, notices: [notice(5)] })
    rerender(<ServerRecoveryBanner connectionStatus="connected" onReportProblem={() => {}} />)
    await flush()
    expect(api.getCrashNotices).toHaveBeenCalledTimes(2)
    expect(toast.dismiss).toHaveBeenCalledWith('local-server-restarting')
    expect(screen.getByTestId('server-recovery-banner')).toBeInTheDocument()
  })
})
