import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { AgentIntentDraftCard } from '../AgentIntentDraftCard'
import { extractAgentIntentDraft } from '../agent-intent-draft'
import { MissionExtensionsProvider, type MissionIntentExploreProps } from '../../context/MissionExtensionsContext'
import { parseIntentDraft } from '../../../specs/lib/spec-intent'

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
  it('renders every intent section and the two readings with the question', () => {
    render(<AgentIntentDraftCard draft={draft()} isLatest onSelect={vi.fn()} />)
    const card = screen.getByTestId('agent-intent-draft-card')
    expect(within(card).getByText(PAYLOAD.problem)).toBeTruthy()
    expect(within(card).getByText(PAYLOAD.outcome)).toBeTruthy()
    expect(within(card).getByText(PAYLOAD.hypothesis)).toBeTruthy()
    expect(within(screen.getByTestId('agent-intent-draft-constraints')).getByText('No new settings page')).toBeTruthy()
    expect(within(screen.getByTestId('agent-intent-draft-questions')).getByText('Should project settings be included?')).toBeTruthy()
    expect(within(card).getByText('Do you search or scan?')).toBeTruthy()
    expect(screen.queryByTestId('agent-intent-draft-paths')).toBeNull()
  })

  it('sends a picked reading only from the newest card and never mid-turn', () => {
    const onSelect = vi.fn()
    const { rerender } = render(<AgentIntentDraftCard draft={draft()} isLatest onSelect={onSelect} />)
    fireEvent.click(screen.getByTestId('agent-intent-draft-reading-alternative'))
    expect(onSelect).toHaveBeenCalledWith('Regroup the settings page')
    rerender(<AgentIntentDraftCard draft={draft()} isLatest isStreaming onSelect={onSelect} />)
    expect(screen.getByTestId('agent-intent-draft-reading-restated')).toHaveProperty('disabled', true)
    rerender(<AgentIntentDraftCard draft={draft()} isLatest={false} onSelect={onSelect} />)
    expect(screen.getByTestId('agent-intent-draft-reading-restated').tagName).toBe('DIV')
  })

  it('a settled intent offers Delegate, and Explore only when an extension provides it', () => {
    const onSelect = vi.fn()
    const { unmount } = render(<AgentIntentDraftCard draft={draft({ ready: true })} isLatest conversationId="c1" projectId="p1" onSelect={onSelect} />)
    expect(screen.queryByTestId('intent-explore-stub')).toBeNull()
    fireEvent.click(screen.getByTestId('agent-intent-draft-delegate'))
    expect(onSelect).toHaveBeenCalledWith('Delegate: write the spec from this intent.')
    unmount()

    const seen: MissionIntentExploreProps[] = []
    const Explore = (props: MissionIntentExploreProps) => { seen.push(props); return <button data-testid="intent-explore-stub">Explore</button> }
    render(
      <MissionExtensionsProvider value={{ IntentExplore: Explore }}>
        <AgentIntentDraftCard draft={draft({ ready: true })} isLatest conversationId="c1" projectId="p1" onSelect={onSelect} />
      </MissionExtensionsProvider>,
    )
    expect(screen.getByTestId('intent-explore-stub')).toBeTruthy()
    expect(seen.at(-1)).toMatchObject({ conversationId: 'c1', projectId: 'p1', title: 'Findable settings', disabled: false, intent: { problem: PAYLOAD.problem } })
  })

  it('an older settled card shows no paths', () => {
    render(<AgentIntentDraftCard draft={draft({ ready: true })} isLatest={false} conversationId="c1" onSelect={vi.fn()} />)
    expect(screen.queryByTestId('agent-intent-draft-paths')).toBeNull()
  })
})
