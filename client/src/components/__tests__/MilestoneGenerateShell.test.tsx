import React from 'react'
import { premiumDescription, premiumCriteria } from '../../lib/__tests__/premium-spec-fixture'
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
    description: premiumDescription({ subject: 'the verified report export' }),
    acceptanceCriteria: premiumCriteria('export'),
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
  it('does not create or send a milestone conversation for Kimi', () => {
    render(
      <SharedWebSocketContext.Provider value={ws}>
        <MilestoneGenerateShell
          open
          onClose={vi.fn()}
          projectId="proj-1"
          milestoneId="m2"
          blueprint={projectBlueprint}
          provider="kimi"
        />
      </SharedWebSocketContext.Provider>,
    )
    expect(screen.getByTestId('milestone-provider-unavailable')).toHaveTextContent(/read-only/i)
    expect(global.fetch).not.toHaveBeenCalled()
  })

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

    // The readiness surface lists the audit issues, localized and spec-precise.
    const toggle = await screen.findByTestId('readiness-issues-toggle')
    expect(toggle).toHaveTextContent(/audit issues/)
    await userEvent.click(toggle)
    expect(screen.getByTestId('readiness-issues')).toHaveTextContent('Spec 1 needs a valid priority.')
    expect(screen.getByTestId('readiness-issues')).toHaveTextContent('may only depend on an earlier spec')
    expect(screen.getByTestId('milestone-commit')).toBeDisabled()
  })

  it('accepts a frame that arrives in the same tick as the seeded turn', async () => {
    // Production ordering: the server accepts the turn and starts streaming
    // immediately, so the first frame can land before React has flushed the
    // effect that mirrors conversationId into the ref the WS guard reads.
    // Firing it from inside the POST reproduces that deterministically —
    // without a synchronously-armed ref the frame is dropped as foreign.
    const rawSpec = detailedSpec()
    global.fetch = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/chat/conversations')) {
        return { ok: true, status: 201, json: async () => ({ conversation: { id: 'conv-1' } }) }
      }
      if (url.includes('/chat/conversations/conv-1/messages')) {
        handler()({
          type: 'chat_done', conversationId: 'conv-1', projectId: 'proj-1', fullText: fence(rawSpec),
        })
        return { ok: true, status: 202, json: async () => ({ accepted: true }) }
      }
      return { ok: false, status: 404, json: async () => ({}) }
    })

    renderShell()

    await waitFor(() => expect(screen.getByTestId('milestone-commit')).toBeEnabled())
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
