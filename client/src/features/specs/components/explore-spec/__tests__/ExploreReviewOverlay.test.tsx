import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import {
  ExploreReviewOverlay,
  EMPTY_REVIEW_BASELINE,
  type ReviewBaseline,
  type ReviewProposed,
} from '../ExploreReviewOverlay'

function makeProposed(overrides: Partial<ReviewProposed> = {}): ReviewProposed {
  return {
    title: 'Dark mode toggle',
    description: 'Add a Settings toggle for dark mode.',
    labels: ['ui', 'theme'],
    priority: 'medium',
    acceptanceCriteria: ['Toggle visible', 'Persists across reloads'],
    ...overrides,
  }
}

describe('ExploreReviewOverlay', () => {
  let onBack: ReturnType<typeof vi.fn>
  let onCommit: ReturnType<typeof vi.fn>

  beforeEach(() => {
    onBack = vi.fn()
    onCommit = vi.fn()
  })

  it('renders all proposed values as additions with empty baseline (no removed sections)', () => {
    render(
      <ExploreReviewOverlay
        baseline={EMPTY_REVIEW_BASELINE}
        proposed={makeProposed()}
        onBack={onBack}
        onCommit={onCommit}
      />,
    )
    // All description text is rendered as added (highlighted)
    expect(screen.getAllByLabelText('inserted').length).toBeGreaterThan(0)
    // No removed segments
    expect(screen.queryAllByLabelText('removed')).toHaveLength(0)
    // Title with all words as additions
    expect(screen.getByTestId('review-title')).toHaveTextContent('Dark mode toggle')
    // Priority renders single pill (no arrow)
    expect(screen.getByTestId('review-priority')).toHaveTextContent('medium')
    // Chips for labels
    expect(screen.getByTestId('review-labels')).toHaveTextContent('ui')
    expect(screen.getByTestId('review-labels')).toHaveTextContent('theme')
    // Criteria bullets
    expect(screen.getByTestId('review-criteria')).toHaveTextContent('Toggle visible')
  })

  it('renders mixed word-level diff on description against a non-empty baseline', () => {
    const baseline: ReviewBaseline = {
      ...EMPTY_REVIEW_BASELINE,
      title: 'Dark mode toggle',
      description: 'Users cannot change the OS theme.',
    }
    const proposed = makeProposed({ description: 'Users cannot override the OS theme.' })
    render(<ExploreReviewOverlay baseline={baseline} proposed={proposed} onBack={onBack} onCommit={onCommit} />)
    // Title is identical → no diff segments labeled
    const title = screen.getByTestId('review-title')
    expect(title).toHaveTextContent('Dark mode toggle')
    // Description has both added (`override`) and removed (`change`)
    const desc = screen.getByTestId('review-description')
    expect(desc.textContent).toContain('Users cannot')
    expect(desc.textContent).toContain('the OS theme.')
    const inserted = screen.getAllByLabelText('inserted')
    const removed = screen.getAllByLabelText('removed')
    expect(inserted.some((el) => el.textContent?.includes('override'))).toBe(true)
    expect(removed.some((el) => el.textContent?.includes('change'))).toBe(true)
  })

  it('renders label set diff with added, removed and unchanged chips in proposed order', () => {
    const baseline: ReviewBaseline = { ...EMPTY_REVIEW_BASELINE, labels: ['ui', 'misc'] }
    const proposed = makeProposed({ labels: ['ui', 'theme', 'settings'] })
    render(<ExploreReviewOverlay baseline={baseline} proposed={proposed} onBack={onBack} onCommit={onCommit} />)
    const labels = screen.getByTestId('review-labels')
    expect(labels).toHaveTextContent('ui')
    expect(labels).toHaveTextContent('theme')
    expect(labels).toHaveTextContent('settings')
    expect(labels).toHaveTextContent('misc') // removed but still present, struck through
    // Order check via testid: scan rendered chips, status is implicit via classes
    const chips = labels.querySelectorAll('span[aria-label]')
    const labelTexts = Array.from(chips).map((c) => c.textContent?.trim().replace(/^[+−]\s*/, ''))
    expect(labelTexts).toEqual(['ui', 'theme', 'settings', 'misc'])
  })

  it('renders criteria bullets in proposed order with removed listed after', () => {
    const baseline: ReviewBaseline = { ...EMPTY_REVIEW_BASELINE, acceptanceCriteria: ['A', 'B'] }
    const proposed = makeProposed({ acceptanceCriteria: ['B', 'C', 'A'] })
    render(<ExploreReviewOverlay baseline={baseline} proposed={proposed} onBack={onBack} onCommit={onCommit} />)
    const criteria = screen.getByTestId('review-criteria')
    const bullets = Array.from(criteria.querySelectorAll('li')).map((li) =>
      li.textContent?.replace(/^[+−]\s*/, '').trim(),
    )
    expect(bullets).toEqual(['B', 'C', 'A']) // removed: [] (A was unchanged)
  })

  it('renders priority as `from → to` pill pair when changed', () => {
    const baseline: ReviewBaseline = { ...EMPTY_REVIEW_BASELINE, priority: 'medium' }
    const proposed = makeProposed({ priority: 'high' })
    render(<ExploreReviewOverlay baseline={baseline} proposed={proposed} onBack={onBack} onCommit={onCommit} />)
    const priority = screen.getByTestId('review-priority')
    expect(priority).toHaveTextContent('medium')
    expect(priority).toHaveTextContent('high')
    expect(priority.querySelector('[aria-label="removed"]')).not.toBeNull()
    expect(priority.querySelector('[aria-label="added"]')).not.toBeNull()
  })

  it('renders priority as single pill when unchanged', () => {
    const baseline: ReviewBaseline = { ...EMPTY_REVIEW_BASELINE, priority: 'medium' }
    const proposed = makeProposed({ priority: 'medium' })
    render(<ExploreReviewOverlay baseline={baseline} proposed={proposed} onBack={onBack} onCommit={onCommit} />)
    const priority = screen.getByTestId('review-priority')
    expect(priority).toHaveTextContent('medium')
    expect(priority.querySelector('[aria-label="removed"]')).toBeNull()
    expect(priority.querySelector('[aria-label="added"]')).toBeNull()
  })

  it('Back-to-edit click fires onBack', () => {
    render(
      <ExploreReviewOverlay
        baseline={EMPTY_REVIEW_BASELINE}
        proposed={makeProposed()}
        onBack={onBack}
        onCommit={onCommit}
      />,
    )
    fireEvent.click(screen.getByTestId('review-back'))
    expect(onBack).toHaveBeenCalledTimes(1)
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('Create-Spec click fires onCommit', () => {
    render(
      <ExploreReviewOverlay
        baseline={EMPTY_REVIEW_BASELINE}
        proposed={makeProposed()}
        onBack={onBack}
        onCommit={onCommit}
      />,
    )
    fireEvent.click(screen.getByTestId('review-commit'))
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(onBack).not.toHaveBeenCalled()
  })

  it('Esc key fires onBack', () => {
    render(
      <ExploreReviewOverlay
        baseline={EMPTY_REVIEW_BASELINE}
        proposed={makeProposed()}
        onBack={onBack}
        onCommit={onCommit}
      />,
    )
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onBack).toHaveBeenCalledTimes(1)
  })

  it('disables Create Spec when title is empty', () => {
    render(
      <ExploreReviewOverlay
        baseline={EMPTY_REVIEW_BASELINE}
        proposed={makeProposed({ title: '   ' })}
        onBack={onBack}
        onCommit={onCommit}
      />,
    )
    const commitBtn = screen.getByTestId('review-commit') as HTMLButtonElement
    expect(commitBtn.disabled).toBe(true)
  })

  it('renders Update Spec label when mode is edit', () => {
    render(
      <ExploreReviewOverlay
        baseline={EMPTY_REVIEW_BASELINE}
        proposed={makeProposed()}
        mode="edit"
        onBack={onBack}
        onCommit={onCommit}
      />,
    )
    expect(screen.getByTestId('review-commit')).toHaveTextContent('Update Spec')
    expect(screen.getByTestId('review-commit')).not.toHaveTextContent('Create Spec')
  })

  it('renders Create Spec label by default (mode unset)', () => {
    render(
      <ExploreReviewOverlay
        baseline={EMPTY_REVIEW_BASELINE}
        proposed={makeProposed()}
        onBack={onBack}
        onCommit={onCommit}
      />,
    )
    expect(screen.getByTestId('review-commit')).toHaveTextContent('Create Spec')
  })

  it('disables both actions while isCommitting', () => {
    render(
      <ExploreReviewOverlay
        baseline={EMPTY_REVIEW_BASELINE}
        proposed={makeProposed()}
        isCommitting
        onBack={onBack}
        onCommit={onCommit}
      />,
    )
    expect((screen.getByTestId('review-back') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId('review-commit') as HTMLButtonElement).disabled).toBe(true)
  })
})
