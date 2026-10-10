import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '../../test-utils'
import userEvent from '@testing-library/user-event'
import { CommandPalette } from '../CommandPalette'

// Ensure ResizeObserver mock survives vi.restoreAllMocks()
beforeEach(() => {
  global.ResizeObserver = vi.fn().mockImplementation(function () {
    return {
      observe: vi.fn(),
      unobserve: vi.fn(),
      disconnect: vi.fn(),
    }
  })
})

const mockSetActiveProjectId = vi.fn()
vi.mock('../../hooks/useDesktop', () => ({
  useDesktop: () => ({
    projects: [
      { id: 'p1', slug: 'project-alpha', name: 'Project Alpha', path: '/a', db_path: '/a/db', provider: 'claude', added_at: '', last_seen_at: '' },
      { id: 'p2', slug: 'project-beta', name: 'Project Beta', path: '/b', db_path: '/b/db', provider: 'codex', added_at: '', last_seen_at: '' },
    ],
    activeProjectId: 'p1',
    setActiveProjectId: mockSetActiveProjectId,
  }),
}))

vi.mock('../../lib/api', () => ({
  getApiBase: () => '/api/projects/p1',
}))

const mockNavigate = vi.fn()
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return { ...actual, useNavigate: () => mockNavigate }
})

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), promise: vi.fn() },
}))

function mockFetchResponses() {
  global.fetch = vi.fn().mockImplementation((url: string) => {
    if (typeof url === 'string' && url.includes('/config')) {
      return Promise.resolve({
        ok: true,
        json: async () => ({
          commands: [
            { id: 'c1', name: 'Implement', slug: 'implement', description: 'Build features' },
            { id: 'c2', name: 'Health Check', slug: 'health-check', description: 'Check health' },
          ],
        }),
      })
    }
    if (typeof url === 'string' && url.includes('/jobs')) {
      return Promise.resolve({
        ok: true,
        json: async () => ({
          jobs: [
            { id: 'j1', command: '/specrails:implement', status: 'completed', started_at: '2026-03-20T10:00:00Z' },
            { id: 'j2', command: '/specrails:health-check', status: 'failed', started_at: '2026-03-20T11:00:00Z' },
          ],
        }),
      })
    }
    if (typeof url === 'string' && url.includes('/spawn')) {
      return Promise.resolve({
        ok: true,
        json: async () => ({ jobId: 'new-job-1' }),
      })
    }
    return Promise.resolve({ ok: false, json: async () => ({}) })
  })
}

