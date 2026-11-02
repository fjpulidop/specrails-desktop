import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { AgentIntentDraftCard } from '../AgentIntentDraftCard'
import { latestSettledIntentMessageId, extractAgentIntentDraft } from '../agent-intent-draft'
import { MissionExtensionsProvider, type MissionIntentExploreProps } from '../../context/MissionExtensionsContext'
import { parseIntentDraft } from '../../../specs/lib/spec-intent'
import { __clearComposerDrafts, composerDrafts } from '../../lib/agent-composer-drafts'

const PAYLOAD = {
  title: 'Findable settings',
  problem: 'People cannot find a setting they changed last week.',
  outcome: 'Any setting is reachable in two keystrokes.',
  hypothesis: 'We believe palette search will cut lookups; we will know when lookups take under 5 s.',
  successSignals: ['Lookups under 5 s'],
  affects: ['Every user'],
  constraints: ['No new settings page'],
  openQuestions: ['Should project settings be included?'],
  readings: { restated: 'Search settings from the palette', alternative: 'Regroup the settings page', discriminator: 'Do you search or scan?' },
}
const fence = (payload: unknown) => '```intent-draft\n' + JSON.stringify(payload) + '\n```'
const draft = (overrides: Record<string, unknown> = {}) => parseIntentDraft({ ...PAYLOAD, ...overrides })!

type ExploreStubProps = MissionIntentExploreProps & { onEntryOpenChange?: (open: boolean) => void }

describe('extractAgentIntentDraft', () => {
  it('strips the block, keeps the prose and returns the last valid snapshot', () => {
    const parsed = extractAgentIntentDraft(`Here is my reading.\n\n${fence(PAYLOAD)}\n\n${fence({ ...PAYLOAD, outcome: 'Second' })}`)
    expect(parsed.body).toBe('Here is my reading.')
    expect(parsed.draft?.intent.outcome).toBe('Second')
    expect(parsed.pending).toBe(false)
  })

  it('drops malformed blocks, parses a whole unclosed tail and cuts an incomplete one while streaming', () => {
    expect(extractAgentIntentDraft('a\n```intent-draft\n{oops}\n```').draft).toBeNull()
    expect(extractAgentIntentDraft('a\n```intent-draft\n{oops}\n```').body).toBe('a')
    expect(extractAgentIntentDraft('x\n```intent-draft\n' + JSON.stringify(PAYLOAD)).draft?.title).toBe('Findable settings')
    const streaming = extractAgentIntentDraft('x\n```intent-draft\n{"problem": "P', true)
    expect(streaming).toEqual({ body: 'x', draft: null, pending: true })
    expect(extractAgentIntentDraft('no protocol here')).toEqual({ body: 'no protocol here', draft: null, pending: false })
  })
})

