import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import type { JobSummary } from '../../../../types'

vi.mock('../../../../lib/api', () => ({ getApiBase: () => '/api/projects/p1' }))

vi.mock('../../../../hooks/useDesktop', () => ({
  useDesktop: () => ({
    projects: [{ id: 'p1', name: 'acme', slug: 'acme', path: '/acme', provider: 'claude' }],
    activeProjectId: 'p1',
    setActiveProjectId: vi.fn(),
  }),
}))

vi.mock('../../../../hooks/useSharedWebSocket', () => ({
  useSharedWebSocket: () => ({
    registerHandler: vi.fn(),
    unregisterHandler: vi.fn(),
    connectionStatus: 'connected',
  }),
}))

let mockJobs: JobSummary[] = []
let mockFirstLoad = false
vi.mock('../../../../hooks/useProjectCache', () => ({
  useProjectCache: () => ({ data: mockJobs, isFirstLoad: mockFirstLoad, refresh: vi.fn() }),
}))

// The real modal has its own test suite — a stub proves the pane wires jobId/onClose.
vi.mock('../../../jobs/components/JobDetailModal', () => ({
  JobDetailModal: ({ jobId, projectId, onClose }: { jobId: string; projectId: string; onClose: () => void }) => (
    <div data-testid="job-modal" data-project-id={projectId}>
      <span>{jobId}</span>
      <button onClick={onClose}>close-modal</button>
    </div>
  ),
}))

import { AgentModeJobsPane } from '../AgentModeJobsPane'
import { AgentWorkspaceProvider } from '../../context/AgentWorkspaceContext'

function job(id: string, status: JobSummary['status'], command: string): JobSummary {
  return { id, command, status, started_at: new Date().toISOString() }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockJobs = []
  mockFirstLoad = false
})

function LocationProbe() {
  const location = useLocation()
  return <output data-testid="location">{location.pathname}{location.search}</output>
}

function renderPane(projectId = 'p1', initialEntry = '/') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <AgentWorkspaceProvider>
        <AgentModeJobsPane projectId={projectId} />
      </AgentWorkspaceProvider>
      <LocationProbe />
    </MemoryRouter>,
  )
}

