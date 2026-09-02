import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

vi.mock('../../../context/WebViewModalContext', () => ({
  useWebViewModal: () => ({ openWebView: vi.fn(), canOpenWebView: false }),
}))

import { extractAgentProblemFrame } from '../agent-problem-frame'
import { AgentProblemFrameCard } from '../AgentProblemFrameCard'
import { AgentMessage } from '../AgentMessage'

const frame = {
  restated: {
    reading: 'Reorganise the Settings page so its sections are grouped',
    touches: ['client/src/pages/SettingsPage.tsx'],
  },
  alternative: {
    reading: 'Make a specific setting findable from anywhere, without touching the page layout',
    touches: ['client/src/components/CommandPalette.tsx'],
  },
  discriminator: 'When you get lost, are you scanning the page, or did you arrive there by accident?',
  assumptions: ['This is about the app-level settings modal, not per-project settings'],
  unknowns: ['Whether the same complaint covers the project Settings route'],
}
const fence = (payload: string) => '```problem-frame\n' + payload + '\n```'
const withFrame = `Before I draft anything, here is what I understood.\n\n${fence(JSON.stringify(frame))}`

describe('extractAgentProblemFrame', () => {
  it('passes content through untouched when no fence exists', () => {
    const r = extractAgentProblemFrame('plain **markdown** reply')
    expect(r).toEqual({ body: 'plain **markdown** reply', frame: null, pending: false })
  })

  it('parses a complete block and strips it from the body', () => {
    const r = extractAgentProblemFrame(withFrame)
    expect(r.frame).toEqual(frame)
    expect(r.pending).toBe(false)
    expect(r.body).toBe('Before I draft anything, here is what I understood.')
    expect(r.body).not.toContain('problem-frame')
  })

  it('the LAST valid snapshot wins when a message carries two blocks', () => {
    const older = { ...frame, discriminator: 'An older question?' }
    const content = `${fence(JSON.stringify(older))}\n\ncorrected:\n\n${fence(JSON.stringify(frame))}`
    const r = extractAgentProblemFrame(content)
    expect(r.frame?.discriminator).toBe(frame.discriminator)
    expect(r.body).toBe('corrected:')
  })

  it('coerces the optional arrays and a missing touches list', () => {
    const r = extractAgentProblemFrame(
      fence(
        JSON.stringify({
          restated: { reading: 'A' },
          alternative: { reading: 'B', touches: ['x.ts', 7] },
          discriminator: 'Which one?',
          assumptions: 'not an array',
          unknowns: ['u', null],
        }),
      ),
    )
    expect(r.frame).toEqual({
      restated: { reading: 'A', touches: [] },
      alternative: { reading: 'B', touches: ['x.ts'] },
      discriminator: 'Which one?',
      assumptions: [],
      unknowns: ['u'],
    })
  })

  it('rejects a block missing a required key', () => {
    const { discriminator: _omitted, ...noDiscriminator } = frame
    expect(extractAgentProblemFrame(fence(JSON.stringify(noDiscriminator))).frame).toBeNull()
    const { alternative: _alt, ...noAlternative } = frame
    expect(extractAgentProblemFrame(fence(JSON.stringify(noAlternative))).frame).toBeNull()
  })

  it('rejects an empty reading or an empty discriminator', () => {
    const blankReading = { ...frame, alternative: { reading: '  ', touches: [] } }
    expect(extractAgentProblemFrame(fence(JSON.stringify(blankReading))).frame).toBeNull()
    const blankQuestion = { ...frame, discriminator: '   ' }
    expect(extractAgentProblemFrame(fence(JSON.stringify(blankQuestion))).frame).toBeNull()
  })

  it('rejects two readings that are literally the same reading', () => {
    const same = { ...frame, alternative: { ...frame.alternative, reading: frame.restated.reading } }
    expect(extractAgentProblemFrame(fence(JSON.stringify(same))).frame).toBeNull()
  })

  it('accepts two readings sharing surfaces when the readings differ', () => {
    const sameSurfaces = {
      ...frame,
      alternative: { reading: 'Only the empty state changes', touches: [...frame.restated.touches] },
    }
    const r = extractAgentProblemFrame(fence(JSON.stringify(sameSurfaces)))
    expect(r.frame?.alternative.touches).toEqual(frame.restated.touches)
  })

  it('strips a complete-but-malformed block silently (spec-draft precedent)', () => {
    const r = extractAgentProblemFrame(`prose\n\n${fence('not json at all')}`)
    expect(r.frame).toBeNull()
    expect(r.body).toBe('prose')
  })

  it('settled unclosed fence with a valid JSON tail is still parsed (lenient close)', () => {
    const r = extractAgentProblemFrame(`done!\n\n\`\`\`problem-frame\n${JSON.stringify(frame)}`)
    expect(r.frame?.discriminator).toBe(frame.discriminator)
    expect(r.body).toBe('done!')
  })

  it('streaming: an incomplete fence is cut from the body and flagged pending', () => {
    const partial = 'Let me frame this.\n\n```problem-frame\n{ "restated": { "reading": "Reorg'
    const r = extractAgentProblemFrame(partial, true)
    expect(r.pending).toBe(true)
    expect(r.frame).toBeNull()
    expect(r.body).toBe('Let me frame this.')
    expect(r.body).not.toContain('"restated"')
  })

  it('settled incomplete fence with an invalid tail is left in place (content never lost)', () => {
    const r = extractAgentProblemFrame('oops\n\n```problem-frame\n{ "restated": { "read', false)
    expect(r.pending).toBe(false)
    expect(r.frame).toBeNull()
    expect(r.body).toContain('problem-frame')
  })
})