describe('AgentIntentDraftCard', () => {
  beforeEach(() => __clearComposerDrafts())

  it('renders the title, every intent section and the two readings with the question', () => {
    render(<AgentIntentDraftCard draft={draft()} isLatest onSelect={vi.fn()} />)
    const card = screen.getByTestId('agent-intent-draft-card')
    expect(screen.getByTestId('agent-intent-draft-title')).toHaveTextContent('Findable settings')
    expect(within(card).getByText(PAYLOAD.problem)).toBeTruthy()
    expect(within(card).getByText(PAYLOAD.outcome)).toBeTruthy()
    expect(within(card).getByText(PAYLOAD.hypothesis)).toBeTruthy()
    expect(within(screen.getByTestId('agent-intent-draft-constraints')).getByText('No new settings page')).toBeTruthy()
    const questions = screen.getByTestId('agent-intent-draft-questions')
    expect(questions).toHaveTextContent('Open questions · 1')
    expect(within(questions).getByText('Should project settings be included?')).toBeTruthy()
    expect(within(questions).getByText('Open')).toBeTruthy()
    expect(within(card).getByText('Do you search or scan?')).toBeTruthy()
    // Not settled: an amber "N open" pill, no paths, no collapse toggle for short content.
    expect(screen.getByTestId('agent-intent-draft-state')).toHaveTextContent('1 open')
    expect(screen.queryByTestId('agent-intent-draft-paths')).toBeNull()
    expect(screen.queryByTestId('agent-intent-draft-expand')).toBeNull()
  })

  it('sends a picked reading only from the newest card and never mid-turn, describing what a pick does', () => {
    const onSelect = vi.fn()
    const { rerender } = render(<AgentIntentDraftCard draft={draft()} isLatest onSelect={onSelect} />)
    const alternative = screen.getByTestId('agent-intent-draft-reading-alternative')
    expect(document.getElementById(alternative.getAttribute('aria-describedby')!)).toHaveTextContent('Sends this reading as your reply')
    expect(alternative).not.toHaveAttribute('title')
    fireEvent.click(alternative)
    expect(onSelect).toHaveBeenCalledWith('Regroup the settings page')
    rerender(<AgentIntentDraftCard draft={draft()} isLatest isStreaming onSelect={onSelect} />)
    expect(screen.getByTestId('agent-intent-draft-reading-restated')).toHaveProperty('disabled', true)
    rerender(<AgentIntentDraftCard draft={draft()} isLatest={false} onSelect={onSelect} />)
    expect(screen.getByTestId('agent-intent-draft-reading-restated').tagName).toBe('DIV')
    // An older card asks its question quietly: no accent on the discriminator.
    expect(screen.getByTestId('agent-intent-draft-discriminator').className).toContain('border-border/40')
    expect(screen.getByTestId('agent-intent-draft-discriminator').className).not.toContain('accent-primary')
  })

  it('open questions on the newest card seed the composer with the question; answered ones show their answer', () => {
    const onSelect = vi.fn()
    const { rerender, unmount } = render(<AgentIntentDraftCard draft={draft()} isLatest conversationId="c1" onSelect={onSelect} />)
    const question = screen.getByTestId('agent-intent-draft-question')
    expect(question.tagName).toBe('BUTTON')
    expect(document.getElementById(question.getAttribute('aria-describedby')!)).toHaveTextContent('Reply in the chat to answer; the agent updates this card.')
    fireEvent.click(question)
    expect(composerDrafts.get('c1')).toBe('Should project settings be included? — ')
    expect(onSelect).not.toHaveBeenCalled()

    // Without a conversation to seed, the question goes out as the reply.
    rerender(<AgentIntentDraftCard draft={draft()} isLatest onSelect={onSelect} />)
    fireEvent.click(screen.getByTestId('agent-intent-draft-question'))
    expect(onSelect).toHaveBeenCalledWith('Should project settings be included? — ')

    // Older cards keep their questions as text.
    rerender(<AgentIntentDraftCard draft={draft()} isLatest={false} conversationId="c1" onSelect={onSelect} />)
    expect(screen.getByTestId('agent-intent-draft-question').tagName).toBe('LI')
    expect(screen.queryByText('Reply in the chat to answer; the agent updates this card.')).toBeNull()
    unmount()

    render(<AgentIntentDraftCard draft={draft({ openQuestions: [{ question: 'Which locale first?', answer: 'Spanish' }] })} isLatest conversationId="c1" onSelect={onSelect} />)
    const answered = screen.getByTestId('agent-intent-draft-question')
    expect(answered.tagName).toBe('LI')
    expect(answered).toHaveTextContent('Answer')
    expect(answered).toHaveTextContent('Spanish')
    expect(within(answered).queryByText('Open')).toBeNull()
    expect(screen.getByTestId('agent-intent-draft-questions')).toHaveTextContent(/^Open questions/)
    expect(screen.queryByTestId('agent-intent-draft-state')).toBeNull()
  })

  it('a settled card folds the readings into one confirmed line and wears the Agreed pill', () => {
    render(<AgentIntentDraftCard draft={draft({ ready: true })} isLatest onSelect={vi.fn()} />)
    expect(screen.getByTestId('agent-intent-draft-state')).toHaveTextContent('Agreed')
    expect(screen.getByTestId('agent-intent-draft-reading-confirmed')).toHaveTextContent('Reading confirmed: Search settings from the palette')
    expect(screen.queryByTestId('agent-intent-draft-reading-restated')).toBeNull()
    expect(screen.queryByTestId('agent-intent-draft-reading-alternative')).toBeNull()
    expect(screen.queryByTestId('agent-intent-draft-discriminator')).toBeNull()
    expect(screen.queryByText('Do you search or scan?')).toBeNull()
    // Settled questions are no longer answer buttons.
    expect(screen.getByTestId('agent-intent-draft-question').tagName).toBe('LI')
  })

  it('a settled intent offers Delegate, and Explore only when an extension provides it', () => {
    const onSelect = vi.fn()
    const { unmount } = render(<AgentIntentDraftCard draft={draft({ ready: true })} isLatest conversationId="c1" projectId="p1" onSelect={onSelect} />)
    expect(screen.queryByTestId('intent-explore-stub')).toBeNull()
    fireEvent.click(screen.getByTestId('agent-intent-draft-delegate'))
    expect(onSelect).toHaveBeenCalledWith('Write the spec from this intent for me to review.')
    unmount()

    const seen: ExploreStubProps[] = []
    const Explore = (props: ExploreStubProps) => { seen.push(props); return <button data-testid="intent-explore-stub">Explore</button> }
    render(
      <MissionExtensionsProvider value={{ IntentExplore: Explore }}>
        <AgentIntentDraftCard draft={draft({ ready: true })} isLatest conversationId="c1" projectId="p1" onSelect={onSelect} />
      </MissionExtensionsProvider>,
    )
    expect(screen.getByTestId('intent-explore-stub')).toBeTruthy()
    expect(seen.at(-1)).toMatchObject({ conversationId: 'c1', projectId: 'p1', title: 'Findable settings', disabled: false, intent: { problem: PAYLOAD.problem } })
    expect(typeof seen.at(-1)?.onEntryOpenChange).toBe('function')
  })

  it('hides Delegate while the Explore entry card is open', () => {
    const Explore = ({ onEntryOpenChange }: ExploreStubProps) => (
      <button data-testid="intent-explore-stub" onClick={() => onEntryOpenChange?.(true)}>Explore</button>
    )
    render(
      <MissionExtensionsProvider value={{ IntentExplore: Explore }}>
        <AgentIntentDraftCard draft={draft({ ready: true })} isLatest conversationId="c1" projectId="p1" onSelect={vi.fn()} />
      </MissionExtensionsProvider>,
    )
    expect(screen.getByTestId('agent-intent-draft-delegate')).toBeTruthy()
    fireEvent.click(screen.getByTestId('intent-explore-stub'))
    expect(screen.queryByTestId('agent-intent-draft-delegate')).toBeNull()
    expect(screen.getByTestId('intent-explore-stub')).toBeTruthy()
  })

  it('keeps the paths on the latest settled intent even after later messages, and drops them from older ones', () => {
    const { rerender } = render(<AgentIntentDraftCard draft={draft({ ready: true })} isLatest={false} conversationId="c1" onSelect={vi.fn()} />)
    expect(screen.queryByTestId('agent-intent-draft-paths')).toBeNull()
    rerender(<AgentIntentDraftCard draft={draft({ ready: true })} isLatest={false} isLatestSettledIntent conversationId="c1" onSelect={vi.fn()} />)
    expect(screen.getByTestId('agent-intent-draft-paths')).toBeTruthy()
    rerender(<AgentIntentDraftCard draft={draft({ ready: true })} isLatest isLatestSettledIntent={false} conversationId="c1" onSelect={vi.fn()} />)
    expect(screen.queryByTestId('agent-intent-draft-paths')).toBeNull()
  })

  it('says why the paths wait while a turn streams, without dimming them', () => {
    render(<AgentIntentDraftCard draft={draft({ ready: true })} isLatest isStreaming conversationId="c1" onSelect={vi.fn()} />)
    const delegate = screen.getByTestId('agent-intent-draft-delegate')
    expect(delegate).toHaveProperty('disabled', true)
    expect(delegate.className).toContain('text-muted-foreground')
    expect(delegate.className).not.toContain('opacity-60')
    expect(screen.getByTestId('agent-intent-draft-wait')).toHaveTextContent('You can choose once the agent finishes this reply.')
  })

  it('collapses long lists to three items with "+N more" and a toggle that shows the full intent', () => {
    const constraints = ['One', 'Two', 'Three', 'Four', 'Five']
    render(<AgentIntentDraftCard draft={draft({ constraints })} isLatest onSelect={vi.fn()} />)
    const list = screen.getByTestId('agent-intent-draft-constraints')
    expect(within(list).queryByText('Four')).toBeNull()
    expect(screen.getByTestId('agent-intent-draft-more')).toHaveTextContent('+2 more')
    expect(screen.getByTestId('agent-intent-draft-content').className).toContain('max-h-56')
    const toggle = screen.getByTestId('agent-intent-draft-expand')
    expect(toggle).toHaveTextContent('Show the full intent')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(toggle)
    expect(within(list).getByText('Four')).toBeTruthy()
    expect(within(list).getByText('Five')).toBeTruthy()
    expect(screen.queryByTestId('agent-intent-draft-more')).toBeNull()
    expect(screen.getByTestId('agent-intent-draft-content').className).not.toContain('max-h-56')
    expect(toggle).toHaveTextContent('Collapse')
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(toggle)
    expect(within(list).queryByText('Four')).toBeNull()
  })

  it('"+N more" opens the whole intent', () => {
    render(<AgentIntentDraftCard draft={draft({ affects: ['A', 'B', 'C', 'D'] })} isLatest onSelect={vi.fn()} />)
    fireEvent.click(screen.getByTestId('agent-intent-draft-more'))
    expect(within(screen.getByTestId('agent-intent-draft-affects')).getByText('D')).toBeTruthy()
    expect(screen.getByTestId('agent-intent-draft-expand')).toHaveTextContent('Collapse')
  })
})

describe('latestSettledIntentMessageId', () => {
  const ready = (value: boolean) => fence({ ...PAYLOAD, ready: value })
  it('keeps the newest agreed card across user follow-ups and drops it after an agent reply', () => {
    const agreed = { id: 'a2', role: 'assistant', content: 'Here. ' + ready(true) }
    expect(latestSettledIntentMessageId([{ id: 'u1', role: 'user', content: 'hi' }, agreed])).toBe('a2')
    expect(latestSettledIntentMessageId([agreed, { id: 'u2', role: 'user', content: 'one answer' }])).toBe('a2')
    expect(latestSettledIntentMessageId([agreed, { id: 'a3', role: 'assistant', content: 'Spec written.' }])).toBeNull()
    expect(latestSettledIntentMessageId([{ id: 'a1', role: 'assistant', content: ready(false) }])).toBeNull()
    expect(latestSettledIntentMessageId([])).toBeNull()
  })
})
