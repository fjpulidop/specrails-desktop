import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '../../../../test-utils'
import ActivityFeedPage from '../ActivityFeedPage'
import type { ActivityItem } from '../../hooks/useActivity'

vi.mock('../../../../hooks/useDesktop', () => ({
  useDesktop: () => ({
    activeProjectId: 'proj-1',
    projects: [],
    isLoading: false,
    setupProjectIds: new Set(),
    setActiveProjectId: vi.fn(),
    startSetupWizard: vi.fn(),
    completeSetupWizard: vi.fn(),
    addProject: vi.fn(),
    removeProject: vi.fn(),
  }),
}))

// Controlled useActivity mock state
let mockItems: ActivityItem[] = []
let mockLoading = false
let mockHasMore = false
const mockLoadMore = vi.fn()

vi.mock('../../hooks/useActivity', () => ({
  useActivity: () => ({
    items: mockItems,
    loading: mockLoading,
    hasMore: mockHasMore,
    loadMore: mockLoadMore,
  }),
}))

const baseItems: ActivityItem[] = [
  {
    type: 'job_completed',
    jobId: 'job-1',
    jobCommand: '/specrails:implement --spec SPEA-001',
    timestamp: new Date(Date.now() - 30 * 1000).toISOString(), // 30s ago
    costUsd: 0.0123,
  },
  {
    type: 'job_failed',
    jobId: 'job-2',
    jobCommand: '/specrails:health-check',
    timestamp: new Date(Date.now() - 5 * 60 * 1000).toISOString(), // 5m ago
    costUsd: null,
  },
  {
    type: 'job_canceled',
    jobId: 'job-3',
    jobCommand: '/specrails:propose-spec',
    timestamp: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(), // 2h ago
    costUsd: 0.0056,
  },
  {
    type: 'job_started',
    jobId: 'job-4',
    jobCommand: '/specrails:batch-implement',
    timestamp: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(), // 3d ago
    costUsd: null,
  },
]

