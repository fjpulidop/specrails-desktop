import { describe, it, expect } from 'vitest'
import { PlaceStack, placeKey, isComposeKey, consumeUserPlaceIntent, markUserPlaceIntent, type PlaceEntry } from '../places'

const loc = (path: string, search = '', key = `${path}${search}`) => ({ key, pathname: path, search })

describe('placeKey', () => {
  it('ignores filters, sort and search: they are not places', () => {
    const base = placeKey({ pathname: '/', search: '' }, 'kanban')
    expect(placeKey({ pathname: '/', search: '?status=done&jiraStatus=Open' }, 'kanban')).toBe(base)
    expect(placeKey({ pathname: '/', search: '?q=login&sort=priority&compare=3&compareSide=left' }, 'kanban')).toBe(base)
    const mission = placeKey({ pathname: '/', search: '?mission=m1' }, 'agent')
    expect(placeKey({ pathname: '/', search: '?mission=m1&status=done&q=x' }, 'agent')).toBe(mission)
  })

  it('tells missions, specs and overlays apart', () => {
    const keys = new Set([
      placeKey({ pathname: '/', search: '?mission=m1' }, 'agent'),
      placeKey({ pathname: '/', search: '?mission=m2' }, 'agent'),
      placeKey({ pathname: '/', search: '?mission=m1&spec=15' }, 'agent'),
      placeKey({ pathname: '/', search: '?mission=m1&overlay=loops' }, 'agent'),
      placeKey({ pathname: '/', search: '?mission=m1&job=j1' }, 'agent'),
      placeKey({ pathname: '/', search: '?mission=m1&review=r1' }, 'agent'),
    ])
    expect(keys.size).toBe(6)
  })

  it('belongs to a project', () => {
    expect(placeKey({ pathname: '/', search: '', projectId: 'a' }, 'kanban'))
      .not.toBe(placeKey({ pathname: '/', search: '', projectId: 'b' }, 'kanban'))
  })

  it('Board mode: ?mission means nothing, the route form of an overlay is the same place', () => {
    expect(placeKey({ pathname: '/', search: '?mission=m1' }, 'kanban')).toBe(placeKey({ pathname: '/', search: '' }, 'kanban'))
    expect(placeKey({ pathname: '/', search: '?mission=m1&review=r1' }, 'kanban')).toBe(placeKey({ pathname: '/review/r1', search: '' }, 'kanban'))
    expect(placeKey({ pathname: '/', search: '?job=j1' }, 'kanban')).toBe(placeKey({ pathname: '/jobs/j1', search: '' }, 'kanban'))
    expect(placeKey({ pathname: '/', search: '?overlay=loops' }, 'kanban')).toBe(placeKey({ pathname: '/loops', search: '' }, 'kanban'))
    expect(placeKey({ pathname: '/', search: '?overlay=plugins' }, 'kanban')).toBe(placeKey({ pathname: '/plugins', search: '' }, 'kanban'))
  })

  it('Mission mode: the modal form and the route form are the same place; Board routes collapse onto the mission', () => {
    expect(placeKey({ pathname: '/review/r1', search: '?mission=m1' }, 'agent')).toBe(placeKey({ pathname: '/', search: '?mission=m1&review=r1' }, 'agent'))
    expect(placeKey({ pathname: '/jobs', search: '?mission=m1' }, 'agent')).toBe(placeKey({ pathname: '/', search: '?mission=m1' }, 'agent'))
    expect(placeKey({ pathname: '/analytics', search: '?mission=m1' }, 'agent')).toBe(placeKey({ pathname: '/', search: '?mission=m1' }, 'agent'))
    expect(placeKey({ pathname: '/docs/a/b', search: '' }, 'agent')).not.toBeNull()
  })

  it('Mission mode: the empty compose screen is recognised', () => {
    expect(isComposeKey(placeKey({ pathname: '/', search: '' }, 'agent'))).toBe(true)
    expect(isComposeKey(placeKey({ pathname: '/', search: '?p=a&overlay=loops' }, 'agent'))).toBe(true)
    expect(isComposeKey(placeKey({ pathname: '/', search: '?mission=m1' }, 'agent'))).toBe(false)
    expect(isComposeKey(placeKey({ pathname: '/docs/a/b', search: '' }, 'agent'))).toBe(false)
    expect(isComposeKey(placeKey({ pathname: '/', search: '' }, 'kanban'))).toBe(false)
  })
})

