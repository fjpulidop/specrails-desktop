import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, fireEvent } from '@testing-library/react'
import { render } from '../../test-utils'

// Render children, and (when DocsDialog passes a custom `a` component) a couple
// of fixed links so the in-modal link-navigation handler is exercised.
vi.mock('react-markdown', () => ({
  default: ({
    children,
    components,
  }: {
    children: string
    components?: { a?: React.ComponentType<{ href?: string; children?: React.ReactNode }> }
  }) => {
    const A = components?.a
    return (
      <div>
        <span>{children}</span>
        {A && <A href="the-loop-builder">internal-link</A>}
        {A && <A href="https://example.com">external-link</A>}
      </div>
    )
  },
}))
vi.mock('remark-gfm', () => ({ default: () => {} }))
vi.mock('rehype-highlight', () => ({ default: () => {} }))
vi.mock('highlight.js/styles/atom-one-dark.css', () => ({}))

import DocsDialog from '../DocsDialog'
import { resolveDocHref } from '../../lib/docs-links'

describe('resolveDocHref', () => {
  it('resolves a same-category slug against the current category', () => {
    expect(resolveDocHref('the-loop-builder', 'pipeline')).toEqual({ category: 'pipeline', slug: 'the-loop-builder' })
  })
  it('resolves a ../category/slug cross-category link', () => {
    expect(resolveDocHref('../integrations/using-codex', 'pipeline')).toEqual({ category: 'integrations', slug: 'using-codex' })
  })
  it('strips a trailing .md, a #fragment and a ?query', () => {
    expect(resolveDocHref('rails-and-jobs.md#queue', 'pipeline')).toEqual({ category: 'pipeline', slug: 'rails-and-jobs' })
    expect(resolveDocHref('rails-and-jobs?x=1', 'pipeline')).toEqual({ category: 'pipeline', slug: 'rails-and-jobs' })
  })
  it('returns null for external schemes and pure anchors', () => {
    expect(resolveDocHref('https://specrails.dev', 'pipeline')).toBeNull()
    expect(resolveDocHref('mailto:a@b.c', 'pipeline')).toBeNull()
    expect(resolveDocHref('#section', 'pipeline')).toBeNull()
    expect(resolveDocHref('', 'pipeline')).toBeNull()
  })
})

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

  it('clicking an internal markdown link navigates in-modal without closing it', async () => {
    const onClose = vi.fn()
    const doc = {
      ok: true,
      json: async () => ({
        title: 'Architecture',
        content: '# Architecture',
        category: 'engineering',
        slug: 'architecture',
      }),
    }
    ;(global.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          categories: [{ name: 'Engineering', slug: 'engineering', docs: [{ title: 'Architecture', slug: 'architecture' }] }],
        }),
      })
      .mockResolvedValue(doc) // every subsequent doc fetch

    render(<DocsDialog open={true} onClose={onClose} />)
    await waitFor(() => expect(screen.getAllByText(/architecture/i).length).toBeGreaterThanOrEqual(1))
    fireEvent.click(screen.getAllByText(/architecture/i)[0]) // open the doc
    await waitFor(() => expect(screen.getByText('internal-link')).toBeInTheDocument())

    fireEvent.click(screen.getByText('internal-link')) // relative link inside the doc
    await waitFor(() =>
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/docs/engineering/the-loop-builder')
      )
    )
    expect(onClose).not.toHaveBeenCalled() // modal stays open + navigable
  })

  it('opens an external markdown link in a new window, not the router', async () => {
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null)
    ;(global.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          categories: [{ name: 'Engineering', slug: 'engineering', docs: [{ title: 'Architecture', slug: 'architecture' }] }],
        }),
      })
      .mockResolvedValue({
        ok: true,
        json: async () => ({ title: 'Architecture', content: '# Architecture', category: 'engineering', slug: 'architecture' }),
      })

    render(<DocsDialog open={true} onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getAllByText(/architecture/i).length).toBeGreaterThanOrEqual(1))
    fireEvent.click(screen.getAllByText(/architecture/i)[0])
    await waitFor(() => expect(screen.getByText('external-link')).toBeInTheDocument())

    fireEvent.click(screen.getByText('external-link'))
    expect(openSpy).toHaveBeenCalledWith('https://example.com', '_blank', 'noopener,noreferrer')
    openSpy.mockRestore()
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
