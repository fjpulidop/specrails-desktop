import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { IntentSection } from '../IntentSection'
import type { SpecIntent } from '../../lib/spec-intent'

const INTENT: SpecIntent = {
  problem: 'Reviewers cannot tell why a spec exists.',
  outcome: 'Every spec states the problem it solves.',
  hypothesis: 'We believe a visible why cuts review time; we will know when reviews take under 5 minutes.',
  successSignals: ['Reviews under 5 minutes'],
  affects: ['Reviewers'],
  constraints: ['No Jira field changes'],
  openQuestions: [{ question: 'Should drafts require it?' }, { question: 'Who owns it?', answer: 'The spec author.' }],
}

describe('IntentSection', () => {
  it('shows every section, the open-question count and answered questions', () => {
    render(<IntentSection value={INTENT} onChange={vi.fn()} />)
    const section = screen.getByTestId('ticket-intent')
    expect(within(section).getByText(INTENT.problem)).toBeTruthy()
    expect(within(section).getByText(INTENT.outcome)).toBeTruthy()
    expect(within(section).getByText(INTENT.hypothesis!)).toBeTruthy()
    expect(within(screen.getByTestId('ticket-intent-signals')).getByText('Reviews under 5 minutes')).toBeTruthy()
    expect(within(screen.getByTestId('ticket-intent-constraints')).getByText('No Jira field changes')).toBeTruthy()
    expect(screen.getByTestId('ticket-intent-open').textContent).toBe('1 open question')
    const questions = screen.getByTestId('ticket-intent-questions')
    expect(within(questions).getByText('The spec author.')).toBeTruthy()
    expect(within(questions).getByText('Open')).toBeTruthy()
  })

  it('edits sections and reports a normalized intent', () => {
    const onChange = vi.fn()
    render(<IntentSection value={INTENT} onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: /edit/i }))
    fireEvent.change(screen.getByLabelText('Outcome sought'), { target: { value: 'Specs state their why.' } })
    fireEvent.change(screen.getByLabelText(/How we will know/), { target: { value: '- Reviews under 5 minutes\nReviews under 5 minutes\nFewer review rounds' } })
    fireEvent.change(screen.getByLabelText('Answer to open question 1'), { target: { value: 'Yes, from the board.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Done editing' }))
    expect(onChange).toHaveBeenCalledWith({
      ...INTENT,
      outcome: 'Specs state their why.',
      successSignals: ['Reviews under 5 minutes', 'Fewer review rounds'],
      openQuestions: [{ question: 'Should drafts require it?', answer: 'Yes, from the board.' }, INTENT.openQuestions[1]],
    })
  })

  it('requires problem and outcome before saving a partial intent', () => {
    const onChange = vi.fn()
    render(<IntentSection value={null} onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: /Add the intent/ }))
    fireEvent.change(screen.getByLabelText('Problem'), { target: { value: 'Search is slow.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Done editing' }))
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toBe('Required')
    expect(screen.getByLabelText('Outcome sought').getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByLabelText('Outcome sought').getAttribute('aria-describedby')).toBe(screen.getByRole('alert').id)
    fireEvent.change(screen.getByLabelText('Outcome sought'), { target: { value: 'Results in 200 ms.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add open question' }))
    fireEvent.change(screen.getByLabelText('Open question 1'), { target: { value: 'Which index?' } })
    fireEvent.click(screen.getByRole('button', { name: 'Done editing' }))
    expect(onChange).toHaveBeenCalledWith({
      problem: 'Search is slow.', outcome: 'Results in 200 ms.', successSignals: [], affects: [], constraints: [], openQuestions: [{ question: 'Which index?' }],
    })
  })

  it('clears the intent when every section is emptied, and Cancel keeps the original', () => {
    const onChange = vi.fn()
    const { rerender } = render(<IntentSection value={INTENT} onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: /edit/i }))
    fireEvent.change(screen.getByLabelText('Problem'), { target: { value: 'Changed' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByText(INTENT.problem)).toBeTruthy()

    const minimal: SpecIntent = { problem: 'P', outcome: 'O', successSignals: [], affects: [], constraints: [], openQuestions: [] }
    rerender(<IntentSection value={minimal} onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: /edit/i }))
    fireEvent.change(screen.getByLabelText('Problem'), { target: { value: '' } })
    fireEvent.change(screen.getByLabelText('Outcome sought'), { target: { value: ' ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Done editing' }))
    expect(onChange).toHaveBeenCalledWith(null)
  })
  it('Escape keeps the edit (validated) instead of discarding it', () => {
    const onChange = vi.fn()
    render(<IntentSection value={INTENT} onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: /edit/i }))
    fireEvent.change(screen.getByLabelText('Problem'), { target: { value: 'Edited problem' } })
    fireEvent.keyDown(screen.getByLabelText('Problem'), { key: 'Escape' })
    expect(onChange).toHaveBeenCalledWith({ ...INTENT, problem: 'Edited problem' })
  })
})
