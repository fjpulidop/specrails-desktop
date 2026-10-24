import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, fireEvent } from '@testing-library/react'
import { render } from '../../../../test-utils'
import userEvent from '@testing-library/user-event'

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

  describe('modal standard', () => {
    const twoCategories = {
      categories: [
        { name: 'Getting started', slug: 'getting-started', docs: [{ title: 'What is specrails', slug: 'what-is-specrails' }, { title: 'Install', slug: 'install' }] },
        { name: 'Pipeline', slug: 'pipeline', docs: [{ title: 'Rails and jobs', slug: 'rails-and-jobs' }] },
      ],
    }

    it('shows an 8-row sidebar skeleton (not a spinner) while the index loads', async () => {
      let resolveIndex: (v: unknown) => void = () => {}
      ;(global.fetch as ReturnType<typeof vi.fn>).mockReturnValueOnce(new Promise((r) => { resolveIndex = r }))
      render(<DocsDialog open={true} onClose={vi.fn()} />)
      const skeleton = await screen.findByTestId('docs-sidebar-skeleton')
      expect(skeleton).toHaveAttribute('role', 'status')
      expect(skeleton.querySelectorAll('[data-skeleton-row]')).toHaveLength(8)
      expect(skeleton.querySelector('.animate-spin')).toBeNull()
      resolveIndex({ ok: true, json: async () => twoCategories })
      await waitFor(() => expect(screen.queryByTestId('docs-sidebar-skeleton')).not.toBeInTheDocument())
    })

    it('describes what the docs are and lands on the first guide (no index page duplicating the sidebar)', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ ok: true, json: async () => twoCategories })
        .mockResolvedValue({ ok: true, json: async () => ({ title: 'What is specrails', content: 'Intro body', category: 'getting-started', slug: 'what-is-specrails' }) })
      render(<DocsDialog open={true} onClose={vi.fn()} />)
      const dialog = await screen.findByRole('dialog', { name: 'Documentation' })
      await waitFor(() => expect(dialog).toHaveAccessibleDescription('3 guides bundled with this version'))
      await waitFor(() =>
        expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('/api/docs/getting-started/what-is-specrails')),
      )
      expect(await screen.findByText('Intro body')).toBeInTheDocument()
      // Each guide is listed once (sidebar only).
      expect(screen.getAllByRole('button', { name: 'Install' })).toHaveLength(1)
      expect(screen.getByRole('button', { name: 'What is specrails' })).toHaveAttribute('aria-current', 'page')
    })

    it('filters the sidebar by guide title and reports no matches', async () => {
      const user = userEvent.setup()
      ;(global.fetch as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ ok: true, json: async () => twoCategories })
        .mockResolvedValue({ ok: true, json: async () => ({ title: 'x', content: 'x', category: 'getting-started', slug: 'what-is-specrails' }) })
      render(<DocsDialog open={true} onClose={vi.fn()} />)
      const filter = await screen.findByRole('searchbox', { name: 'Filter guides' })
      // The filter is the initial focus.
      await waitFor(() => expect(filter).toHaveFocus())
      await user.type(filter, 'jobs')
      expect(screen.getByRole('button', { name: 'Rails and jobs' })).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Install' })).not.toBeInTheDocument()
      expect(screen.queryByText('Getting started')).not.toBeInTheDocument()
      await user.clear(filter)
      await user.type(filter, 'zzz')
      expect(screen.getByText('No guides match “zzz”.')).toBeInTheDocument()
    })
  })
})