describe('CommandPalette', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFetchResponses()
    window.localStorage.clear()
  })

  // ─── Opening / Closing ─────────────────────────────────────────────────────

  it('opens on Cmd+K', async () => {
    const user = userEvent.setup()
    render(<CommandPalette />)

    expect(screen.queryByPlaceholderText(/search/i)).not.toBeInTheDocument()

    await user.keyboard('{Meta>}k{/Meta}')

    await waitFor(() => {
      expect(screen.getByPlaceholderText(/search/i)).toBeInTheDocument()
    })
  })

  it('closes on Escape', async () => {
    const user = userEvent.setup()
    render(<CommandPalette />)

    await user.keyboard('{Meta>}k{/Meta}')
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/search/i)).toBeInTheDocument()
    })

    await user.keyboard('{Escape}')
    await waitFor(() => {
      expect(screen.queryByPlaceholderText(/search/i)).not.toBeInTheDocument()
    })
  })

  it('toggles with repeated Cmd+K', async () => {
    const user = userEvent.setup()
    render(<CommandPalette />)

    await user.keyboard('{Meta>}k{/Meta}')
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/search/i)).toBeInTheDocument()
    })

    await user.keyboard('{Meta>}k{/Meta}')
    await waitFor(() => {
      expect(screen.queryByPlaceholderText(/search/i)).not.toBeInTheDocument()
    })
  })

  // ─── Content sections ──────────────────────────────────────────────────────

  it('shows projects when opened', async () => {
    const user = userEvent.setup()
    render(<CommandPalette />)

    await user.keyboard('{Meta>}k{/Meta}')

    await waitFor(() => {
      expect(screen.getByText('Project Alpha')).toBeInTheDocument()
      expect(screen.getByText('Project Beta')).toBeInTheDocument()
    })
  })

  it('shows commands after data loads', async () => {
    const user = userEvent.setup()
    render(<CommandPalette />)

    await user.keyboard('{Meta>}k{/Meta}')

    await waitFor(() => {
      expect(screen.getByText('Implement')).toBeInTheDocument()
      expect(screen.getByText('Health Check')).toBeInTheDocument()
    })
  })

  it('shows recent jobs after data loads', async () => {
    const user = userEvent.setup()
    render(<CommandPalette />)

    await user.keyboard('{Meta>}k{/Meta}')

    await waitFor(() => {
      expect(screen.getByText('/specrails:implement')).toBeInTheDocument()
      expect(screen.getByText('/specrails:health-check')).toBeInTheDocument()
    })
  })

  it('shows navigation items', async () => {
    const user = userEvent.setup()
    render(<CommandPalette />)

    await user.keyboard('{Meta>}k{/Meta}')

    await waitFor(() => {
      expect(screen.getByText('Dashboard')).toBeInTheDocument()
      expect(screen.getByText('Project Analytics')).toBeInTheDocument()
      expect(screen.getByText('Activity Feed')).toBeInTheDocument()
      expect(screen.getByText('Desktop Settings')).toBeInTheDocument()
      expect(screen.getByText('Docs')).toBeInTheDocument()
    })
  })

  it('marks active project', async () => {
    const user = userEvent.setup()
    render(<CommandPalette />)

    await user.keyboard('{Meta>}k{/Meta}')

    await waitFor(() => {
      expect(screen.getByText('active')).toBeInTheDocument()
    })
  })

  // ─── Fuzzy search / filtering ──────────────────────────────────────────────

  it('filters results by search query', async () => {
    const user = userEvent.setup()
    render(<CommandPalette />)

    await user.keyboard('{Meta>}k{/Meta}')
    await waitFor(() => {
      expect(screen.getByText('Project Alpha')).toBeInTheDocument()
    })

    const input = screen.getByPlaceholderText(/search/i)
    await user.type(input, 'beta')

    await waitFor(() => {
      expect(screen.getByText('Project Beta')).toBeInTheDocument()
      expect(screen.queryByText('Project Alpha')).not.toBeInTheDocument()
    })
  })

  it('shows empty state when no results match', async () => {
    const user = userEvent.setup()
    render(<CommandPalette />)

    await user.keyboard('{Meta>}k{/Meta}')
    await waitFor(() => {
      expect(screen.getByPlaceholderText(/search/i)).toBeInTheDocument()
    })

    const input = screen.getByPlaceholderText(/search/i)
    await user.type(input, 'xyznonexistent')

    await waitFor(() => {
      expect(screen.getByText('No results found.')).toBeInTheDocument()
    })
  })

  // ─── Actions ───────────────────────────────────────────────────────────────

  it('switches project on select', async () => {
    const user = userEvent.setup()
    render(<CommandPalette />)

    await user.keyboard('{Meta>}k{/Meta}')
    await waitFor(() => {
      expect(screen.getByText('Project Beta')).toBeInTheDocument()
    })

    await user.click(screen.getByText('Project Beta'))

    expect(mockSetActiveProjectId).toHaveBeenCalledWith('p2')
  })

  it('navigates to route on navigation item select', async () => {
    const user = userEvent.setup()
    render(<CommandPalette />)

    await user.keyboard('{Meta>}k{/Meta}')
    await waitFor(() => {
      expect(screen.getByText('Activity Feed')).toBeInTheDocument()
    })

    await user.click(screen.getByText('Activity Feed'))

    expect(mockNavigate).toHaveBeenCalledWith('/activity')
  })

  it('navigates to job detail on job select', async () => {
    const user = userEvent.setup()
    render(<CommandPalette />)

    await user.keyboard('{Meta>}k{/Meta}')
    await waitFor(() => {
      expect(screen.getByText('/specrails:implement')).toBeInTheDocument()
    })

    await user.click(screen.getByText('/specrails:implement'))

    expect(mockNavigate).toHaveBeenCalledWith('/jobs/j1')
  })

  it('spawns command and navigates to job on command select', async () => {
    const user = userEvent.setup()
    render(<CommandPalette />)

    await user.keyboard('{Meta>}k{/Meta}')
    await waitFor(() => {
      expect(screen.getByText('Health Check')).toBeInTheDocument()
    })

    await user.click(screen.getByText('Health Check'))

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/projects/p1/spawn',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ command: '/specrails:health-check' }),
        })
      )
      expect(mockNavigate).toHaveBeenCalledWith('/jobs/new-job-1')
    })
  })

  // ─── Super mode callbacks ────────────────────────────────────────────────────

  it('calls onOpenSettings instead of navigating in Super mode', async () => {
    const onOpenSettings = vi.fn()
    const user = userEvent.setup()
    render(<CommandPalette onOpenSettings={onOpenSettings} />)

    await user.keyboard('{Meta>}k{/Meta}')
    await waitFor(() => {
      expect(screen.getByText('Desktop Settings')).toBeInTheDocument()
    })

    await user.click(screen.getByText('Desktop Settings'))

    expect(onOpenSettings).toHaveBeenCalled()
    expect(mockNavigate).not.toHaveBeenCalledWith('/settings')
  })

  it('shows Desktop Analytics when onOpenAnalytics provided', async () => {
    const onOpenAnalytics = vi.fn()
    const user = userEvent.setup()
    render(<CommandPalette onOpenAnalytics={onOpenAnalytics} />)

    await user.keyboard('{Meta>}k{/Meta}')
    await waitFor(() => {
      expect(screen.getByText('Desktop Analytics')).toBeInTheDocument()
    })

    await user.click(screen.getByText('Desktop Analytics'))
    expect(onOpenAnalytics).toHaveBeenCalled()
  })

  it('calls onOpenDocs when provided', async () => {
    const onOpenDocs = vi.fn()
    const user = userEvent.setup()
    render(<CommandPalette onOpenDocs={onOpenDocs} />)

    await user.keyboard('{Meta>}k{/Meta}')
    await waitFor(() => {
      expect(screen.getByText('Docs')).toBeInTheDocument()
    })

    await user.click(screen.getByText('Docs'))
    expect(onOpenDocs).toHaveBeenCalled()
  })

  // ─── Error handling ───────────────────────────────────────────────────────

  it('shows error toast when command spawn fails', async () => {
    const { toast } = await import('sonner')
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/config')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            commands: [{ id: 'c1', name: 'Implement', slug: 'implement', description: 'Build' }],
          }),
        })
      }
      if (typeof url === 'string' && url.includes('/jobs')) {
        return Promise.resolve({ ok: true, json: async () => ({ jobs: [] }) })
      }
      if (typeof url === 'string' && url.includes('/spawn')) {
        return Promise.resolve({
          ok: false,
          json: async () => ({ error: 'Budget exceeded' }),
        })
      }
      return Promise.resolve({ ok: false, json: async () => ({}) })
    })

    const user = userEvent.setup()
    render(<CommandPalette />)

    await user.keyboard('{Meta>}k{/Meta}')
    await waitFor(() => {
      expect(screen.getByText('Implement')).toBeInTheDocument()
    })

    await user.click(screen.getByText('Implement'))

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Budget exceeded')
    })
  })

  it('handles fetch errors gracefully when palette opens', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('Network error'))

    const user = userEvent.setup()
    render(<CommandPalette />)

    await user.keyboard('{Meta>}k{/Meta}')

    // Projects from context should still show even if fetch fails
    await waitFor(() => {
      expect(screen.getByText('Project Alpha')).toBeInTheDocument()
      expect(screen.getByText('Dashboard')).toBeInTheDocument()
    })
  })

  it('navigates to /settings in legacy mode (no onOpenSettings)', async () => {
    const user = userEvent.setup()
    render(<CommandPalette />)

    await user.keyboard('{Meta>}k{/Meta}')
    await waitFor(() => {
      expect(screen.getByText('Desktop Settings')).toBeInTheDocument()
    })

    await user.click(screen.getByText('Desktop Settings'))
    expect(mockNavigate).toHaveBeenCalledWith('/settings')
  })

  it('navigates to /docs in legacy mode (no onOpenDocs)', async () => {
    const user = userEvent.setup()
    render(<CommandPalette />)

    await user.keyboard('{Meta>}k{/Meta}')
    await waitFor(() => {
      expect(screen.getByText('Docs')).toBeInTheDocument()
    })

    await user.click(screen.getByText('Docs'))
    expect(mockNavigate).toHaveBeenCalledWith('/docs')
  })

  // ─── Sidebar pin cycle entry ─────────────────────────────────────────────

  it('cycles the left sidebar mode via the palette entry', async () => {
    const user = userEvent.setup()
    render(<CommandPalette />)

    await user.keyboard('{Meta>}k{/Meta}')
    await waitFor(() => {
      expect(screen.getByText('Pin left sidebar open')).toBeInTheDocument()
    })

    await user.click(screen.getByText('Pin left sidebar open'))

    // Palette closes; reopen and verify the label advanced one step in the cycle
    await user.keyboard('{Meta>}k{/Meta}')
    await waitFor(() => {
      expect(screen.getByText('Collapse left sidebar (keep pinned)')).toBeInTheDocument()
    })
  })

  // ─── Keyboard hints ───────────────────────────────────────────────────────

  it('shows keyboard hints in footer', async () => {
    const user = userEvent.setup()
    render(<CommandPalette />)

    await user.keyboard('{Meta>}k{/Meta}')
    await waitFor(() => {
      expect(screen.getByText('navigate')).toBeInTheDocument()
      expect(screen.getByText('select')).toBeInTheDocument()
      expect(screen.getByText('close')).toBeInTheDocument()
    })
  })
})
