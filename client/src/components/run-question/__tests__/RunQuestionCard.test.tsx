import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'

const h = vi.hoisted(() => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }))
vi.mock('sonner', () => ({ toast: h.toast }))

import { RunQuestionCard } from '../RunQuestionCard'
import { onRunQuestionAnswered, plainRunQuestion, readRunQuestion, runQuestionSettledBy, submitRunAnswer, type RunQuestion } from '../run-question'

const planner: RunQuestion = {
  interruptId: 'q1', kind: 'question', asker: 'planner', text: 'Should scores be stored per device or synced?',
  why: 'The ticket does not say.', options: [
    { id: 'device', label: 'Per device', meaning: 'Saved in the browser; nothing to set up.' },
    { id: 'synced', label: 'Synced', meaning: 'Needs an account and a server.' },
    { id: 'not-here', label: "Don't do it here", meaning: 'The run ends without changes.' },
  ], recommended: 'device', endsRun: ['not-here'], mayEndRun: true, canReject: false,
}

let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
  fetchMock = vi.fn(async () => new Response('{}', { status: 202 }))
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => { vi.unstubAllGlobals(); h.toast.success.mockReset() })

const bodyOf = (call: unknown[]): unknown => JSON.parse(String((call[1] as RequestInit).body))

describe('RunQuestionCard', () => {
  it('says who asks in plain words, the full question, each choice with its meaning, the recommended one and the consequence', () => {
    render(<RunQuestionCard question={planner} projectId="p1" runId="run-1" runLabel="Implement #12" projectName="Alpha" />)
    const card = screen.getByTestId('run-question-card')
    expect(within(card).getByRole('heading')).toHaveTextContent('The planner needs a decision')
    expect(screen.getByTestId('run-question-where')).toHaveTextContent('Implement #12 · Alpha')
    expect(screen.getByTestId('run-question-text')).toHaveTextContent(planner.text)
    const options = screen.getAllByTestId('run-question-option')
    expect(options.map((o) => o.getAttribute('data-option-id'))).toEqual(['device', 'synced', 'not-here'])
    expect(options[0]).toHaveTextContent('Recommended')
    expect(options[1]).toHaveTextContent('Needs an account and a server.')
    const consequence = screen.getByTestId('run-question-consequence')
    expect(consequence).toHaveTextContent('The run waits, at no cost, until you answer.')
    expect(consequence).toHaveTextContent('Choosing “Don\'t do it here” ends the run.')
    // No node ids or paths anywhere in the card.
    expect(card.textContent).not.toMatch(/clarify|architect|nodePath|q1/)
  })

  it('answers by choice inline, confirms in place and tells every other surface of the window', async () => {
    const answered = vi.fn()
    const stop = onRunQuestionAnswered(answered)
    render(<RunQuestionCard question={planner} projectId="p1" runId="run-1" />)
    fireEvent.click(screen.getAllByTestId('run-question-option')[0])
    await screen.findByTestId('run-question-sent')
    expect(screen.getByTestId('run-question-sent')).toHaveTextContent('Answer sent — the run continues.')
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/api\/projects\/p1\/jobs\/run-1\/messages$/)
    expect(bodyOf(fetchMock.mock.calls[0])).toEqual({ text: 'Per device', interruptId: 'q1', optionId: 'device' })
    expect(answered).toHaveBeenCalledWith({ projectId: 'p1', runId: 'run-1' })
    expect(h.toast.success).toHaveBeenCalledWith('Answer sent — the run continues.')
    stop()
  })

  it('a choice that ends the run says so when it is sent', async () => {
    render(<RunQuestionCard question={planner} projectId="p1" runId="run-1" />)
    fireEvent.click(screen.getAllByTestId('run-question-option')[2])
    expect(await screen.findByTestId('run-question-sent')).toHaveTextContent('Answer sent — the run ends.')
  })

  it('takes another answer as free text', async () => {
    render(<RunQuestionCard question={planner} projectId="p1" runId="run-1" />)
    fireEvent.click(screen.getByTestId('run-question-other'))
    fireEvent.change(screen.getByTestId('run-question-input'), { target: { value: 'Both, device first' } })
    fireEvent.click(screen.getByTestId('run-question-send'))
    await screen.findByTestId('run-question-sent')
    expect(bodyOf(fetchMock.mock.calls[0])).toEqual({ text: 'Both, device first', interruptId: 'q1' })
  })

  it('renders an older Core\'s plain-text question with a text box only', async () => {
    render(<RunQuestionCard question={plainRunQuestion('Which store?', 'q9')} projectId="p1" runId="run-1" />)
    expect(screen.getByRole('heading')).toHaveTextContent('The run needs your answer')
    expect(screen.queryByTestId('run-question-option')).toBeNull()
    fireEvent.change(screen.getByTestId('run-question-input'), { target: { value: 'SQLite' } })
    fireEvent.click(screen.getByTestId('run-question-send'))
    await screen.findByTestId('run-question-sent')
    expect(bodyOf(fetchMock.mock.calls[0])).toEqual({ text: 'SQLite', interruptId: 'q9' })
  })

  it('an approval offers Approve and, when Core allows it, Reject with a reason and says what rejecting does', async () => {
    const approval: RunQuestion = { interruptId: 'a1', kind: 'approval', asker: 'run', text: 'Approve archiving the reviewed change?', options: [], endsRun: [], mayEndRun: true, canReject: true }
    render(<RunQuestionCard question={approval} projectId="p1" runId="run-1" />)
    expect(screen.getByRole('heading')).toHaveTextContent('The run needs your approval')
    expect(screen.getByTestId('run-question-consequence')).toHaveTextContent('Rejecting ends the run. Nothing is archived or merged.')
    fireEvent.click(screen.getByTestId('run-question-reject'))
    expect(screen.getByTestId('run-question-send')).toBeDisabled()
    fireEvent.change(screen.getByTestId('run-question-input'), { target: { value: 'The colours are wrong' } })
    fireEvent.click(screen.getByTestId('run-question-send'))
    await screen.findByTestId('run-question-sent')
    expect(screen.getByTestId('run-question-sent')).toHaveTextContent('Rejected — the run ends.')
    expect(bodyOf(fetchMock.mock.calls[0])).toEqual({ text: 'The colours are wrong', interruptId: 'a1', reject: true })
  })

  it('an approval from an older Core offers Approve only', async () => {
    render(<RunQuestionCard question={{ ...plainRunQuestion('Approve?', 'a1', 'approval') }} projectId="p1" runId="run-1" />)
    expect(screen.queryByTestId('run-question-reject')).toBeNull()
    fireEvent.click(screen.getByTestId('run-question-approve'))
    await screen.findByTestId('run-question-sent')
    expect(bodyOf(fetchMock.mock.calls[0])).toEqual({ text: '', interruptId: 'a1', approve: true })
  })

  it('asks a machine-wide install in the person\'s words with the exact command, and answers by option id', async () => {
    const install: RunQuestion = { interruptId: 'i4', kind: 'question', asker: 'install', text: 'This run needs terraform. Install it with `brew install terraform`?', detail: 'brew install terraform',
      options: [{ id: 'install', label: 'Install', meaning: 'Core English meaning' }, { id: 'self', label: "I'll do it myself", meaning: 'Core English meaning' }],
      endsRun: ['self'], mayEndRun: true, canReject: false, install: { tool: 'terraform', command: 'brew install terraform' } }
    render(<RunQuestionCard question={install} projectId="p1" runId="run-1" />)
    expect(screen.getByRole('heading')).toHaveTextContent('Specrails needs your permission')
    expect(screen.getByTestId('run-question-text')).toHaveTextContent('This run needs terraform. Install it with this command?')
    expect(screen.getByTestId('run-question-detail')).toHaveTextContent('brew install terraform')
    expect(screen.getAllByTestId('run-question-option')[0]).toHaveTextContent('outside the run, and the run continues by itself')
    expect(screen.getByTestId('run-question-consequence')).toHaveTextContent("won't ask again for this command")
    expect(screen.getByTestId('run-question-consequence')).toHaveTextContent('Choosing “I\'ll do it myself” ends the run.')
    expect(screen.queryByTestId('run-question-other')).toBeNull()
    expect(screen.queryByText('Core English meaning')).toBeNull()
    fireEvent.click(screen.getAllByTestId('run-question-option')[0])
    await screen.findByTestId('run-question-sent')
    expect(bodyOf(fetchMock.mock.calls[0])).toEqual({ text: 'Install', interruptId: 'i4', optionId: 'install' })
  })

  it('renders the same card in a list row and in the run window', () => {
    const { container: compact } = render(<RunQuestionCard question={planner} projectId="p1" runId="run-1" density="compact" />)
    const { container: full } = render(<RunQuestionCard question={planner} projectId="p1" runId="run-1" />)
    const words = (root: HTMLElement) => root.textContent
    expect(words(compact)).toBe(words(full))
  })
})

