import { describe, expect, it } from 'vitest'
import { buildAgentContextBlock, buildReferenceItems, railChip, railsFromResponse, toContextReference, type PaletteSourceState } from '../../features/missions/lib/agent-context-palette'

const base: PaletteSourceState = {
  projects: [{ id: 'p1', name: 'Home', slug: 'home', path: '/h', db_path: '', provider: 'claude', added_at: '', last_seen_at: '' }] as PaletteSourceState['projects'],
  conversations: [], activeConversation: null, pinnedProjectId: 'p1', activeProjectId: 'p1', tickets: [], jobs: [], chips: [],
}

describe('railsFromResponse', () => {
  it('honours server availability and derives busy / pending_decision otherwise', () => {
    const rails = railsFromResponse({
      rails: [
        { index: 0, name: 'Auth', ticketIds: [1, 2], mode: 'implement' },
        { index: 1, name: null, ticketIds: [] },
        { index: 2, name: 'Old', ticketIds: [9], availability: 'on_review' },
        { index: 3, name: null, ticketIds: [5, 'x'] },
        { railIndex: 4, ticketIds: [] },
        { name: 'no index' },
      ],
      activeLoopRuns: { '0': { loopRunId: 'r' } },
      prDeliveries: { '3': { decision: 'on_review' }, '4': { decision: 'merged' } },
    })
    expect(rails.map((r) => [r.index, r.availability, r.ticketIds])).toEqual([
      [0, 'busy', [1, 2]], [1, 'free', []], [2, 'on_review', [9]], [3, 'pending_decision', [5]], [4, 'free', []],
    ])
    expect(railsFromResponse(null)).toEqual([])
    expect(railsFromResponse({ rails: 'nope' })).toEqual([])
  })
})

describe('@rail-N references', () => {
  it('builds chips, palette rows and the context block line', () => {
    const items = buildReferenceItems({ ...base, rails: [{ index: 1, name: 'Auth', ticketIds: [4, 7], availability: 'busy' }, { index: 0, name: null, ticketIds: [], availability: 'free' }] })
    const rails = items.filter((i) => i.icon === 'rail')
    expect(rails.map((i) => [i.title, i.group, i.chip?.token])).toEqual([
      ['Rail 2 · Auth', 'Rails in use', '@rail-2'],
      ['Rail 1', 'Rails', '@rail-1'],
    ])
    expect(rails[0].keywords).toContain('#4')
    const ref = toContextReference(railChip({ index: 1, name: 'Auth', ticketIds: [4, 7], availability: 'busy' }, 'p1', 'Home'))
    expect(ref).toMatchObject({ kind: 'rail', id: '1', token: '@rail-2', status: 'busy' })
    expect(buildAgentContextBlock([ref])).toContain('- @rail-2: kind=rail railIndex=1 label="rail 2 (Auth, specs #4 #7, busy)" project=Home')
    const unnamed = toContextReference(railChip({ index: 0, name: null, ticketIds: [] }, 'p1', 'Home'))
    expect(buildAgentContextBlock([unnamed])).toContain('label="rail 1 (unnamed, no specs, unknown)"')
  })
  it('legacy state without rails still works', () => {
    expect(buildReferenceItems(base).some((i) => i.icon === 'rail')).toBe(false)
  })
})
