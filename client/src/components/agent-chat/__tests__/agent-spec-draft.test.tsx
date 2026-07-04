import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

vi.mock('../../../context/WebViewModalContext', () => ({
  useWebViewModal: () => ({ openWebView: vi.fn(), canOpenWebView: false }),
}))

import { extractAgentSpecDraft } from '../agent-spec-draft'
import { AgentSpecDraftCard } from '../AgentSpecDraftCard'
import { AgentMessage } from '../AgentMessage'

const draft = {
  title: 'Add dark-mode toggle',
  description: '## Problem Statement\nUsers cannot override the OS theme.\n\n## Proposed Solution\nA toggle in Settings.',
  labels: ['ui', 'settings'],
  priority: 'high',
  acceptanceCriteria: ['Toggle persists across restarts', 'Default follows the OS'],
}
const fence = (payload: string) => '```spec-draft\n' + payload + '\n```'
const withDraft = `Updated the draft with your answer.\n\n${fence(JSON.stringify(draft))}`

describe('extractAgentSpecDraft', () => {
  it('passes content through untouched when no fence exists', () => {
    const r = extractAgentSpecDraft('plain **markdown** reply')
    expect(r).toEqual({ body: 'plain **markdown** reply', draft: null, pending: false })
  })

  it('parses a complete block and strips it from the body', () => {
    const r = extractAgentSpecDraft(withDraft)
    expect(r.draft).toEqual(draft)
    expect(r.pending).toBe(false)
    expect(r.body).toBe('Updated the draft with your answer.')
    expect(r.body).not.toContain('spec-draft')
  })

  it('the LAST valid snapshot wins when a message carries two blocks', () => {
    const older = { ...draft, title: 'Old title' }
    const content = `${fence(JSON.stringify(older))}\n\nrevised:\n\n${fence(JSON.stringify(draft))}`
    const r = extractAgentSpecDraft(content)
    expect(r.draft?.title).toBe('Add dark-mode toggle')
    expect(r.body).toBe('revised:')
  })

  it('strips a complete-but-malformed block silently (server-parser precedent)', () => {
    const r = extractAgentSpecDraft(`prose\n\n${fence('not json at all')}`)
    expect(r.draft).toBeNull()
    expect(r.body).toBe('prose')
  })

  it('normalizes missing/invalid fields (priority falls back to medium, arrays coerced)', () => {
    const r = extractAgentSpecDraft(fence(JSON.stringify({ title: 'T', priority: 'urgent', labels: ['a', 2] })))
    expect(r.draft).toEqual({
      title: 'T', description: '', labels: ['a'], priority: 'medium', acceptanceCriteria: [],
    })
  })

  it('rejects an all-empty object as not-a-draft', () => {
    const r = extractAgentSpecDraft(fence(JSON.stringify({ labels: ['x'] })))
    expect(r.draft).toBeNull()
  })

  it('settled unclosed fence with a valid JSON tail is still parsed (lenient close)', () => {
    const r = extractAgentSpecDraft(`done!\n\n\`\`\`spec-draft\n${JSON.stringify(draft)}`)
    expect(r.draft?.title).toBe('Add dark-mode toggle')
    expect(r.body).toBe('done!')
  })

  it('streaming: an incomplete fence is cut from the body and flagged pending', () => {
    const partial = 'Let me update the draft.\n\n```spec-draft\n{ "title": "Add dark'
    const r = extractAgentSpecDraft(partial, true)
    expect(r.pending).toBe(true)
    expect(r.draft).toBeNull()
    expect(r.body).toBe('Let me update the draft.')
    expect(r.body).not.toContain('{ "title"')
  })

  it('settled incomplete fence with an invalid tail is left in place (content never lost)', () => {
    const partial = 'oops\n\n```spec-draft\n{ "title": "trunca'
    const r = extractAgentSpecDraft(partial, false)
    expect(r.pending).toBe(false)
    expect(r.draft).toBeNull()
    expect(r.body).toContain('spec-draft')
  })
})

describe('AgentSpecDraftCard', () => {
  it('renders title, priority pill, labels and the acceptance-criteria checklist', () => {
    render(<AgentSpecDraftCard draft={draft as never} />)
    expect(screen.getByTestId('agent-spec-draft-card')).toBeInTheDocument()
    expect(screen.getByText('Spec draft')).toBeInTheDocument()
    expect(screen.getByText('Add dark-mode toggle')).toBeInTheDocument()
    expect(screen.getByText('high')).toBeInTheDocument()
    expect(screen.getByText('ui')).toBeInTheDocument()
    expect(screen.getByText('settings')).toBeInTheDocument()
    expect(screen.getByText(/Acceptance criteria · 2/)).toBeInTheDocument()
    expect(screen.getByText('Toggle persists across restarts')).toBeInTheDocument()
  })

  it('description starts collapsed and expands on toggle', () => {
    render(<AgentSpecDraftCard draft={draft as never} />)
    const toggle = screen.getByRole('button', { name: /Show full description/ })
    fireEvent.click(toggle)
    expect(screen.getByRole('button', { name: /Collapse description/ })).toBeInTheDocument()
  })

  it('falls back to the untitled label when the title is blank', () => {
    render(<AgentSpecDraftCard draft={{ ...draft, title: ' ' } as never} />)
    expect(screen.getByText('Untitled spec')).toBeInTheDocument()
  })
})

describe('AgentMessage spec-draft integration', () => {
  it('renders the draft card and strips the raw JSON from the bubble', () => {
    const { container } = render(<AgentMessage role="assistant" content={withDraft} />)
    expect(screen.getByTestId('agent-spec-draft-card')).toBeInTheDocument()
    expect(screen.getByText('Updated the draft with your answer.')).toBeInTheDocument()
    expect(container.textContent).not.toContain('"acceptanceCriteria"')
  })

  it('shows the pending chip while a spec-draft block is streaming in', () => {
    render(
      <AgentMessage
        role="assistant"
        content={'Drafting…\n\n```spec-draft\n{ "title": "par'}
        streaming
      />,
    )
    expect(screen.getByTestId('agent-spec-draft-pending')).toBeInTheDocument()
    expect(screen.queryByTestId('agent-spec-draft-card')).not.toBeInTheDocument()
  })

  it('composes with a trailing options block: card + chips, both protocols stripped', () => {
    const content = `${withDraft}\n\n\`\`\`options\n["Looks good — create it", "Change priority"]\n\`\`\``
    render(<AgentMessage role="assistant" content={content} isLast onPickOption={vi.fn()} />)
    expect(screen.getByTestId('agent-spec-draft-card')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Looks good — create it' })).toBeInTheDocument()
  })
})
