import { describe, it, expect, beforeEach } from 'vitest'
import {
  applySpecSort,
  jiraKeyNumber,
  loadSpecSort,
  saveSpecSort,
  sortByJiraKey,
  sortByPriority,
  sortByTicketId,
} from '../spec-sort'
import type { LocalTicket, TicketPriority } from '../../types'

function makeTicket(id: number, priority: TicketPriority | null = 'medium'): LocalTicket {
  return {
    id,
    title: `t-${id}`,
    description: '',
    status: 'todo',
    priority,
    labels: [],
    assignee: null,
    prerequisites: [],
    metadata: {},
    created_at: '',
    updated_at: '',
    created_by: 'test',
    source: 'manual',
  }
}

function makeJiraTicket(id: number, jiraKey: string | null): LocalTicket {
  const t = makeTicket(id)
  t.source = 'jira'
  t.jira_key = jiraKey
  return t
}

describe('sortByTicketId', () => {
  it('asc returns negative when a.id < b.id', () => {
    expect(sortByTicketId(makeTicket(1), makeTicket(2), 'asc')).toBeLessThan(0)
  })
  it('desc returns positive when a.id < b.id', () => {
    expect(sortByTicketId(makeTicket(1), makeTicket(2), 'desc')).toBeGreaterThan(0)
  })
  it('returns 0 for equal ids', () => {
    expect(sortByTicketId(makeTicket(5), makeTicket(5), 'asc')).toBe(0)
  })
})

describe('sortByPriority', () => {
  it('desc puts critical before high before medium before low before null', () => {
    const ts = [
      makeTicket(1, 'low'),
      makeTicket(2, 'critical'),
      makeTicket(3, null),
      makeTicket(4, 'high'),
      makeTicket(5, 'medium'),
    ]
    const sorted = [...ts].sort((a, b) => sortByPriority(a, b, 'desc'))
    expect(sorted.map((t) => t.priority)).toEqual(['critical', 'high', 'medium', 'low', null])
  })

  it('asc puts null first then low → critical last', () => {
    const ts = [
      makeTicket(1, 'low'),
      makeTicket(2, 'critical'),
      makeTicket(3, null),
      makeTicket(4, 'high'),
      makeTicket(5, 'medium'),
    ]
    const sorted = [...ts].sort((a, b) => sortByPriority(a, b, 'asc'))
    expect(sorted.map((t) => t.priority)).toEqual([null, 'low', 'medium', 'high', 'critical'])
  })

  it('tiebreaker by id ascending in desc direction', () => {
    const ts = [makeTicket(3, 'high'), makeTicket(1, 'high'), makeTicket(2, 'high')]
    const sorted = [...ts].sort((a, b) => sortByPriority(a, b, 'desc'))
    expect(sorted.map((t) => t.id)).toEqual([1, 2, 3])
  })

  it('tiebreaker by id ascending in asc direction (stable)', () => {
    const ts = [makeTicket(3, 'low'), makeTicket(1, 'low'), makeTicket(2, 'low')]
    const sorted = [...ts].sort((a, b) => sortByPriority(a, b, 'asc'))
    expect(sorted.map((t) => t.id)).toEqual([1, 2, 3])
  })

  it('null bucket placement: nulls last in desc, first in asc', () => {
    const ts = [makeTicket(1, null), makeTicket(2, 'medium'), makeTicket(3, null)]
    const desc = [...ts].sort((a, b) => sortByPriority(a, b, 'desc'))
    expect(desc.map((t) => t.priority)).toEqual(['medium', null, null])
    const asc = [...ts].sort((a, b) => sortByPriority(a, b, 'asc'))
    expect(asc.map((t) => t.priority)).toEqual([null, null, 'medium'])
  })
})

