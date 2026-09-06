import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { BackgroundProcessHistoryModal } from '../BackgroundProcessHistoryModal'
import { getBackgroundProcessLogs } from '../../lib/background-processes-api'
import type { BackgroundProcess } from '../../types'

vi.mock('../../lib/background-processes-api', async importOriginal => ({
  ...await importOriginal<typeof import('../../lib/background-processes-api')>(), getBackgroundProcessLogs: vi.fn(),
}))
const process = (patch: Partial<BackgroundProcess> = {}): BackgroundProcess => ({ processId: 'old', projectId: 'p1', chatId: 'c1', pid: 42, command: 'npm run build', cwd: '/repos/web', repositoryName: 'Web', startedAt: 1_700_000_000_000, endedAt: 1_700_000_100_000, status: 'exited', ...patch })
const logs = (target: BackgroundProcess) => ({ process: target, lines: [{ sequence: 1, at: target.startedAt, source: 'stdout' as const, line: 'Saved output after restart' }], truncated: false, droppedLines: 0, maxLines: 10000, maxLineChars: 4000, retentionMs: 30 * 86400000, nextSequence: 1 })
const api = vi.mocked(getBackgroundProcessLogs)
function mount(overrides: Partial<Parameters<typeof BackgroundProcessHistoryModal>[0]> = {}) {
  const props = { processes: [process()], loading: false, error: null, onRefresh: vi.fn().mockResolvedValue(undefined), onClose: vi.fn(), onKill: vi.fn().mockResolvedValue(undefined), ...overrides }
  return { ...render(<BackgroundProcessHistoryModal {...props} />), props }
}
beforeEach(() => { api.mockReset(); api.mockImplementation(async target => logs(target)) })
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('BackgroundProcessHistoryModal', () => {
  it('loads history, opens saved logs and returns to its preserved search without stopping', async () => {
    const view = mount({ processes: [process(), process({ processId: 'api', command: 'go test ./...', repositoryName: 'API', cwd: '/repos/api' })] })
    expect(view.props.onRefresh).toHaveBeenCalledOnce()
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Web' } })
    expect(screen.queryByText('go test ./...')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'View logs for npm run build' }))
    await screen.findByText('Saved output after restart')
    expect(api).toHaveBeenCalledWith(process(), expect.objectContaining({ limit: 2000 }))
    fireEvent.click(screen.getByRole('button', { name: 'Back to processes' }))
    expect(screen.getByRole('searchbox')).toHaveValue('Web')
    expect(screen.getByText('npm run build')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Close process history' }))
    expect(view.props.onClose).toHaveBeenCalledOnce()
    expect(view.props.onKill).not.toHaveBeenCalled()
  })
  it('keeps active processes first and permits searching directory, repository, PID and status', () => {
    const view = mount({ processes: [process(), process({ processId: 'live', command: 'vite', startedAt: 1, endedAt: undefined, status: 'running', repositoryName: 'Frontend', pid: 99 })] })
    const entries = screen.getAllByRole('button', { name: /View logs for/ })
    expect(entries[0]).toHaveAccessibleName('View logs for vite')
    for (const query of ['Frontend', '99', 'Running']) {
      fireEvent.change(screen.getByRole('searchbox'), { target: { value: query } })
      expect(screen.getAllByRole('button', { name: /View logs for/ })).toHaveLength(1)
      expect(screen.getByText('vite')).toBeInTheDocument()
    }
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'missing' } })
    expect(screen.getByText('No matching processes.')).toBeInTheDocument()
    expect(view.props.onKill).not.toHaveBeenCalled()
  })
  it('shows disconnected supervision honestly without offering Stop or polling a recovered PID', async () => {
    vi.useFakeTimers()
    const target = process({ status: 'interrupted', endedAt: undefined, recoveredAt: 1_700_000_100_000 })
    mount({ processes: [target] })
    fireEvent.click(screen.getByRole('button', { name: 'View logs for npm run build' }))
    await act(async () => {})
    expect(screen.getByText('Saved output after restart')).toBeInTheDocument()
    expect(screen.getByTestId('background-process-status')).toHaveTextContent('Disconnected')
    expect(screen.getByText(/Its operating system state is unknown/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Stop process' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull()
    await act(async () => vi.advanceTimersByTimeAsync(5000))
    expect(api).toHaveBeenCalledOnce()
  })
  it('retains its selected snapshot and output when history metadata is removed or refreshed', async () => {
    const view = mount()
    fireEvent.click(screen.getByRole('button', { name: 'View logs for npm run build' }))
    await screen.findByText('Saved output after restart')
    view.rerender(<BackgroundProcessHistoryModal {...view.props} processes={[]} />)
    expect(screen.getByText('Saved output after restart')).toBeInTheDocument()
    expect(screen.getByTestId('background-process-status')).toHaveTextContent('Exited')
  })
  it('exposes history errors and retry while retaining existing entries', () => {
    const view = mount({ error: 'network down' })
    expect(screen.getByRole('alert')).toHaveTextContent('Process history could not be loaded')
    expect(screen.getByText('npm run build')).toBeInTheDocument()
    fireEvent.click(within(screen.getByRole('alert')).getByRole('button', { name: 'Retry' }))
    expect(view.props.onRefresh).toHaveBeenCalledTimes(2)
    view.rerender(<BackgroundProcessHistoryModal {...view.props} processes={[]} />)
    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(screen.queryByText('No processes have been recorded for this mission.')).toBeNull()
  })
  it('supports an empty saved mission and a loading state', () => {
    const view = mount({ processes: [], loading: true })
    expect(screen.getByRole('status')).toHaveTextContent('Loading process history')
    expect(screen.getByRole('button', { name: 'Refresh history' })).toBeDisabled()
    view.rerender(<BackgroundProcessHistoryModal {...view.props} loading={false} />)
    expect(screen.getByText('No processes have been recorded for this mission.')).toBeInTheDocument()
  })
  it('bounds the rendered history while searching all saved metadata', () => {
    mount({ processes: Array.from({ length: 150 }, (_, index) => process({ processId: String(index), command: `build-${index}`, startedAt: index })) })
    expect(screen.getAllByRole('button', { name: /View logs for/ })).toHaveLength(100)
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }))
    expect(screen.getAllByRole('button', { name: /View logs for/ })).toHaveLength(150)
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'build-0' } })
    expect(screen.getAllByRole('button', { name: /View logs for/ })).toHaveLength(1)
  })
  it('warns when persistence failed without hiding available saved output', async () => {
    mount({ processes: [process({ persistenceError: 'Disk full' })] })
    fireEvent.click(screen.getByRole('button', { name: 'View logs for npm run build' }))
    await screen.findByText('Saved output after restart')
    expect(screen.getByRole('alert')).toHaveTextContent('The process history could not be saved')
  })
})
