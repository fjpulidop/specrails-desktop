import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { render } from '../../../../test-utils'

vi.mock('highlight.js/styles/atom-one-dark.css', () => ({}))

import DocsDialog from '../DocsDialog'
import { DOC_ANCHOR_PREFIX, findDocAnchor, parseHeadingAnchor } from '../../lib/docs-links'

const INDEX = {
  categories: [
    { name: 'Insights', slug: 'insights', docs: [{ title: 'Analytics & cost tracking', slug: 'analytics-and-cost-tracking' }] },
    { name: 'Pipeline', slug: 'pipeline', docs: [{ title: 'Rails & jobs', slug: 'rails-and-jobs' }] },
  ],
}

const PAGES: Record<string, { title: string; content: string }> = {
  'insights/analytics-and-cost-tracking': {
    title: 'Analytics & cost tracking',
    content: '# Analytics & cost tracking\n\nIntro.\n\n## Filtering\n\nText.\n\n## Daily budgets {#daily-budget}\n\nCap a day.\n',
  },
  'pipeline/rails-and-jobs': {
    title: 'Rails & jobs',
    content: '# Rails & jobs {#rails}\n\n## The job queue\n\nQueue text.\n',
  },
}

function mockGuide() {
  ;(global.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
    const path = String(url).split('/api/docs')[1].split('?')[0]
    if (path === '' || path === '/') return { ok: true, status: 200, json: async () => INDEX }
    const page = PAGES[path.slice(1)]
    if (!page) return { ok: false, status: 404, json: async () => ({}) }
    const [category, slug] = path.slice(1).split('/')
    return { ok: true, status: 200, json: async () => ({ ...page, category, slug }) }
  })
}

describe('heading anchors', () => {
  it('splits a trailing {#anchor} off a heading', () => {
    expect(parseHeadingAnchor('Daily budgets {#daily-budget}')).toEqual({ text: 'Daily budgets', anchor: 'daily-budget' })
    expect(parseHeadingAnchor('Plain heading')).toEqual({ text: 'Plain heading', anchor: null })
    expect(parseHeadingAnchor('Code `{#x}` inside')).toEqual({ text: 'Code `{#x}` inside', anchor: null })
  })

  it('finds a heading by anchor, falling back to its text', () => {
    document.body.innerHTML = `<div><h2 id="${DOC_ANCHOR_PREFIX}a">First</h2><h3>Second heading</h3></div>`
    expect(findDocAnchor(document.body, { anchor: 'a' })?.textContent).toBe('First')
    expect(findDocAnchor(document.body, { anchor: 'gone', heading: 'Second heading' })?.textContent).toBe('Second heading')
    expect(findDocAnchor(document.body, { anchor: 'gone' })).toBeNull()
  })
})

describe('DocsDialog opened at a target', () => {
  const scrollIntoView = vi.fn()
  let original: typeof HTMLElement.prototype.scrollIntoView

  beforeEach(() => {
    vi.clearAllMocks()
    original = HTMLElement.prototype.scrollIntoView
    HTMLElement.prototype.scrollIntoView = function scroll(this: HTMLElement, ...args: unknown[]) { scrollIntoView(this.id, ...args) } as typeof original
    mockGuide()
  })
  afterEach(() => { HTMLElement.prototype.scrollIntoView = original })

  it('opens the target page and scrolls to the anchored heading, hiding the {#anchor}', async () => {
    render(<DocsDialog open onClose={vi.fn()} target={{ category: 'insights', slug: 'analytics-and-cost-tracking', anchor: 'daily-budget', nonce: 1 }} />)
    const heading = await screen.findByRole('heading', { name: 'Daily budgets' })
    expect(heading.id).toBe('doc-daily-budget')
    expect(screen.queryByText(/\{#/)).toBeNull()
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith('doc-daily-budget', expect.anything()))
  })

  it('lands on a heading by its text when it has no explicit anchor (search result)', async () => {
    render(<DocsDialog open onClose={vi.fn()} target={{ category: 'pipeline', slug: 'rails-and-jobs', heading: 'The job queue', nonce: 1 }} />)
    await screen.findByRole('heading', { name: 'The job queue' })
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled())
  })

  it('does not replay the scroll after the dialog is reopened without a target', async () => {
    const { rerender } = render(<DocsDialog open onClose={vi.fn()} target={{ category: 'insights', slug: 'analytics-and-cost-tracking', anchor: 'daily-budget', nonce: 1 }} />)
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1))
    rerender(<DocsDialog open={false} onClose={vi.fn()} target={null} />)
    rerender(<DocsDialog open onClose={vi.fn()} target={null} />)
    await screen.findByRole('heading', { name: 'Daily budgets' })
    expect(scrollIntoView).toHaveBeenCalledTimes(1)
  })
})