describe('jiraKeyNumber', () => {
  it('extracts the trailing number from a standard key', () => {
    expect(jiraKeyNumber(makeJiraTicket(1, 'PROJ-123'))).toBe(123)
  })
  it('handles keys with digits in the project part', () => {
    expect(jiraKeyNumber(makeJiraTicket(1, 'AB12-7'))).toBe(7)
  })
  it('returns null when jira_key is null/undefined', () => {
    expect(jiraKeyNumber(makeJiraTicket(1, null))).toBeNull()
    expect(jiraKeyNumber(makeTicket(1))).toBeNull()
  })
  it('returns null when the key has no trailing number', () => {
    expect(jiraKeyNumber(makeJiraTicket(1, 'PROJ-'))).toBeNull()
    expect(jiraKeyNumber(makeJiraTicket(1, 'PROJ'))).toBeNull()
  })
  it('rejects numbers beyond MAX_SAFE_INTEGER (no precision loss)', () => {
    expect(jiraKeyNumber(makeJiraTicket(1, 'PROJ-9007199254740993'))).toBeNull()
    expect(jiraKeyNumber(makeJiraTicket(1, 'PROJ-999999999999999999999999'))).toBeNull()
    // The boundary itself is still safe.
    expect(jiraKeyNumber(makeJiraTicket(1, 'PROJ-9007199254740991'))).toBe(9007199254740991)
  })
})

describe('sortByJiraKey', () => {
  it('asc orders by ascending ticket number', () => {
    const ts = [makeJiraTicket(1, 'P-30'), makeJiraTicket(2, 'P-2'), makeJiraTicket(3, 'P-100')]
    const sorted = [...ts].sort((a, b) => sortByJiraKey(a, b, 'asc'))
    expect(sorted.map((t) => t.jira_key)).toEqual(['P-2', 'P-30', 'P-100'])
  })
  it('desc orders by descending ticket number', () => {
    const ts = [makeJiraTicket(1, 'P-30'), makeJiraTicket(2, 'P-2'), makeJiraTicket(3, 'P-100')]
    const sorted = [...ts].sort((a, b) => sortByJiraKey(a, b, 'desc'))
    expect(sorted.map((t) => t.jira_key)).toEqual(['P-100', 'P-30', 'P-2'])
  })
  it('places specs without a jira key LAST in both directions', () => {
    const ts = [makeJiraTicket(1, null), makeJiraTicket(2, 'P-5'), makeJiraTicket(3, null)]
    const asc = [...ts].sort((a, b) => sortByJiraKey(a, b, 'asc'))
    expect(asc.map((t) => t.jira_key)).toEqual(['P-5', null, null])
    const desc = [...ts].sort((a, b) => sortByJiraKey(a, b, 'desc'))
    expect(desc.map((t) => t.jira_key)).toEqual(['P-5', null, null])
  })
  it('tie-breaks keyless specs by id ascending', () => {
    const ts = [makeJiraTicket(3, null), makeJiraTicket(1, null), makeJiraTicket(2, null)]
    const sorted = [...ts].sort((a, b) => sortByJiraKey(a, b, 'desc'))
    expect(sorted.map((t) => t.id)).toEqual([1, 2, 3])
  })
  it('treats unsafe-large keys as keyless (sorted last), preserving transitivity', () => {
    const ts = [
      makeJiraTicket(1, 'P-999999999999999999999999'),
      makeJiraTicket(2, 'P-5'),
      makeJiraTicket(3, 'P-99'),
    ]
    const asc = [...ts].sort((a, b) => sortByJiraKey(a, b, 'asc'))
    expect(asc.map((t) => t.id)).toEqual([2, 3, 1])
  })
})