describe('placeKey: the inbox place', () => {
  it('?inbox=1 is its own place in both modes, and other keys keep their shape', () => {
    expect(placeKey({ pathname: '/', search: '?inbox=1' }, 'kanban')).toBe('k||/|s=|o=|i=1')
    expect(placeKey({ pathname: '/', search: '' }, 'kanban')).toBe('k||/|s=|o=')
    expect(placeKey({ pathname: '/', search: '?mission=m1&inbox=1' }, 'agent')).not.toBe(placeKey({ pathname: '/', search: '?mission=m1' }, 'agent'))
    expect(placeKey({ pathname: '/', search: '?inbox=0' }, 'agent')).toBe(placeKey({ pathname: '/', search: '' }, 'agent'))
  })
})

describe('PlaceStack', () => {
  const kanbanKey = (e: PlaceEntry) => placeKey(e, 'kanban')
  const agentKey = (e: PlaceEntry) => placeKey(e, 'agent')

  function stackOf(...entries: Array<[string, string?]>): PlaceStack {
    const stack = new PlaceStack()
    entries.forEach(([path, search], i) => {
      const l = loc(path, search ?? '', `k${i}`)
      stack.record(i === 0 ? 'POP' : 'PUSH', l, 'p1')
    })
    return stack
  }

  it('recent: most recent distinct places first, never the current one, nor the compose screen', () => {
    const stack = stackOf(['/'], ['/jobs'], ['/analytics'], ['/jobs', '?status=done'], ['/activity'])
    const labels = stack.recent(kanbanKey, 5).map((r) => r.entry.pathname + r.entry.search)
    // /jobs and /jobs?status=done are one place in Board mode
    expect(labels).toEqual(['/jobs?status=done', '/analytics', '/'])
    expect(stack.recent(kanbanKey, 2)).toHaveLength(2)
  })

  it('recent: skips dead entries and includes forward ones', () => {
    const stack = stackOf(['/'], ['/jobs'], ['/analytics'])
    stack.markDead(1)
    stack.record('POP', loc('/', '', 'k0'), 'p1')
    expect(stack.recent(kanbanKey, 5).map((r) => r.entry.pathname)).toEqual(['/analytics'])
  })

  it('finds the nearest distinct place in each direction', () => {
    const stack = stackOf(['/'], ['/jobs'], ['/analytics'])
    expect(stack.idx).toBe(2)
    expect(stack.findTarget(-1, kanbanKey)).toBe(1)
    expect(stack.findTarget(1, kanbanKey)).toBeNull()
    stack.record('POP', loc('/jobs', '', 'k1'), 'p1')
    expect(stack.findTarget(1, kanbanKey)).toBe(2)
    expect(stack.findTarget(-1, kanbanKey)).toBe(0)
  })

  it('skips consecutive identical places and replace-only changes (no history spam)', () => {
    const stack = stackOf(['/'], ['/jobs'], ['/jobs', '?status=done'], ['/jobs', '?status=failed'])
    expect(stack.findTarget(-1, kanbanKey)).toBe(0)
    expect(stack.list(-1, kanbanKey).map((i) => i.idx)).toEqual([0])
  })

  it('REPLACE rewrites the current entry without adding one', () => {
    const stack = stackOf(['/'], ['/jobs'])
    stack.record('REPLACE', loc('/jobs', '?status=done', 'k9'), 'p1')
    expect(stack.idx).toBe(1)
    expect(stack.list(-1, kanbanKey)).toHaveLength(1)
    expect(stack.findTarget(1, kanbanKey)).toBeNull()
  })

  it('PUSH from the middle drops the forward entries', () => {
    const stack = stackOf(['/'], ['/jobs'], ['/analytics'])
    stack.record('POP', loc('/', '', 'k0'), 'p1')
    stack.record('PUSH', loc('/activity', '', 'k7'), 'p1')
    expect(stack.idx).toBe(1)
    expect(stack.findTarget(1, kanbanKey)).toBeNull()
  })

  it('never flips the mode: entries meaningless in the current mode are skipped, not restored', () => {
    // Mission mode: m1 → (Board-only route, still showing m1) → m2
    const stack = stackOf(['/', '?mission=m1'], ['/jobs', '?mission=m1'], ['/', '?mission=m2'])
    expect(stack.findTarget(-1, agentKey)).toBe(1)
    // In Board mode the missions all collapse onto the dashboard: only /jobs is a distinct stop.
    expect(stack.findTarget(-1, kanbanKey)).toBe(1)
    // …and from there the duplicate m1 entry is skipped: no stop that looks like a no-op.
    stack.record('POP', loc('/jobs', '?mission=m1', 'k1'), 'p1')
    expect(stack.findTarget(-1, agentKey)).toBeNull()
  })

  it('never goes back to the compose screen from a mission (that would reset it to a new-mission draft)', () => {
    const stack = stackOf(['/', '?mission=m1'], ['/', ''], ['/', '?mission=m2'])
    expect(stack.findTarget(-1, agentKey)).toBe(0)
  })

  it('but Back from an overlay over the compose screen returns to the compose screen', () => {
    const stack = stackOf(['/', ''], ['/', '?overlay=loops'])
    expect(stack.findTarget(-1, agentKey)).toBe(0)
  })

  it('skips entries marked dead (deleted target)', () => {
    const stack = stackOf(['/', '?mission=m1'], ['/', '?mission=m2'], ['/', '?mission=m3'])
    stack.markDead(1)
    expect(stack.findTarget(-1, agentKey)).toBe(0)
    expect(stack.list(-1, agentKey).map((i) => i.idx)).toEqual([0])
  })

  it('lists at most `limit` places and scans at most 50 back', () => {
    const entries: Array<[string, string?]> = []
    for (let i = 0; i < 80; i++) entries.push(['/', `?mission=m${i}`])
    const stack = stackOf(...entries)
    expect(stack.list(-1, agentKey)).toHaveLength(10)
    expect(stack.list(-1, agentKey, 100)).toHaveLength(50)
    expect(stack.list(-1, agentKey)[0].idx).toBe(78)
  })

  it('treats entries from before a reload (unknown) as reachable', () => {
    const stack = new PlaceStack()
    stack.record('POP', loc('/jobs', '', 'r'), 'p1', 3)
    expect(stack.idx).toBe(3)
    expect(stack.findTarget(-1, kanbanKey)).toBe(2)
    expect(stack.findTarget(1, kanbanKey)).toBeNull()
  })

  it('trusts the router index when a render was skipped (two pushes batched into one)', () => {
    const stack = new PlaceStack()
    stack.record('POP', loc('/', '', 'k0'), 'p1', 0)
    stack.record('PUSH', loc('/jobs', '', 'k2'), 'p1', 2)
    expect(stack.idx).toBe(2)
    // The skipped entry (1) is unknown but reachable.
    expect(stack.findTarget(-1, kanbanKey)).toBe(1)
  })

  it('adopts the project of an entry created before the project list resolved', () => {
    const stack = new PlaceStack()
    stack.record('POP', loc('/'), null)
    expect(stack.current()?.projectId).toBeNull()
    stack.adoptProject('p1')
    expect(stack.current()?.projectId).toBe('p1')
    stack.adoptProject('p2')
    expect(stack.current()?.projectId).toBe('p1')
  })

  it('a replace keeps the project the entry was created in', () => {
    const stack = new PlaceStack()
    stack.record('POP', loc('/'), 'p1')
    stack.record('REPLACE', loc('/', '?x', 'k2'), 'p2')
    expect(stack.current()?.projectId).toBe('p1')
  })
})

describe('user place intent', () => {
  it('is consumed once', () => {
    expect(consumeUserPlaceIntent()).toBe(false)
    markUserPlaceIntent()
    expect(consumeUserPlaceIntent()).toBe(true)
    expect(consumeUserPlaceIntent()).toBe(false)
  })
})
