import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { AppResourcesFooter, AppResourcesPanel, formatCpu, workProcessCount } from '../AppResourcesFooter'
import { getAppResources, type AppResourcesSnapshot } from '../../lib/app-resources-api'
import { APP_RESOURCES_IDLE_POLL_MS, APP_RESOURCES_POLL_MS } from '../../hooks/useAppResources'

vi.mock('../../lib/app-resources-api', () => ({ getAppResources: vi.fn() }))
vi.mock('../../lib/run-ports-api', () => ({ getRunPorts: vi.fn(async () => ({ supported: true, scannedAt: 0, ports: [], leases: [] })) }))

const MB = 1024 * 1024
const snapshot = (patch: Partial<AppResourcesSnapshot> = {}): AppResourcesSnapshot => ({
  measuredAt: 1,
  supported: true,
  totals: { cpuPercent: 23.5, memoryBytes: 1200 * MB, processCount: 9 },
  categories: [
    { id: 'missions', cpuPercent: 20, memoryBytes: 900 * MB, processCount: 5, items: [
      { label: 'Fix login', projectId: 'p1', projectName: 'Web app', chatId: 'c1', cpuPercent: 20, memoryBytes: 900 * MB, processCount: 5 },
    ] },
    { id: 'rails', cpuPercent: 0, memoryBytes: 0, processCount: 1, items: [{ label: 'Rail 1 · Implement · #12', projectId: 'p1', projectName: 'Web app', runId: 'r1', cpuPercent: 0, memoryBytes: 0, processCount: 1 }] },
    { id: 'terminals', cpuPercent: 0.5, memoryBytes: 100 * MB, processCount: 3, items: [{ label: 'zsh', projectId: 'p1', cpuPercent: 0.5, memoryBytes: 100 * MB, processCount: 3 }] },
    { id: 'server', cpuPercent: 3, memoryBytes: 200 * MB, processCount: 1, items: [{ label: 'Specrails server', cpuPercent: 3, memoryBytes: 200 * MB, processCount: 1 }] },
  ],
  history: [
    { at: 1, cpuPercent: 10, memoryBytes: 1000 * MB, processCount: 8 },
    { at: 2, cpuPercent: 23.5, memoryBytes: 1200 * MB, processCount: 9 },
  ],
  ...patch,
})

const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve() }) }
const idleSnapshot = () => snapshot({
  categories: [snapshot().categories[3]!],
  totals: { cpuPercent: 3, memoryBytes: 200 * MB, processCount: 1 },
})

