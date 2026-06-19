import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, fireEvent } from '@testing-library/react'
import { render } from '../../test-utils'

vi.mock('react-markdown', () => ({
  default: ({ children }: { children: string }) => <div>{children}</div>,
}))
vi.mock('remark-gfm', () => ({ default: () => {} }))
vi.mock('rehype-highlight', () => ({ default: () => {} }))
vi.mock('highlight.js/styles/atom-one-dark.css', () => ({}))

import DocsDialog from '../DocsDialog'

describe('DocsDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({
        categories: [
          {
            name: 'Engineering',
            slug: 'engineering',
            docs: [
              { title: 'Architecture', slug: 'architecture' },
            ],
          },
        ],
      }),
    })
  })

  it('does not render content when open=false', () => {
    render(<DocsDialog open={false} onClose={vi.fn()} />)
    expect(screen.queryByText('Documentation')).toBeNull()
  })

  it('renders Documentation title when open=true', async () => {
    render(<DocsDialog open={true} onClose={vi.fn()} />)
    await waitFor(() => {
      const items = screen.getAllByText(/documentation/i)
      expect(items.length).toBeGreaterThanOrEqual(1)
    })
  })

  it('renders category names from API', async () => {
    render(<DocsDialog open={true} onClose={vi.fn()} />)
    await waitFor(() => {
      const items = screen.getAllByText(/engineering/i)
      expect(items.length).toBeGreaterThanOrEqual(1)
    })
  })

  it('renders doc titles from categories', async () => {
    render(<DocsDialog open={true} onClose={vi.fn()} />)
    await waitFor(() => {
      const items = screen.getAllByText(/architecture/i)
      expect(items.length).toBeGreaterThanOrEqual(1)
    })
  })

  it('clicking a doc link loads the document', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          categories: [{
            name: 'Engineering',
            slug: 'engineering',
            docs: [{ title: 'Architecture', slug: 'architecture' }],
          }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          title: 'Architecture',
          content: '# Architecture\nThis is the architecture guide.',
          category: 'engineering',
          slug: 'architecture',
        }),
      })

    render(<DocsDialog open={true} onClose={vi.fn()} />)

    await waitFor(() => {
      const items = screen.getAllByText(/architecture/i)
      expect(items.length).toBeGreaterThanOrEqual(1)
    })

    // Click first Architecture link
    const archLinks = screen.getAllByText(/architecture/i)
    fireEvent.click(archLinks[0])

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/docs/engineering/architecture')
      )
    })
  })

  it('renders empty state when no docs are available', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ categories: [] }),
    })

    render(<DocsDialog open={true} onClose={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByText(/Documentation will appear here/i)).toBeInTheDocument()
    })
  })

  it('handles fetch error gracefully (empty categories)', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('network'))

    render(<DocsDialog open={true} onClose={vi.fn()} />)

    await waitFor(() => {
      expect(screen.getByText(/Documentation will appear here/i)).toBeInTheDocument()
    })
  })
})