describe('ActivityFeedPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockItems = []
    mockLoading = false
    mockHasMore = false
    // Re-apply IntersectionObserver mock (vi.restoreAllMocks() in afterEach removes it)
    global.IntersectionObserver = vi.fn().mockImplementation(() => ({
      observe: vi.fn(),
      unobserve: vi.fn(),
      disconnect: vi.fn(),
    }))
  })

  it('renders Activity heading', () => {
    render(<ActivityFeedPage />)
    expect(screen.getByText('Activity')).toBeInTheDocument()
  })

  it('shows loading spinner when loading and no items', () => {
    mockLoading = true
    mockItems = []
    const { container } = render(<ActivityFeedPage />)
    const spinner = container.querySelector('.animate-spin')
    expect(spinner).toBeInTheDocument()
  })

  it('shows empty state when not loading and no items', () => {
    mockItems = []
    mockLoading = false
    render(<ActivityFeedPage />)
    expect(screen.getByText('No activity yet')).toBeInTheDocument()
    expect(screen.getByText('Job events will appear here when jobs run')).toBeInTheDocument()
  })

  it('renders activity items list when items exist', () => {
    mockItems = baseItems
    render(<ActivityFeedPage />)
    expect(screen.getByText('/specrails:implement --spec SPEA-001')).toBeInTheDocument()
    expect(screen.getByText('/specrails:health-check')).toBeInTheDocument()
    expect(screen.getByText('/specrails:propose-spec')).toBeInTheDocument()
    expect(screen.getByText('/specrails:batch-implement')).toBeInTheDocument()
  })

  it('renders "Completed" label for job_completed type', () => {
    mockItems = [baseItems[0]]
    render(<ActivityFeedPage />)
    expect(screen.getByText('Completed')).toBeInTheDocument()
  })

  it('renders "Failed" label for job_failed type', () => {
    mockItems = [baseItems[1]]
    render(<ActivityFeedPage />)
    expect(screen.getByText('Failed')).toBeInTheDocument()
  })

  it('renders "Canceled" label for job_canceled type', () => {
    mockItems = [baseItems[2]]
    render(<ActivityFeedPage />)
    expect(screen.getByText('Canceled')).toBeInTheDocument()
  })

  it('renders "Started" label for job_started (default) type', () => {
    mockItems = [baseItems[3]]
    render(<ActivityFeedPage />)
    expect(screen.getByText('Started')).toBeInTheDocument()
  })

  it('renders cost in USD when costUsd is not null', () => {
    mockItems = [baseItems[0]] // costUsd: 0.0123
    render(<ActivityFeedPage />)
    expect(screen.getByText('$0.0123')).toBeInTheDocument()
  })

  it('does not render cost when costUsd is null', () => {
    mockItems = [baseItems[1]] // costUsd: null
    render(<ActivityFeedPage />)
    expect(screen.queryByText(/^\$[0-9]/)).not.toBeInTheDocument()
  })

  it('renders seconds-ago timestamp for recent items', () => {
    mockItems = [baseItems[0]] // 30s ago
    render(<ActivityFeedPage />)
    expect(screen.getByText(/\d+s ago/)).toBeInTheDocument()
  })

  it('renders minutes-ago timestamp', () => {
    mockItems = [baseItems[1]] // 5m ago
    render(<ActivityFeedPage />)
    expect(screen.getByText(/5m ago/)).toBeInTheDocument()
  })

  it('renders hours-ago timestamp', () => {
    mockItems = [baseItems[2]] // 2h ago
    render(<ActivityFeedPage />)
    expect(screen.getByText(/2h ago/)).toBeInTheDocument()
  })

  it('renders days-ago timestamp for old items', () => {
    mockItems = [baseItems[3]] // 3d ago
    render(<ActivityFeedPage />)
    expect(screen.getByText(/3d ago/)).toBeInTheDocument()
  })

  it('shows "All activity loaded" when hasMore is false and items exist', () => {
    mockItems = baseItems
    mockHasMore = false
    render(<ActivityFeedPage />)
    expect(screen.getByText('All activity loaded')).toBeInTheDocument()
  })

  it('does not show "All activity loaded" when hasMore is true', () => {
    mockItems = baseItems
    mockHasMore = true
    render(<ActivityFeedPage />)
    expect(screen.queryByText('All activity loaded')).not.toBeInTheDocument()
  })

  it('shows loading spinner at bottom when loading with existing items', async () => {
    mockItems = baseItems
    mockLoading = true
    const { container } = render(<ActivityFeedPage />)
    // Shows items AND loading spinner at the bottom
    expect(screen.getByText('/specrails:implement --spec SPEA-001')).toBeInTheDocument()
    const spinners = container.querySelectorAll('.animate-spin')
    expect(spinners.length).toBeGreaterThanOrEqual(1)
  })

  it('renders a list item for each activity item', () => {
    mockItems = baseItems
    render(<ActivityFeedPage />)
    const listItems = document.querySelectorAll('li')
    expect(listItems.length).toBe(baseItems.length)
  })
})

describe('ActivityFeedPage - formatRelativeTime edge cases', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockLoading = false
    mockHasMore = false
    global.IntersectionObserver = vi.fn().mockImplementation(() => ({
      observe: vi.fn(),
      unobserve: vi.fn(),
      disconnect: vi.fn(),
    }))
  })

  it('shows exact seconds for sub-minute timestamps', () => {
    mockItems = [{
      type: 'job_completed',
      jobId: 'j1',
      jobCommand: '/specrails:implement',
      timestamp: new Date(Date.now() - 45 * 1000).toISOString(), // 45s ago
      costUsd: null,
    }]
    render(<ActivityFeedPage />)
    expect(screen.getByText('45s ago')).toBeInTheDocument()
  })

  it('shows 1d ago for ~25h old item', () => {
    mockItems = [{
      type: 'job_failed',
      jobId: 'j2',
      jobCommand: '/specrails:health-check',
      timestamp: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
      costUsd: null,
    }]
    render(<ActivityFeedPage />)
    expect(screen.getByText('1d ago')).toBeInTheDocument()
  })
})
