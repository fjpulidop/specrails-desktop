import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { AppResourcesFooter, AppResourcesPanel, formatCpu } from '../AppResourcesFooter'
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

beforeEach(() => { vi.useFakeTimers(); vi.mocked(getAppResources).mockReset().mockResolvedValue(snapshot()) })
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('AppResourcesFooter', () => {
  it('shows total memory and process count in the trigger', async () => {
    render(<AppResourcesFooter />)
    await flush()
    const trigger = screen.getByTestId('app-resources-trigger')
    expect(trigger.textContent).toContain('1.2 GB')
    expect(trigger.textContent).toContain('9')
    expect(trigger).toHaveAttribute('aria-label', 'Resources: 1.2 GB memory, 9 processes')
  })

  it('falls back to a label when the platform cannot be measured', async () => {
    vi.mocked(getAppResources).mockResolvedValue(snapshot({ supported: false, categories: [], totals: { cpuPercent: 0, memoryBytes: 0, processCount: 0 } }))
    render(<AppResourcesFooter />)
    await flush()
    expect(screen.getByTestId('app-resources-trigger').textContent).toBe('Resources')
    fireEvent.click(screen.getByTestId('app-resources-trigger'))
    expect(screen.getByText('Resource usage is not available on this system.')).toBeInTheDocument()
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
