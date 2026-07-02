import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { render } from '../../test-utils'

// Ensure IntersectionObserver is always available (vi.restoreAllMocks can wipe setup mocks)
beforeEach(() => {
  global.IntersectionObserver = vi.fn().mockImplementation(() => ({
    observe: vi.fn(),
    unobserve: vi.fn(),
    disconnect: vi.fn(),
  }))
})

// ─── Shared mocks ─────────────────────────────────────────────────────────────

// MobileAccessSection subscribes to the shared socket for live device updates;
// stub it so the settings page renders without a SharedWebSocketProvider.
vi.mock('../../hooks/useSharedWebSocket', () => ({
  useSharedWebSocket: () => ({
    registerHandler: vi.fn(),
    unregisterHandler: vi.fn(),
    connectionStatus: 'connected',
  }),
}))

vi.mock('../../hooks/useDesktop', () => ({
  useDesktop: () => ({
    activeProjectId: 'proj-1',
    projects: [
      {
        id: 'proj-1',
        slug: 'proj-1',
        name: 'Project One',
        path: '/home/user/proj-1',
        db_path: '/home/user/.specrails/projects/proj-1/jobs.sqlite',
        added_at: '2024-01-01T00:00:00Z',
        last_seen_at: '2024-01-02T00:00:00Z',
      },
    ],
    isLoading: false,
    setupProjectIds: new Set<string>(),
    setActiveProjectId: vi.fn(),
    startSetupWizard: vi.fn(),
    completeSetupWizard: vi.fn(),
    addProject: vi.fn(),
    removeProject: vi.fn(),
  }),
}))

vi.mock('../../hooks/useActivity', () => ({
  useActivity: () => ({
    items: [],
    loading: false,
    hasMore: false,
    loadMore: vi.fn(),
  }),
}))

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), promise: vi.fn() },
  Toaster: () => null,
}))

// react-markdown and related plugins are ESM; stub them out
vi.mock('react-markdown', () => ({
  default: ({ children }: { children: string }) => <div>{children}</div>,
}))
vi.mock('remark-gfm', () => ({ default: () => {} }))
vi.mock('rehype-highlight', () => ({ default: () => {} }))
vi.mock('highlight.js/styles/atom-one-dark.css', () => ({}))

// ─── ActivityFeedPage ─────────────────────────────────────────────────────────

describe('ActivityFeedPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders Activity heading', async () => {
    const ActivityFeedPage = (await import('../ActivityFeedPage')).default
    render(<ActivityFeedPage />)
    expect(screen.getByRole('heading', { name: /activity/i })).toBeInTheDocument()
  })

  it('renders empty state when no items', async () => {
    const ActivityFeedPage = (await import('../ActivityFeedPage')).default
    render(<ActivityFeedPage />)
    await waitFor(() => {
      expect(screen.getByText('No activity yet')).toBeInTheDocument()
    })
  })

  it('renders activity items when provided', async () => {
    vi.doMock('../../hooks/useActivity', () => ({
      useActivity: () => ({
        items: [
          {
            id: 'item-1',
            type: 'job_completed' as const,
            jobId: 'job-1',
            jobCommand: '/architect --spec SPEA-001',
            timestamp: new Date().toISOString(),
            summary: 'Completed',
            costUsd: 0.05,
          },
        ],
        loading: false,
        hasMore: false,
        loadMore: vi.fn(),
      }),
    }))

    // Need fresh module import after mock change
    vi.resetModules()
    // Re-import with fresh mocks
    const ActivityFeedPageFresh = (await import('../ActivityFeedPage')).default
    render(<ActivityFeedPageFresh />)
    await waitFor(() => {
      expect(screen.getByText('/architect --spec SPEA-001')).toBeInTheDocument()
    })
  })
})

// ─── GlobalSettingsPage ───────────────────────────────────────────────────────

