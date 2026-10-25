import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act, render, waitFor } from '@testing-library/react'

// The mission list's attention dot for Flow runs: derived app-wide from the
// Flow's per-project watch (GET /flow/open + `flow.state`), so it is live and
// clears whether or not the mission is open. One rule with the strip's tone.

const hoisted = vi.hoisted(() => ({
  wsHandler: null as ((msg: unknown) => void) | null,
  /** Lets a test pretend a state needs the person (none does today). */
  needsPerson: null as null | ((state: string) => boolean),
}))

vi.mock('../../../hooks/useSharedWebSocket', () => ({
  useSharedWebSocket: () => ({
    registerHandler: (_id: string, fn: (m: unknown) => void) => { hoisted.wsHandler = fn },
    unregisterHandler: () => { hoisted.wsHandler = null },
    connectionStatus: 'connected',
  }),
}))

vi.mock('../lib/flow-api', async (orig) => {
  const actual = await orig<typeof import('../lib/flow-api')>()
  return {
    ...actual,
    flowApi: {
      ...actual.flowApi,
      open: vi.fn(async (projectId: string) => (projectId === 'p1'
        ? [{ id: 'f2', conversationId: 'c2', state: 'paused', branch: 'flow/x' }]
        : [])),
    },
  }
})

vi.mock('../lib/flow-run-tone', async (orig) => {
  const actual = await orig<typeof import('../lib/flow-run-tone')>()
  return {
    ...actual,
    flowNeedsPerson: (state: Parameters<typeof actual.flowNeedsPerson>[0]) => (hoisted.needsPerson ? hoisted.needsPerson(state) : actual.flowNeedsPerson(state)),
  }
})

import { FlowProvider } from '../context/FlowContext'
import { useFlowRunAttention } from '../components/FlowConversationMarks'
import { FLOW_MISSION_EXTENSIONS } from '../components/FlowMissionsBridge'
import type { MissionConversationRef } from '../../missions/context/MissionExtensionsContext'
import type { Flow } from '../lib/flow-api'

const actualTone = await vi.importActual<typeof import('../lib/flow-run-tone')>('../lib/flow-run-tone')

const CONVERSATIONS: MissionConversationRef[] = [
  { id: 'c1', pinned_project_id: 'p1' },
  { id: 'c2', pinned_project_id: 'p1' },
  { id: 'c3', pinned_project_id: null },
]

let attention: ReadonlyMap<string, ReadonlySet<string>> = new Map()
function Probe() {
  attention = useFlowRunAttention(CONVERSATIONS)
  return null
}

function flowEvent(conversationId: string, state: Flow['state']): void {
  act(() => {
    hoisted.wsHandler?.({ type: 'flow.state', projectId: 'p1', conversationId, flow: { id: `f-${conversationId}`, conversationId, state } })
  })
}

beforeEach(() => {
  attention = new Map()
  hoisted.needsPerson = null
})

describe('Flow run tone (one rule for the strip and the attention dot)', () => {
  it('maps open states to the strip tone and keeps every current state calm', () => {
    expect(actualTone.flowOpenRunTone('active')).toBe('running')
    expect(actualTone.flowOpenRunTone('paused')).toBe('paused')
    expect(actualTone.flowOpenRunTone('needs-review')).toBe('info')
    expect(actualTone.flowOpenRunTone('handed_off')).toBeNull()
    expect(actualTone.flowOpenRunTone('closed')).toBeNull()
    // Paused and needs-review are not decisions: no Flow state lights the dot on its own
    // (a Flow → Spec run that fails or waits is a delivery and feeds the dot itself).
    for (const state of ['active', 'paused', 'needs-review', 'handed_off', 'delivered', 'discarded', 'closed'] as const) {
      expect(actualTone.flowNeedsPerson(state)).toBe(false)
    }
  })

  it('is plugged into the missions seam', () => {
    expect(FLOW_MISSION_EXTENSIONS.useRunAttention).toBe(useFlowRunAttention)
  })
})

describe('useFlowRunAttention', () => {
  it('reports every listed mission from the app-wide watch, live, and clears when the Flow stops waiting', async () => {
    hoisted.needsPerson = (state) => state === 'paused'
    render(<FlowProvider><Probe /></FlowProvider>)
    // From GET /flow/open: c2's Flow is paused (made to need the person here). c2 is not open anywhere.
    await waitFor(() => expect(attention.get('c2')?.has('flow')).toBe(true))
    expect(attention.has('c1')).toBe(false)
    // Live through `flow.state`, for any listed mission of a watched project.
    flowEvent('c1', 'paused')
    await waitFor(() => expect(attention.has('c1')).toBe(true))
    // Clears when the Flow resumes or leaves Flow mode.
    flowEvent('c1', 'active')
    flowEvent('c2', 'handed_off')
    await waitFor(() => expect(attention.size).toBe(0))
  })

  it('stays empty with the real rule: no open Flow state waits for the person', async () => {
    render(<FlowProvider><Probe /></FlowProvider>)
    flowEvent('c1', 'needs-review')
    flowEvent('c2', 'paused')
    await act(async () => { await Promise.resolve() })
    expect(attention.size).toBe(0)
  })
})
