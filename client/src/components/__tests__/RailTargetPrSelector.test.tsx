import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { RailTargetPrSelector, type RailTargetPr } from '../RailTargetPrSelector'
import { TargetPrLaunchDialog } from '../TargetPrLaunchDialog'

vi.mock('../../lib/api', () => ({ getApiBase: () => '/api/projects/proj-1' }))

const CANDIDATES = [
  { number: 151, title: 'SKILLS-110 whitelist', headRefName: 'feat/skills', baseRefName: 'develop', url: 'https://github.com/e/r/pull/151', isDraft: true, isCrossRepository: false },
  { number: 9, title: 'From a fork', headRefName: 'fork/x', baseRefName: 'main', url: 'https://github.com/e/r/pull/9', isDraft: false, isCrossRepository: true },
]

beforeEach(() => {
  global.fetch = vi.fn(async () => ({
    ok: true,
    json: async () => ({ candidates: CANDIDATES }),
  })) as unknown as typeof fetch
})

describe('RailTargetPrSelector', () => {
  it('defaults to "New PR" and fetches candidates only on open', async () => {
    render(<RailTargetPrSelector railIndex={0} value={null} onChange={vi.fn()} />)
    expect(screen.getByTestId('rail-target-pr-selector')).toHaveTextContent('New PR')
    expect(global.fetch).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId('rail-target-pr-selector'))
    await waitFor(() => expect(screen.getByText(/#151 · SKILLS-110 whitelist/)).toBeInTheDocument())
    expect(global.fetch).toHaveBeenCalledWith('/api/projects/proj-1/rails/0/pr-candidates')
  })

  it('selecting a candidate reports it and fork candidates are disabled', async () => {
    const onChange = vi.fn()
    render(<RailTargetPrSelector railIndex={0} value={null} onChange={onChange} />)
    fireEvent.click(screen.getByTestId('rail-target-pr-selector'))
    await waitFor(() => screen.getByText(/#151/))

    const fork = screen.getByText(/#9 · From a fork/).closest('button')!
    expect(fork).toBeDisabled()

    fireEvent.click(screen.getByText(/#151 · SKILLS-110 whitelist/))
    expect(onChange).toHaveBeenCalledWith({ number: 151, title: 'SKILLS-110 whitelist', headRefName: 'feat/skills' })
  })

  it('manual entry accepts only positive integers and clear resets to New PR', async () => {
    const onChange = vi.fn()
    const { rerender } = render(<RailTargetPrSelector railIndex={0} value={null} onChange={onChange} />)
    fireEvent.click(screen.getByTestId('rail-target-pr-selector'))
    await waitFor(() => screen.getByPlaceholderText('PR number'))

    const input = screen.getByPlaceholderText('PR number')
    const use = screen.getByText('Use')
    fireEvent.change(input, { target: { value: 'abc' } })
    expect(use).toBeDisabled()
    fireEvent.change(input, { target: { value: '204' } })
    expect(use).not.toBeDisabled()
    fireEvent.click(use)
    expect(onChange).toHaveBeenCalledWith({ number: 204 })

    // Selected chip + clear button
    const value: RailTargetPr = { number: 204 }
    rerender(<RailTargetPrSelector railIndex={0} value={value} onChange={onChange} />)
    expect(screen.getByTestId('rail-target-pr-selector')).toHaveTextContent('#204')
    fireEvent.click(screen.getByLabelText('Clear PR target'))
    expect(onChange).toHaveBeenCalledWith(null)
  })

  it('shows the empty state when there are no open PRs', async () => {
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ candidates: [] }) })) as unknown as typeof fetch
    render(<RailTargetPrSelector railIndex={2} value={null} onChange={vi.fn()} />)
    fireEvent.click(screen.getByTestId('rail-target-pr-selector'))
    await waitFor(() => expect(screen.getByText('No open PRs found')).toBeInTheDocument())
  })
})

describe('TargetPrLaunchDialog', () => {
  it('names the PR number, title, and head branch before launching', () => {
    const onConfirm = vi.fn()
    render(
      <TargetPrLaunchDialog
        open
        target={{ number: 151, title: 'SKILLS-110 whitelist', headRefName: 'feat/skills' }}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />,
    )
    expect(screen.getByText(/#151 · SKILLS-110 whitelist/)).toBeInTheDocument()
    expect(screen.getByText('feat/skills')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Launch into PR #151'))
    expect(onConfirm).toHaveBeenCalled()
  })

  it('renders nothing without a target', () => {
    const { container } = render(
      <TargetPrLaunchDialog open target={null} onConfirm={vi.fn()} onCancel={vi.fn()} />,
    )
    expect(container).toBeEmptyDOMElement()
  })
})