describe('applySpecSort', () => {
  const tickets = [
    makeTicket(3, 'low'),
    makeTicket(1, 'critical'),
    makeTicket(2, 'medium'),
  ]

  it('mode=default returns input unchanged (same reference)', () => {
    expect(applySpecSort(tickets, 'default', 'desc')).toBe(tickets)
  })

  it('mode=ticket-id sorts by id', () => {
    expect(applySpecSort(tickets, 'ticket-id', 'asc').map((t) => t.id)).toEqual([1, 2, 3])
    expect(applySpecSort(tickets, 'ticket-id', 'desc').map((t) => t.id)).toEqual([3, 2, 1])
  })

  it('mode=priority sorts by bucket', () => {
    expect(applySpecSort(tickets, 'priority', 'desc').map((t) => t.priority)).toEqual([
      'critical',
      'medium',
      'low',
    ])
  })

  it('mode=jira-key sorts by jira ticket number, keyless last', () => {
    const jira = [
      makeJiraTicket(1, 'P-9'),
      makeJiraTicket(2, null),
      makeJiraTicket(3, 'P-1'),
    ]
    expect(applySpecSort(jira, 'jira-key', 'asc').map((t) => t.jira_key)).toEqual([
      'P-1',
      'P-9',
      null,
    ])
    expect(applySpecSort(jira, 'jira-key', 'desc').map((t) => t.jira_key)).toEqual([
      'P-9',
      'P-1',
      null,
    ])
  })

  it('does not mutate input', () => {
    const original = tickets.map((t) => t.id)
    applySpecSort(tickets, 'ticket-id', 'asc')
    expect(tickets.map((t) => t.id)).toEqual(original)
  })
})

describe('loadSpecSort / saveSpecSort', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('returns defaults when no value stored', () => {
    expect(loadSpecSort('p1')).toEqual({ mode: 'default', dir: 'desc' })
  })

  it('returns defaults when projectId is null', () => {
    expect(loadSpecSort(null)).toEqual({ mode: 'default', dir: 'desc' })
  })

  it('round-trips a sorted mode', () => {
    saveSpecSort('p1', 'priority', 'asc')
    expect(loadSpecSort('p1')).toEqual({ mode: 'priority', dir: 'asc' })
  })

  it('round-trips the jira-key mode', () => {
    saveSpecSort('p1', 'jira-key', 'asc')
    expect(loadSpecSort('p1')).toEqual({ mode: 'jira-key', dir: 'asc' })
  })

  it('falls back to default mode on invalid stored value', () => {
    localStorage.setItem('specrails-desktop:spec-sort-mode:p1', 'bogus')
    localStorage.setItem('specrails-desktop:spec-sort-dir:p1', 'asc')
    expect(loadSpecSort('p1')).toEqual({ mode: 'default', dir: 'asc' })
  })

  it('saveSpecSort is a no-op when projectId is null', () => {
    saveSpecSort(null, 'priority', 'asc')
    expect(localStorage.length).toBe(0)
  })

  it('persists each project independently', () => {
    saveSpecSort('p1', 'ticket-id', 'desc')
    saveSpecSort('p2', 'priority', 'asc')
    expect(loadSpecSort('p1')).toEqual({ mode: 'ticket-id', dir: 'desc' })
    expect(loadSpecSort('p2')).toEqual({ mode: 'priority', dir: 'asc' })
  })
})

describe('SMASH children ordering', () => {
  // SMASH inserts children sorted by executionOrder, so their ids are
  // sequential. The default sort preserves insertion order; ticket-id sort
  // (asc) lines them up naturally; the modal's Hijos section handles the
  // canonical execution_order sort independently. These tests guard 9.6.
  function smashChildren(parentId: number, count: number): LocalTicket[] {
    return Array.from({ length: count }, (_, i) => {
      const t = makeTicket(parentId + 1 + i, 'medium')
      t.parent_epic_id = parentId
      t.execution_order = i + 1
      return t
    })
  }

  it('default mode preserves smash insertion order (execution_order alignment)', () => {
    const epic = makeTicket(10)
    epic.is_epic = true
    const tickets = [epic, ...smashChildren(10, 4)]
    const sorted = applySpecSort(tickets, 'default', 'asc')
    expect(sorted.map((t) => t.id)).toEqual([10, 11, 12, 13, 14])
    expect(sorted.slice(1).map((t) => t.execution_order)).toEqual([1, 2, 3, 4])
  })

  it('ticket-id asc keeps smash children contiguous after the épica', () => {
    const epic = makeTicket(10)
    epic.is_epic = true
    const tickets = [...smashChildren(10, 3), epic]
    const sorted = applySpecSort(tickets, 'ticket-id', 'asc')
    expect(sorted.map((t) => t.id)).toEqual([10, 11, 12, 13])
  })
})