beforeEach(() => { vi.useFakeTimers(); vi.mocked(getAppResources).mockReset().mockResolvedValue(snapshot()) })
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('AppResourcesFooter', () => {
  it('shows only an icon and the count of work processes (memory lives in the popover)', async () => {
    render(<AppResourcesFooter />)
    await flush()
    const trigger = screen.getByTestId('app-resources-trigger')
    // Missions, rails and terminals; the Specrails server is not counted.
    expect(trigger.textContent).toBe('9')
    expect(trigger.textContent).not.toContain('GB')
    expect(trigger).toHaveAttribute('aria-label', 'App resources: 9 processes running. Show details')
  })

  it('[spec:app-resources-button/count-only-when-measured] opens before the first measurement with a neutral name and no count', () => {
    vi.mocked(getAppResources).mockImplementation(() => new Promise(() => {}))
    render(<AppResourcesFooter />)
    const trigger = screen.getByRole('button', { name: 'App resources' })
    expect(trigger).toHaveTextContent(/^$/)
    fireEvent.click(trigger)
    expect(screen.getByText('Measuring…')).toBeInTheDocument()
  })

  it('[spec:app-resources-button/resources-button-is-always-visible] opens at zero work processes and still lists the server', async () => {
    vi.mocked(getAppResources).mockResolvedValue(idleSnapshot())
    render(<AppResourcesFooter />)
    await flush()
    const trigger = screen.getByRole('button', { name: 'App resources: 0 processes running. Show details' })
    expect(trigger).toHaveTextContent(/^0$/)
    fireEvent.click(trigger)
    expect(screen.getByTestId('app-resources-category-server')).toBeInTheDocument()
  })

  it('[spec:app-resources-button/resources-button-is-always-visible] stays visible when the last work process ends with the panel closed', async () => {
    vi.mocked(getAppResources).mockResolvedValueOnce(snapshot()).mockResolvedValue(idleSnapshot())
    render(<AppResourcesFooter />)
    await flush()
    const trigger = screen.getByTestId('app-resources-trigger')
    expect(trigger).toHaveTextContent(/^9$/)
    await act(async () => { vi.advanceTimersByTime(APP_RESOURCES_IDLE_POLL_MS) })
    expect(screen.getByTestId('app-resources-trigger')).toBe(trigger)
    expect(trigger).toHaveTextContent(/^0$/)
  })

  it('[spec:app-resources-button/count-only-when-measured] opens with a neutral name when measurement is unsupported', async () => {
    vi.mocked(getAppResources).mockResolvedValue(snapshot({ supported: false, categories: [], totals: { cpuPercent: 0, memoryBytes: 0, processCount: 0 } }))
    render(<AppResourcesFooter />)
    await flush()
    const trigger = screen.getByRole('button', { name: 'App resources' })
    expect(trigger).toHaveTextContent(/^$/)
    fireEvent.click(trigger)
    expect(screen.getByText('Resource usage is not available on this system.')).toBeInTheDocument()
  })

  it('[spec:app-resources-button/count-only-when-measured] omits a stale count after a refresh error and leaves the error accessible', async () => {
    vi.mocked(getAppResources).mockResolvedValueOnce(snapshot()).mockRejectedValue(new Error('offline'))
    render(<AppResourcesFooter />)
    await flush()
    await act(async () => { vi.advanceTimersByTime(APP_RESOURCES_IDLE_POLL_MS) })
    const trigger = screen.getByRole('button', { name: 'App resources' })
    expect(trigger).toHaveTextContent(/^$/)
    fireEvent.click(trigger)
    await flush()
    expect(screen.getByRole('alert')).toHaveTextContent('Could not read resources: offline')
  })

  it('workProcessCount ignores the server', () => {
    expect(workProcessCount(snapshot())).toBe(9)
    expect(workProcessCount(null)).toBe(0)
  })

  it('opens on click with totals, the memory bar and categories expandable to items', async () => {
    render(<AppResourcesFooter />)
    await flush()
    fireEvent.click(screen.getByTestId('app-resources-trigger'))
    await flush()
    const popover = screen.getByTestId('app-resources-popover')
    expect(within(popover).getByText('23.5%')).toBeInTheDocument()
    expect(within(popover).getByTestId('app-resources-sparkline')).toBeInTheDocument()
    const segments = within(popover).getByTestId('app-resources-bar').querySelectorAll('span')
    expect(segments).toHaveLength(3)
    expect((segments[0] as HTMLElement).style.width).toBe('75%')
    expect(within(popover).getAllByText('Missions & chats')).toHaveLength(2) // legend and row

    const rails = within(popover).getByTestId('app-resources-category-rails')
    fireEvent.click(within(rails).getByRole('button', { name: 'Show or hide Rails, loops & jobs' }))
    expect(within(rails).getByText('Rail 1 · Implement · #12')).toBeInTheDocument()

    const missions = within(popover).getByTestId('app-resources-category-missions')
    expect(within(missions).queryByText('Fix login')).toBeNull()
    fireEvent.click(within(missions).getByRole('button', { name: 'Show or hide Missions & chats' }))
    expect(within(missions).getByText('Fix login')).toBeInTheDocument()
    expect(within(missions).getByText(/Web app/)).toBeInTheDocument()

    const server = within(popover).getByTestId('app-resources-category-server')
    fireEvent.click(within(server).getByRole('button'))
    expect(within(server).getAllByText('Specrails server').length).toBeGreaterThan(1)
  })

  it('polls every few seconds only while the popover is open', async () => {
    render(<AppResourcesFooter />)
    await flush()
    expect(getAppResources).toHaveBeenCalledTimes(1)

    // Closed: no fast polling.
    await act(async () => { vi.advanceTimersByTime(APP_RESOURCES_POLL_MS * 3) })
    expect(getAppResources).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByTestId('app-resources-trigger'))
    await flush()
    const afterOpen = vi.mocked(getAppResources).mock.calls.length
    expect(afterOpen).toBe(2) // refreshed on open
    await act(async () => { vi.advanceTimersByTime(APP_RESOURCES_POLL_MS * 2) })
    expect(getAppResources).toHaveBeenCalledTimes(afterOpen + 2)

    fireEvent.keyDown(document, { key: 'Escape' })
    await flush()
    const afterClose = vi.mocked(getAppResources).mock.calls.length
    await act(async () => { vi.advanceTimersByTime(APP_RESOURCES_POLL_MS * 3) })
    expect(getAppResources).toHaveBeenCalledTimes(afterClose)
    await act(async () => { vi.advanceTimersByTime(APP_RESOURCES_IDLE_POLL_MS) })
    expect(getAppResources).toHaveBeenCalledTimes(afterClose + 1)
  })
})

describe('AppResourcesPanel', () => {
  it('reports errors and an empty state', () => {
    const { rerender } = render(<AppResourcesPanel snapshot={null} error="boom" />)
    expect(screen.getByRole('alert').textContent).toContain('boom')
    rerender(<AppResourcesPanel snapshot={snapshot({ categories: [], totals: { cpuPercent: 0, memoryBytes: 0, processCount: 0 } })} error={null} />)
    expect(screen.getByText('Nothing running')).toBeInTheDocument()
  })

  it('formats CPU', () => {
    expect(formatCpu(3)).toBe('3.0%')
    expect(formatCpu(150.4)).toBe('150%')
  })
})