describe('AgentModeJobsPane', () => {
  it('blocks native text selection during resize and restores it on completion or unmount', () => {
    vi.stubGlobal('PointerEvent', MouseEvent)
    const previousSelect = document.body.style.userSelect
    const previousCursor = document.body.style.cursor
    const view = renderPane()
    try {
      const handle = screen.getByRole('separator')
      const down = new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX: 500 })
      fireEvent(handle, down)
      expect(down.defaultPrevented).toBe(true)
      expect(document.body.style.userSelect).toBe('none')
      expect(document.body.style.cursor).toBe('col-resize')
      const select = new Event('selectstart', { cancelable: true })
      document.dispatchEvent(select)
      expect(select.defaultPrevented).toBe(true)
      const pane = handle.parentElement as HTMLElement
      const width = Number.parseFloat(pane.style.width)
      fireEvent.pointerMove(window, { clientX: 480 })
      expect(Number.parseFloat(pane.style.width)).toBe(width + 20)
      fireEvent.pointerUp(window)
      expect(document.body.style.userSelect).toBe(previousSelect)
      expect(document.body.style.cursor).toBe(previousCursor)
      const normalSelect = new Event('selectstart', { cancelable: true })
      document.dispatchEvent(normalSelect)
      expect(normalSelect.defaultPrevented).toBe(false)
      fireEvent.pointerDown(handle, { button: 0, clientX: 500 })
      fireEvent.blur(window)
      expect(document.body.style.userSelect).toBe(previousSelect)
      fireEvent.pointerDown(handle, { button: 0, clientX: 500 })
      view.unmount()
      expect(document.body.style.userSelect).toBe(previousSelect)
      expect(document.body.style.cursor).toBe(previousCursor)
    } finally {
      view.unmount()
      vi.unstubAllGlobals()
    }
  })

  it('anchors the resize handle inside the pane across its full height', () => {
    renderPane()
    const handle = screen.getByRole('separator')
    expect(handle.parentElement).toHaveClass('relative')
    expect(handle).toHaveClass('absolute', 'inset-y-0', 'left-0', 'z-20')
    expect(handle).not.toHaveClass('-translate-x-full')
    fireEvent.click(screen.getByLabelText('Maximize'))
    expect(screen.queryByRole('separator')).not.toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Restore'))
    expect(screen.getByRole('separator')).toBeInTheDocument()
  })

  it('lists the project jobs with their status', () => {
    mockJobs = [
      job('j1', 'running', '/specrails:implement #12'),
      job('j2', 'completed', '/specrails:implement #9'),
    ]
    renderPane()
    expect(screen.getByText('/specrails:implement #12')).toBeInTheDocument()
    expect(screen.getByText('/specrails:implement #9')).toBeInTheDocument()
    expect(screen.getByText('Running')).toBeInTheDocument()
    expect(screen.getByText('Completed')).toBeInTheDocument()
  })

  it('reads every job status through the shared vocabulary (one working lamp, skipped is stopped)', () => {
    mockJobs = [
      job('j1', 'running', 'a'),
      job('j2', 'skipped', 'b'),
      job('j3', 'zombie_terminated', 'c'),
    ]
    const { container } = renderPane()
    const states = screen.getAllByTestId('agent-job-status').map((pill) => pill.getAttribute('data-run-state'))
    expect(states).toEqual(['working', 'stopped', 'failed'])
    expect(screen.getByText('Skipped')).toBeInTheDocument()
    expect(screen.getByText('Zombie')).toBeInTheDocument()
    // The running job has its own lamp only: no second (primary) dot next to it.
    expect(container.querySelectorAll('[data-live-ring]')).toHaveLength(1)
    expect(container.querySelector('.bg-accent-primary')).toBeNull()
  })

  it('opens the near-fullscreen execution modal on job click and closes it', async () => {
    mockJobs = [job('j-42', 'running', '/specrails:implement #7')]
    renderPane('mission-project')
    expect(screen.queryByTestId('job-modal')).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('/specrails:implement #7'))
    expect(await screen.findByTestId('job-modal')).toBeInTheDocument()
    expect(screen.getByTestId('job-modal')).toHaveAttribute('data-project-id', 'mission-project')
    expect(screen.getByText('j-42')).toBeInTheDocument()
    fireEvent.click(screen.getByText('close-modal'))
    expect(screen.queryByTestId('job-modal')).not.toBeInTheDocument()
  })

  it('shows the empty state when the project has no jobs', () => {
    renderPane()
    expect(screen.getByText('No jobs yet — ask the agent to launch one')).toBeInTheDocument()
  })

  it('shows the rail track during the first load', () => {
    mockFirstLoad = true
    const { container } = renderPane()
    expect(container.querySelector('[data-testid="rail-track"]')).toBeInTheDocument()
  })

  it('maximize covers the whole surface (absolute inset-0), restore returns to the split', () => {
    const { container } = renderPane()
    const pane = container.firstElementChild as HTMLElement
    expect(pane.className).not.toContain('absolute')
    fireEvent.click(screen.getByLabelText('Maximize'))
    expect(pane.className).toContain('absolute')
    expect(pane.className).toContain('inset-0')
    fireEvent.click(screen.getByLabelText('Restore'))
    expect(pane.className).not.toContain('absolute')
    expect(pane.style.width).toBe('480px')
  })

  it('writes the open job to ?job= (a place), so Back closes it and a link reopens it', () => {
    mockJobs = [job('j-42', 'running', '/specrails:implement #7')]
    renderPane()
    fireEvent.click(screen.getByText('/specrails:implement #7'))
    expect(screen.getByTestId('location')).toHaveTextContent('/?job=j-42')
    fireEvent.click(screen.getByText('close-modal'))
    expect(screen.getByTestId('location')).toHaveTextContent(/^\/$/)
    expect(screen.queryByTestId('job-modal')).not.toBeInTheDocument()
  })

  it('opens the job named by the URL (deep link / Forward)', async () => {
    mockJobs = [job('j-42', 'running', '/specrails:implement #7')]
    renderPane('p1', '/?job=j-42')
    expect(await screen.findByTestId('job-modal')).toBeInTheDocument()
    expect(screen.getByText('j-42')).toBeInTheDocument()
  })
})
