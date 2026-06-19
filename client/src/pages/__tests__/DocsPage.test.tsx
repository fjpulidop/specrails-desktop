import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { render } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { TooltipProvider } from '../../components/ui/tooltip'
import React from 'react'

// Mock heavy deps
vi.mock('react-markdown', () => ({
  default: ({ children }: { children: string }) => <div data-testid="markdown">{children}</div>,
}))
vi.mock('remark-gfm', () => ({ default: () => {} }))
vi.mock('rehype-highlight', () => ({ default: () => {} }))
vi.mock('highlight.js/styles/atom-one-dark.css', () => ({}))

import DocsPage from '../DocsPage'

function renderWithRoute(initialEntry: string) {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <TooltipProvider>
        <Routes>
          <Route path="/docs" element={<DocsPage />} />
          <Route path="/docs/:category/:slug" element={<DocsPage />} />
        </Routes>
      </TooltipProvider>
    </MemoryRouter>
  )
}

const mockIndex = {
  categories: [
    {
      name: 'Engineering',
      slug: 'engineering',
      docs: [
        { title: 'Architecture', slug: 'architecture' },
        { title: 'Testing', slug: 'testing' },
      ],
    },
  ],
}

describe('DocsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(global.fetch as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (url === '/api/docs' || url.startsWith('/api/docs?')) {
        return Promise.resolve({
          ok: true,
          json: async () => mockIndex,
        })
      }
      if (url.includes('/api/docs/engineering/architecture')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            title: 'Architecture',
            content: '# Architecture\nThis describes the architecture.',
            category: 'engineering',
            slug: 'architecture',
          }),
        })
      }
      if (url.includes('/api/docs/engineering/missing')) {
        return Promise.resolve({ ok: false, status: 404 })
      }
      if (url.includes('/api/docs/engineering/server-error')) {
        return Promise.resolve({ ok: false, status: 500 })
      }
      return Promise.reject(new Error('Unknown URL'))
    })
  })

  describe('index view', () => {
    it('renders the docs index when no category/slug in URL', async () => {
      renderWithRoute('/docs')
      await waitFor(() => {
        const items = screen.getAllByText(/engineering/i)
        expect(items.length).toBeGreaterThanOrEqual(1)
      })
    })

    it('renders doc links in sidebar', async () => {
      renderWithRoute('/docs')
      await waitFor(() => {
        const items = screen.getAllByText(/architecture/i)
        expect(items.length).toBeGreaterThanOrEqual(1)
      })
    })

    it('renders index heading text', async () => {
      renderWithRoute('/docs')
      await waitFor(() => {
        const items = screen.getAllByText(/documentation/i)
        expect(items.length).toBeGreaterThanOrEqual(1)
      })
    })
  })

  describe('document view', () => {
    it('renders document content when category/slug in URL', async () => {
      renderWithRoute('/docs/engineering/architecture')
      await waitFor(() => {
        expect(screen.getByTestId('markdown')).toBeInTheDocument()
      })
    })

    it('renders the document content text', async () => {
      renderWithRoute('/docs/engineering/architecture')
      await waitFor(() => {
        expect(screen.getByText(/# Architecture/)).toBeInTheDocument()
      })
    })

    it('shows loading spinner while document is loading', () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockImplementation(() => new Promise(() => {}))
      renderWithRoute('/docs/engineering/architecture')
      // The spinner is rendered during load
      const spinners = document.querySelectorAll('.animate-spin')
      expect(spinners.length).toBeGreaterThanOrEqual(1)
    })

    it('shows error when document fetch fails with non-404', async () => {
      renderWithRoute('/docs/engineering/server-error')
      await waitFor(() => {
        expect(screen.getByText(/HTTP 500/i)).toBeInTheDocument()
      })
    })
  })
})
