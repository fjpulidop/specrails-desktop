import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import type { JobSummary } from '../../../types'

vi.mock('../../../lib/api', () => ({ getApiBase: () => '/api/projects/p1' }))

vi.mock('../../../hooks/useDesktop', () => ({
  useDesktop: () => ({
    projects: [{ id: 'p1', name: 'acme', slug: 'acme', path: '/acme', provider: 'claude' }],
    activeProjectId: 'p1',
    setActiveProjectId: vi.fn(),
  }),
}))

vi.mock('../../../hooks/useSharedWebSocket', () => ({
  useSharedWebSocket: () => ({
    registerHandler: vi.fn(),
    unregisterHandler: vi.fn(),
    connectionStatus: 'connected',
  }),
}))

let mockJobs: JobSummary[] = []
let mockFirstLoad = false
vi.mock('../../../hooks/useProjectCache', () => ({
  useProjectCache: () => ({ data: mockJobs, isFirstLoad: mockFirstLoad, refresh: vi.fn() }),
}))

// The real modal has its own test suite — a stub proves the pane wires jobId/onClose.
vi.mock('../../JobDetailModal', () => ({
  JobDetailModal: ({ jobId, onClose }: { jobId: string; onClose: () => void }) => (
    <div data-testid="job-modal">
      <span>{jobId}</span>
      <button onClick={onClose}>close-modal</button>
    </div>
  ),
}))

import { AgentModeJobsPane } from '../AgentModeJobsPane'
import { AgentWorkspaceProvider } from '../../../context/AgentWorkspaceContext'

function job(id: string, status: JobSummary['status'], command: string): JobSummary {
  return { id, command, status, started_at: new Date().toISOString() }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockJobs = []
  mockFirstLoad = false
})

function renderPane() {
  return render(
    <AgentWorkspaceProvider>
      <AgentModeJobsPane projectId="p1" />
    </AgentWorkspaceProvider>,
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
    expect(screen.getByText('running')).toBeInTheDocument()
    expect(screen.getByText('completed')).toBeInTheDocument()
  })

  it('opens the near-fullscreen execution modal on job click and closes it', () => {
    mockJobs = [job('j-42', 'running', '/specrails:implement #7')]
    renderPane()
    expect(screen.queryByTestId('job-modal')).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('/specrails:implement #7'))
    expect(screen.getByTestId('job-modal')).toBeInTheDocument()
    expect(screen.getByText('j-42')).toBeInTheDocument()
    fireEvent.click(screen.getByText('close-modal'))
    expect(screen.queryByTestId('job-modal')).not.toBeInTheDocument()
  })

  it('shows the empty state when the project has no jobs', () => {
    renderPane()
    expect(screen.getByText('No jobs yet — ask the agent to launch one')).toBeInTheDocument()
  })

  it('shows a spinner during the first load', () => {
    mockFirstLoad = true
    const { container } = renderPane()
    expect(container.querySelector('.animate-spin')).toBeInTheDocument()
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
})
