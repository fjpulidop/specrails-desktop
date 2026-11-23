import { fireEvent, render, screen, waitFor } from '../../../../test-utils'
import { beforeEach, expect, it, vi } from 'vitest'
import { boundSideThread, MissionAskDialog, type MissionAskTarget } from '../MissionAskDialog'
import { askAboutSelection } from '../../lib/agent-api'

vi.mock('../../lib/agent-api', () => ({ askAboutSelection: vi.fn() }))

const target: MissionAskTarget = { conversationId: 'mission-1', selection: 'retry budget', throughMessageId: 'm2', modelLabel: 'opus' }

beforeEach(() => { vi.clearAllMocks() })

function ask(question: string) {
  const input = screen.getByRole('textbox', { name: 'Question about the selected text' })
  fireEvent.change(input, { target: { value: question } })
  fireEvent.keyDown(input, { key: 'Enter' })
}

it('[spec:mission-ask-about-this] sends the question, then keeps the side thread for a follow-up', async () => {
  vi.mocked(askAboutSelection)
    .mockResolvedValueOnce({ answer: 'First answer', provider: 'claude', model: 'claude-sonnet' })
    .mockResolvedValueOnce({ answer: 'Second answer', provider: 'claude', model: 'claude-sonnet' })
  render(<MissionAskDialog target={target} onClose={vi.fn()} />)
  expect(screen.getByText('Runs on opus · closing discards this conversation')).toBeInTheDocument()
  ask('What is it?')
  await screen.findByText('First answer')
  expect(screen.getByText('Answered with claude-sonnet · closing discards this conversation')).toBeInTheDocument()
  ask('Why here?')
  await screen.findByText('Second answer')
  expect(vi.mocked(askAboutSelection).mock.calls[0][1]).toMatchObject({ selection: 'retry budget', throughMessageId: 'm2', question: 'What is it?', thread: [] })
  expect(vi.mocked(askAboutSelection).mock.calls[1][1]).toMatchObject({
    question: 'Why here?',
    thread: [{ role: 'user', content: 'What is it?' }, { role: 'assistant', content: 'First answer' }],
  })
})

it('[spec:mission-ask-about-this] an empty question asks for the default explanation; Shift+Enter does not send', async () => {
  vi.mocked(askAboutSelection).mockResolvedValue({ answer: 'Explained', provider: 'claude', model: 'opus' })
  render(<MissionAskDialog target={target} onClose={vi.fn()} />)
  const input = screen.getByRole('textbox', { name: 'Question about the selected text' })
  fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
  expect(askAboutSelection).not.toHaveBeenCalled()
  fireEvent.keyDown(input, { key: 'Enter' })
  await screen.findByText('Explained')
  expect(vi.mocked(askAboutSelection).mock.calls[0][1].question).toBe('Explain what this means in this context.')
})

it('[spec:mission-ask-about-this] shows the running state, then the provider error with a retry that resends the same question', async () => {
  let fail!: (error: Error) => void
  vi.mocked(askAboutSelection)
    .mockImplementationOnce(() => new Promise((_, reject) => { fail = reject }))
    .mockResolvedValueOnce({ answer: 'Recovered', provider: 'claude', model: 'opus' })
  render(<MissionAskDialog target={target} onClose={vi.fn()} />)
  ask('What is it?')
  expect(await screen.findByText('Thinking…')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Ask' })).toBeDisabled()
  fail(new Error('You have hit your usage limit'))
  expect(await screen.findByRole('alert')).toHaveTextContent('You have hit your usage limit')
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await screen.findByText('Recovered')
  expect(vi.mocked(askAboutSelection).mock.calls[1][1]).toMatchObject({ question: 'What is it?', thread: [] })
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})

it('[spec:mission-ask-about-this] closing discards the side thread and aborts an in-flight question', async () => {
  let signal: AbortSignal | undefined
  vi.mocked(askAboutSelection).mockImplementation((_id, _body, s) => { signal = s; return new Promise(() => {}) })
  const onClose = vi.fn()
  const { rerender } = render(<MissionAskDialog target={target} onClose={onClose} />)
  ask('What is it?')
  await waitFor(() => expect(signal).toBeDefined())
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
  expect(onClose).toHaveBeenCalled()
  rerender(<MissionAskDialog target={null} onClose={onClose} />)
  await waitFor(() => expect(signal?.aborted).toBe(true))
  rerender(<MissionAskDialog target={target} onClose={onClose} />)
  expect(screen.queryByText('What is it?')).not.toBeInTheDocument()
})

it('collapses a long selection behind Show all', () => {
  render(<MissionAskDialog target={{ ...target, selection: 'x'.repeat(400) }} onClose={vi.fn()} />)
  const toggle = screen.getByRole('button', { name: 'Show all' })
  expect(toggle).toHaveAttribute('aria-expanded', 'false')
  fireEvent.click(toggle)
  expect(screen.getByRole('button', { name: 'Show less' })).toHaveAttribute('aria-expanded', 'true')
})

it('bounds the side thread to the newest whole pairs', () => {
  const pair = (n: number) => [{ role: 'user' as const, content: `q${n}` }, { role: 'assistant' as const, content: `a${n}` }]
  const thread = Array.from({ length: 7 }, (_, n) => pair(n)).flat()
  const bounded = boundSideThread(thread)
  expect(bounded).toHaveLength(10)
  expect(bounded[0].content).toBe('q2')
  expect(boundSideThread([...pair(0), { role: 'user', content: 'x'.repeat(9000) }, { role: 'assistant', content: 'y'.repeat(8000) }])).toHaveLength(0)
})