describe('GlobalSettingsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(global.fetch as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/api/webhooks')) {
        return Promise.resolve({ ok: true, json: async () => ({ webhooks: [] }) })
      }
      if (typeof url === 'string' && url.includes('/api/budget')) {
        return Promise.resolve({ ok: true, json: async () => ({ desktopDailyBudgetUsd: null }) })
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ port: 4200, specrailsTechUrl: 'http://localhost:3000' }),
      })
    })
  })

  it('renders Desktop Settings dialog when open=true', async () => {
    const GlobalSettingsPage = (await import('../GlobalSettingsPage')).default
    render(<GlobalSettingsPage open={true} onClose={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByText('Desktop Settings')).toBeInTheDocument()
    })
  })

  it('does not render dialog content when open=false', async () => {
    const GlobalSettingsPage = (await import('../GlobalSettingsPage')).default
    render(<GlobalSettingsPage open={false} onClose={vi.fn()} />)
    expect(screen.queryByText('Desktop Settings')).toBeNull()
  })

  it('renders registered projects section when open=true', async () => {
    const GlobalSettingsPage = (await import('../GlobalSettingsPage')).default
    render(<GlobalSettingsPage open={true} onClose={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByText(/registered projects/i)).toBeInTheDocument()
    })
  })

  it('does not render the removed specrails-tech URL field', async () => {
    const GlobalSettingsPage = (await import('../GlobalSettingsPage')).default
    render(<GlobalSettingsPage open={true} onClose={vi.fn()} />)

    await waitFor(() => {
      expect(screen.queryByPlaceholderText('http://localhost:3000')).not.toBeInTheDocument()
    })
  })

  it('renders desktop information section', async () => {
    const GlobalSettingsPage = (await import('../GlobalSettingsPage')).default
    render(<GlobalSettingsPage open={true} onClose={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByText('Desktop Information')).toBeInTheDocument()
    })
  })
})

// ─── DocsPage ─────────────────────────────────────────────────────────────────

describe('DocsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({
        categories: [
          {
            name: 'General',
            slug: 'general',
            docs: [
              { title: 'Getting Started', slug: 'getting-started' },
            ],
          },
        ],
      }),
    })
  })

  it('renders Documentation sidebar link', async () => {
    const DocsPage = (await import('../DocsPage')).default
    render(<DocsPage />)

    await waitFor(() => {
      // There may be multiple "Documentation" elements (sidebar link + index heading)
      const items = screen.getAllByText(/documentation/i)
      expect(items.length).toBeGreaterThanOrEqual(1)
    })
  })

  it('renders category names from the API', async () => {
    const DocsPage = (await import('../DocsPage')).default
    render(<DocsPage />)

    await waitFor(() => {
      // "General" appears in sidebar and in index, use getAllByText
      const items = screen.getAllByText(/general/i)
      expect(items.length).toBeGreaterThanOrEqual(1)
    })
  })

  it('renders doc links from categories', async () => {
    const DocsPage = (await import('../DocsPage')).default
    render(<DocsPage />)

    await waitFor(() => {
      // "Getting Started" may appear in sidebar and index
      const items = screen.getAllByText(/getting started/i)
      expect(items.length).toBeGreaterThanOrEqual(1)
    })
  })

  it('renders index page total doc count', async () => {
    const DocsPage = (await import('../DocsPage')).default
    render(<DocsPage />)

    await waitFor(() => {
      // DocsIndex shows "1 document across 1 categories."
      expect(screen.getByText(/1 document/i)).toBeInTheDocument()
    })
  })

  it('renders empty state message when no docs', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ categories: [] }),
    })

    const DocsPage = (await import('../DocsPage')).default
    render(<DocsPage />)

    await waitFor(() => {
      expect(screen.getByText(/Documentation will appear here/i)).toBeInTheDocument()
    })
  })

  it('falls back to empty categories when fetch fails', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('network'))

    const DocsPage = (await import('../DocsPage')).default
    render(<DocsPage />)

    await waitFor(() => {
      expect(screen.getByText(/Documentation will appear here/i)).toBeInTheDocument()
    })
  })
})
