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

  it('opens the near-fullscreen execution modal on job click and closes it', () => {
    mockJobs = [job('j-42', 'running', '/specrails:implement #7')]
    renderPane('mission-project')
    expect(screen.queryByTestId('job-modal')).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('/specrails:implement #7'))
    expect(screen.getByTestId('job-modal')).toBeInTheDocument()
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

  it('opens the job named by the URL (deep link / Forward)', () => {
    mockJobs = [job('j-42', 'running', '/specrails:implement #7')]
    renderPane('p1', '/?job=j-42')
    expect(screen.getByTestId('job-modal')).toBeInTheDocument()
    expect(screen.getByText('j-42')).toBeInTheDocument()
  })
})
