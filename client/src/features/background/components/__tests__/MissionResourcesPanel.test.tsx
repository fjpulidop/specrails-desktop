import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MissionResourcesPanel, formatBytes } from '../MissionResourcesPanel'
import { startWorktreeScan, type MissionResourcesSnapshot } from '../../lib/mission-resources-api'
import type { ResourceSample } from '../../lib/mission-resource-history'

vi.mock('../../lib/mission-resources-api', () => ({ getMissionResources: vi.fn(), startWorktreeScan: vi.fn() }))
vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: unknown }) => <div>{children as never}</div>,
  LineChart: () => <svg />, Line: () => null, Tooltip: () => null, YAxis: () => null,
}))

const snapshot = (patch: Partial<MissionResourcesSnapshot> = {}): MissionResourcesSnapshot => ({
  sampledAt: 1, supported: true,
  entries: [
    { id: 'a', kind: 'agent-session', label: 'Agent session', pid: 10, running: true, cpuPercent: 5, memoryBytes: 1024 * 1024, processCount: 2 },
    { id: 'b', kind: 'background-process', label: 'npm run dev', pid: 11, running: true, cpuPercent: 12.5, memoryBytes: 300 * 1024 * 1024, processCount: 4 },
  ],
  totals: { cpuPercent: 17.5, memoryBytes: 301 * 1024 * 1024, processCount: 6 },
  worktree: { path: '/tmp/wt', disk: { status: 'not-scanned' } },
  ...patch,
})
const sample = (at: number, cpu: number, mem: number, procs: number): ResourceSample => ({ at, cpuPercent: cpu, memoryBytes: mem, processCount: procs })
const idleSnapshot = () => snapshot({ entries: [], totals: { cpuPercent: 0, memoryBytes: 0, processCount: 0 } })

afterEach(() => { cleanup; vi.mocked(startWorktreeScan).mockReset().mockResolvedValue({ status: 'scanning', startedAt: 1 }) })
afterEach(cleanup)

const renderPanel = (props: Partial<Parameters<typeof MissionResourcesPanel>[0]> = {}) =>
  render(<MissionResourcesPanel projectId="p1" chatId="c1" snapshot={snapshot()} samples={[sample(1, 17.5, 301e6, 6)]} {...props} />)

describe('MissionResourcesPanel', () => {
  it('[spec:mission-resources/mission-chat-exposes-read-only-resource-inspection] formats bytes', () => { expect(formatBytes(512)).toBe('512 B'); expect(formatBytes(1536)).toBe('1.5 KB') })

  it('[spec:mission-resources/mission-chat-exposes-read-only-resource-inspection] shows totals, per-entry load heaviest first and an explicit not-scanned worktree, with no destructive action and no refresh button', () => {
    renderPanel()
    expect(screen.getByTestId('mission-resources-entries').querySelectorAll('li')[0].textContent).toContain('npm run dev')
    expect(screen.getByTestId('mission-resources-totals').textContent).toContain('17.5%')
    expect(screen.getByTestId('mission-resources-disk').textContent).toMatch(/not scanned/i)
    expect(screen.queryByRole('button', { name: /stop|kill|delete|clean|refresh/i })).toBeNull()
    expect(screen.queryByTestId('mission-resources-finished')).toBeNull()
  })

  it('[spec:mission-resources/resource-history-remains-readable-after-activity-ends] keeps the last active figures and peak after the mission ends instead of showing zeros', () => {
    const samples = [sample(1, 10, 100e6, 3), sample(2, 40, 500e6, 6), sample(3, 20, 300e6, 4), sample(4, 0, 0, 0)]
    renderPanel({ snapshot: idleSnapshot(), samples })
    expect(screen.getByTestId('mission-resources-finished').textContent).toMatch(/finished at/i)
    expect(screen.getByTestId('mission-resources-totals').textContent).toContain('20.0%')
    expect(screen.getByTestId('mission-resources-totals').textContent).not.toContain('0.0%\u0000')
    expect(screen.getByTestId('mission-resources-cpu-chart').textContent).toContain('Peak 40.0%')
    expect(screen.getByTestId('mission-resources-memory-chart').textContent).toMatch(/Peak 4\d\d MB/)
    expect(screen.getByTestId('mission-resources-range').textContent).toContain('→')
    expect(screen.getByTestId('mission-resources-history')).toBeTruthy()
    expect(screen.queryByText(/no processes are running/i)).toBeNull()
  })

  it('[spec:mission-resources/resource-history-remains-readable-after-activity-ends] says nothing is running when the mission never had activity', () => {
    renderPanel({ snapshot: idleSnapshot(), samples: [] })
    expect(screen.getByText(/no processes are running/i)).toBeTruthy()
    expect(screen.queryByTestId('mission-resources-history')).toBeNull()
  })

  it('[spec:mission-resources/worktree-disk-measurement-is-explicit-and-asynchronous] scans the worktree on demand and tells the owner to refresh', async () => {
    const onScanned = vi.fn()
    renderPanel({ onScanned })
    fireEvent.click(screen.getByRole('button', { name: 'Scan' }))
    await waitFor(() => expect(startWorktreeScan).toHaveBeenCalledWith('p1', 'c1'))
    await waitFor(() => expect(onScanned).toHaveBeenCalled())
  })

  it('[spec:mission-resources/platform-sampling-reports-available-measurements] explains an unsupported platform', () => {
    renderPanel({ snapshot: snapshot({ supported: false, entries: [] }), samples: [] })
    expect(screen.getByTestId('mission-resources-unsupported')).toBeTruthy()
  })
})