describe('submitRunAnswer', () => {
  it('resumes a run retained across a restart with the same controls when its turn door is closed', async () => {
    fetchMock.mockImplementationOnce(async () => new Response('{}', { status: 409 }))
    await submitRunAnswer({ projectId: 'p1', runId: 'run-1', question: planner, answer: { type: 'option', optionId: 'synced', label: 'Synced' } })
    expect(String(fetchMock.mock.calls[1][0])).toMatch(/\/loop-runs\/run-1\/resume$/)
    expect(bodyOf(fetchMock.mock.calls[1])).toEqual({ answer: 'Synced', interruptId: 'q1', optionId: 'synced' })
  })

  it('surfaces the server\'s reason when the answer is refused', async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ error: 'invalid_resume_controls', detail: 'Interrupt is no longer pending' }), { status: 400 }))
    await expect(submitRunAnswer({ projectId: 'p1', runId: 'run-1', question: planner, answer: { type: 'text', text: 'x' } })).rejects.toThrow('Interrupt is no longer pending')
  })
})

describe('reading the wire card', () => {
  it('drops malformed choices and unknown askers', () => {
    expect(readRunQuestion({ interruptId: 'q', kind: 'question', asker: 'wizard', text: 'Q?', options: [{ id: 'ok', label: 'OK' }, { id: 'Bad Id', label: 'x' }], recommended: 'nope', endsRun: ['ok', 'gone'] }))
      .toEqual({ interruptId: 'q', kind: 'question', asker: 'run', text: 'Q?', options: [{ id: 'ok', label: 'OK' }], endsRun: ['ok'], mayEndRun: false, canReject: false })
    expect(readRunQuestion({ kind: 'question', text: 'no id' })).toBeNull()
  })

  it('knows which server events end a question (instant update in other windows)', () => {
    expect(runQuestionSettledBy({ type: 'job.interactive', projectId: 'p1', jobId: 'r', question: null })).toEqual({ projectId: 'p1', runId: 'r' })
    expect(runQuestionSettledBy({ type: 'job.interactive', projectId: 'p1', jobId: 'r', question: { text: 'x' } })).toBeNull()
    expect(runQuestionSettledBy({ type: 'loop.run_resumed', projectId: 'p1', loopRunId: 'r' })).toEqual({ projectId: 'p1', runId: 'r' })
    expect(runQuestionSettledBy({ type: 'loop.run_paused', projectId: 'p1', loopRunId: 'r' })).toBeNull()
  })
})