describe('AgentProblemFrameCard', () => {
  it('renders both readings, their touched surfaces and the discriminating question', () => {
    render(<AgentProblemFrameCard frame={frame} />)
    expect(screen.getByTestId('agent-problem-frame-card')).toBeInTheDocument()
    expect(screen.getByText('What I understood')).toBeInTheDocument()
    expect(screen.getByText('It could also mean')).toBeInTheDocument()
    expect(screen.getByText(frame.restated.reading)).toBeInTheDocument()
    expect(screen.getByText(frame.alternative.reading)).toBeInTheDocument()
    expect(screen.getByText('client/src/pages/SettingsPage.tsx')).toBeInTheDocument()
    expect(screen.getByText('client/src/components/CommandPalette.tsx')).toBeInTheDocument()
    expect(screen.getByText(frame.discriminator)).toBeInTheDocument()
  })

  it('renders assumptions and unknowns when present', () => {
    render(<AgentProblemFrameCard frame={frame} />)
    expect(screen.getByText(frame.assumptions[0])).toBeInTheDocument()
    expect(screen.getByText(frame.unknowns[0])).toBeInTheDocument()
  })

  it('omits the optional sections when both lists are empty', () => {
    render(<AgentProblemFrameCard frame={{ ...frame, assumptions: [], unknowns: [] }} />)
    expect(screen.queryByText("What I'm assuming")).not.toBeInTheDocument()
    expect(screen.queryByText('Still open')).not.toBeInTheDocument()
  })

  it('renders a reading with no touched surfaces without an empty list', () => {
    render(
      <AgentProblemFrameCard
        frame={{ ...frame, restated: { reading: frame.restated.reading, touches: [] } }}
      />,
    )
    expect(screen.getByText(frame.restated.reading)).toBeInTheDocument()
    expect(screen.queryByText('client/src/pages/SettingsPage.tsx')).not.toBeInTheDocument()
  })
})

describe('AgentMessage problem-frame integration', () => {
  it('renders the frame card and strips the raw JSON from the bubble', () => {
    const { container } = render(<AgentMessage role="assistant" content={withFrame} />)
    expect(screen.getByTestId('agent-problem-frame-card')).toBeInTheDocument()
    expect(screen.getByText('Before I draft anything, here is what I understood.')).toBeInTheDocument()
    expect(container.textContent).not.toContain('"discriminator"')
  })

  it('shows the pending chip while a problem-frame block is streaming in', () => {
    render(
      <AgentMessage role="assistant" content={'Framing…\n\n```problem-frame\n{ "restated": { "re'} streaming />,
    )
    expect(screen.getByTestId('agent-problem-frame-pending')).toBeInTheDocument()
    expect(screen.queryByTestId('agent-problem-frame-card')).not.toBeInTheDocument()
  })

  it('a malformed block leaves surrounding content intact and renders no card', () => {
    const content = `Here is my framing.\n\n${fence('{ "restated": {} }')}\n\nWhat do you think?`
    const { container } = render(<AgentMessage role="assistant" content={content} />)
    expect(screen.queryByTestId('agent-problem-frame-card')).not.toBeInTheDocument()
    expect(screen.getByText('Here is my framing.')).toBeInTheDocument()
    expect(screen.getByText('What do you think?')).toBeInTheDocument()
    expect(container.textContent).not.toContain('problem-frame')
  })

  it('composes with a trailing options block: card + chips, both protocols stripped', () => {
    const content = `${withFrame}\n\n\`\`\`options\n["That's it", "No — it's the menu"]\n\`\`\``
    render(<AgentMessage role="assistant" content={content} isLast onPickOption={vi.fn()} />)
    expect(screen.getByTestId('agent-problem-frame-card')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: "That's it" })).toBeInTheDocument()
  })

  it('composes with a spec-draft block: both cards render, neither protocol leaks', () => {
    const draft = { title: 'T', description: 'D', labels: [], priority: 'medium', acceptanceCriteria: ['C'] }
    const content = `${withFrame}\n\n\`\`\`spec-draft\n${JSON.stringify(draft)}\n\`\`\``
    const { container } = render(<AgentMessage role="assistant" content={content} />)
    expect(screen.getByTestId('agent-problem-frame-card')).toBeInTheDocument()
    expect(screen.getByTestId('agent-spec-draft-card')).toBeInTheDocument()
    expect(container.textContent).not.toContain('"acceptanceCriteria"')
    expect(container.textContent).not.toContain('"discriminator"')
  })
})
