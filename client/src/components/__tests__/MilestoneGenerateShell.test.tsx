import React from 'react'
import { act, render, screen, waitFor } from '../../test-utils'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MilestoneGenerateShell } from '../project-builder/MilestoneGenerateShell'
import { SharedWebSocketContext } from '../../hooks/useSharedWebSocket'
import type { Blueprint } from '../../lib/blueprint-draft'

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
vi.mock('../../lib/api', () => ({ getApiBase: () => '/api/projects/proj-1' }))

const ws = {
  registerHandler: vi.fn(),
  unregisterHandler: vi.fn(),
  connectionStatus: 'connected' as const,
}

const projectBlueprint: Blueprint = {
  blueprintVersion: 1,
  product: { name: 'Atlas', pitch: 'Operational reports', audience: 'Operators' },
  coreFlow: 'An operator opens and exports a report.',
  platform: 'web',
  stack: { language: 'TypeScript', framework: 'React', db: 'SQLite' },
  assumptions: [],
  milestones: [
    { id: 'm1', title: 'Foundation', goal: 'Runnable shell', status: 'committed', plannedSpecs: [] },
    { id: 'm2', title: 'Reporting', goal: 'Verified reports', status: 'planned', plannedSpecs: ['Add report export'] },
  ],
  specsComplete: true,
  m1Specs: [],
}

function detailedSpec(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'feature',
    title: 'Export a verified operational report',
    shortSummary: 'Let an operator export the currently verified report.',
    description: [
      '## Problem Statement',
      'Operators need to carry verified report data into downstream operational workflows without manually copying values.',
      '',
      '## Proposed Solution',
      'Add an export action that serializes the current verified report through the existing reporting boundary.',
      '',
      '## Out of Scope',
      '- Scheduled report delivery',
      '- Custom export templates',
      '',
      '## Technical Considerations',
      '- Reuse the verified report data contract inspected in the repository',
      '- Cover empty, stale, successful, and failed export outcomes',
      '',
      '## Estimated Complexity',
      'Medium — the export crosses the report boundary and browser download behavior.',
    ].join('\n'),
    acceptanceCriteria: [
      'A verified report can be exported from its visible action.',
      'The exported payload contains the values shown in the verified report.',
      'An unavailable report disables export with an actionable explanation.',
      'Automated tests cover successful and failed export behavior.',
    ],
    priority: 'high',
    labels: ['M2', 'reporting'],
    ...overrides,
  }
}

function fence(spec: Record<string, unknown>): string {
  return `\`\`\`blueprint-draft\n${JSON.stringify({
    ...projectBlueprint,
    specsComplete: true,
    m1Specs: [spec],
  })}\n\`\`\``
}

function handler(): (message: unknown) => void {
  return ws.registerHandler.mock.calls.at(-1)?.[1] as (message: unknown) => void
}

function renderShell(onCommitted = vi.fn(), onClose = vi.fn()) {
  render(
    <SharedWebSocketContext.Provider value={ws}>
      <MilestoneGenerateShell
        open
        onClose={onClose}
        onCommitted={onCommitted}
        projectId="proj-1"
        milestoneId="m2"
        blueprint={projectBlueprint}
      />
    </SharedWebSocketContext.Provider>,
  )
  return { onCommitted, onClose }
}

beforeEach(() => {
  vi.clearAllMocks()
  global.fetch = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.endsWith('/chat/conversations')) {
      return { ok: true, status: 201, json: async () => ({ conversation: { id: 'conv-1' } }) }
    }
    if (url.includes('/chat/conversations/conv-1/messages')) {
      return { ok: true, status: 202, json: async () => ({ accepted: true }) }
    }
    if (url.endsWith('/blueprint/commit-milestone')) {
      return { ok: true, status: 201, json: async () => ({ insertedIds: [41] }) }
    }
    return { ok: false, status: 404, json: async () => ({}) }
  })
})

describe('MilestoneGenerateShell rich-spec gate', () => {
  it('rejects invalid raw fields even when the preview parser normalizes them', async () => {
    renderShell()
    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith(
      '/api/projects/proj-1/chat/conversations/conv-1/messages',
      expect.anything(),
    ))
    act(() => handler()({
      type: 'chat_done', conversationId: 'conv-1', projectId: 'proj-1',
      fullText: fence(detailedSpec({ priority: 'urgent', dependsOnIndex: -1 })),
    }))

    expect(await screen.findByTestId('milestone-quality-detail')).toHaveTextContent('valid priority')
    expect(screen.getByTestId('milestone-commit')).toBeDisabled()
  })

  it('commits the exact valid raw batch and invalidates the parent blueprint', async () => {
    const callbacks = renderShell()
    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith(
      '/api/projects/proj-1/chat/conversations/conv-1/messages',
      expect.anything(),
    ))
    const rawSpec = detailedSpec()
    act(() => handler()({
      type: 'chat_done', conversationId: 'conv-1', projectId: 'proj-1', fullText: fence(rawSpec),
    }))
    await waitFor(() => expect(screen.getByTestId('milestone-commit')).toBeEnabled())
    await userEvent.click(screen.getByTestId('milestone-commit'))
    await waitFor(() => expect(callbacks.onCommitted).toHaveBeenCalledOnce())
    expect(callbacks.onClose).toHaveBeenCalledOnce()

    const call = vi.mocked(global.fetch).mock.calls.find(([input]) => String(input).endsWith('/blueprint/commit-milestone'))
    const body = JSON.parse(String((call?.[1] as RequestInit).body)) as Record<string, unknown>
    expect(body).toMatchObject({ milestoneId: 'm2', specsComplete: true, specs: [rawSpec] })
  })
})
