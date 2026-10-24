import { describe, it, expect, vi, afterEach } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { render } from '../../test-utils'
import { HelpHint } from '../HelpHint'
import { EmptyState } from '../ui/empty-state'
import { OPEN_DOCS_EVENT, type OpenDocsDetail } from '../../lib/docs-events'

function captureOpenDocs() {
  const seen: OpenDocsDetail[] = []
  const handler = (event: Event) => seen.push((event as CustomEvent<OpenDocsDetail>).detail)
  window.addEventListener(OPEN_DOCS_EVENT, handler)
  return { seen, stop: () => window.removeEventListener(OPEN_DOCS_EVENT, handler) }
}

describe('HelpHint', () => {
  let stop = () => {}
  afterEach(() => stop())

  it('names its topic and asks the shell to open the guide at the topic anchor', async () => {
    const capture = captureOpenDocs()
    stop = capture.stop
    render(<HelpHint topic="dailyBudget" />)
    const button = screen.getByRole('button', { name: 'Learn more about daily budgets' })
    await userEvent.click(button)
    expect(capture.seen).toEqual([
      { target: { category: 'insights', slug: 'analytics-and-cost-tracking', anchor: 'daily-budget' } },
    ])
  })

  it('link variant reads "Learn more" but keeps the topic in its accessible name', () => {
    render(<HelpHint topic="flowMode" variant="link" />)
    const button = screen.getByRole('button', { name: 'Learn more about Flow' })
    expect(button).toHaveTextContent('Learn more')
  })

  it('does not trigger the clickable parent it sits in', async () => {
    const capture = captureOpenDocs()
    stop = capture.stop
    const onParent = vi.fn()
    render(<div onClick={onParent} onMouseDown={onParent}><HelpHint topic="railLoops" /></div>)
    await userEvent.click(screen.getByRole('button', { name: /what a rail runs/ }))
    expect(onParent).not.toHaveBeenCalled()
    expect(capture.seen).toHaveLength(1)
  })
})

describe('EmptyState learnMore', () => {
  it('shows Learn more after the action, only when asked', () => {
    const { rerender } = render(<EmptyState title="Nothing" description="Runs appear here" action={<button>Go</button>} learnMore="railLoops" />)
    const buttons = screen.getAllByRole('button')
    expect(buttons.map((b) => b.getAttribute('aria-label') ?? b.textContent)).toEqual(['Go', 'Learn more about what a rail runs'])
    rerender(<EmptyState title="Nothing" />)
    expect(screen.queryByRole('button')).toBeNull()
  })
})
