import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { initDb, type DbInstance } from '../db'
import { readStore, resolveTicketStoragePath, type Ticket } from '../ticket-store'
import { getLinkByIssueId, getLinkByLocalId } from './jira-db'
import {
  issueStatusCategory,
  mapStatus,
  mapPriority,
  issueUrl,
  extractEpic,
  extractSprint,
  mapIssueToTicket,
  upsertIssuesIntoStore,
} from './jira-materializer'
import type { JiraConnection, JiraIssue } from './types'

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeConn(overrides: Partial<JiraConnection> = {}): JiraConnection {
  return {
    projectId: 'proj-1',
    baseUrl: 'https://acme.atlassian.net',
    deployment: 'cloud',
    apiVersion: '3',
    authScheme: 'basic',
    accountEmail: 'me@acme.io',
    jiraProjectKey: 'PROJ',
    jiraProjectId: '10000',
    enabled: true,
    statusMap: null,
    highWaterMs: null,
    sprintFieldId: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  }
}

interface IssueOpts {
  id?: string
  key?: string
  summary?: string
  description?: unknown
  labels?: string[]
  updated?: string
  statusName?: string
  statusCategoryKey?: string | undefined
  priorityName?: string | null
  assignee?: { displayName?: string; emailAddress?: string } | null
}

function makeIssue(o: IssueOpts = {}): JiraIssue {
  const status =
    o.statusName === undefined && o.statusCategoryKey === undefined
      ? undefined
      : {
          name: o.statusName ?? 'To Do',
          ...(o.statusCategoryKey === undefined
            ? {}
            : { statusCategory: { key: o.statusCategoryKey } }),
        }
  return {
    id: o.id ?? '100001',
    key: o.key ?? 'PROJ-1',
    fields: {
      summary: o.summary ?? 'A summary',
      description: o.description,
      labels: o.labels,
      updated: o.updated,
      status: status as JiraIssue['fields']['status'],
      priority: o.priorityName === undefined ? undefined : o.priorityName === null ? null : { name: o.priorityName },
      assignee: o.assignee,
    },
  }
}

// ─── Temp project dir + DB harness ───────────────────────────────────────────

let db: DbInstance
let projectPath: string

beforeEach(() => {
  db = initDb(':memory:')
  projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jira-mat-'))
})

afterEach(() => {
  try {
    db.close()
  } catch {
    /* noop */
  }
  try {
    fs.rmSync(projectPath, { recursive: true, force: true })
  } catch {
    /* noop */
  }
})

// ─── issueStatusCategory ─────────────────────────────────────────────────────

describe('issueStatusCategory', () => {
  it('returns new when the category key is new', () => {
    expect(issueStatusCategory(makeIssue({ statusCategoryKey: 'new' }))).toBe('new')
  })

  it('returns done when the category key is done', () => {
    expect(issueStatusCategory(makeIssue({ statusCategoryKey: 'done' }))).toBe('done')
  })

  it('returns indeterminate for an explicit indeterminate key', () => {
    expect(issueStatusCategory(makeIssue({ statusCategoryKey: 'indeterminate' }))).toBe('indeterminate')
  })

  it('falls back to indeterminate for an unknown key', () => {
    expect(issueStatusCategory(makeIssue({ statusCategoryKey: 'something-weird' }))).toBe('indeterminate')
  })

  it('falls back to indeterminate when status / statusCategory are missing', () => {
    expect(issueStatusCategory(makeIssue({}))).toBe('indeterminate')
    expect(issueStatusCategory(makeIssue({ statusName: 'In Review' }))).toBe('indeterminate')
  })
})

// ─── mapStatus ───────────────────────────────────────────────────────────────

describe('mapStatus', () => {
  it('maps new → todo', () => {
    expect(mapStatus(makeIssue({ statusCategoryKey: 'new', statusName: 'Backlog' }))).toBe('todo')
  })

  it('maps indeterminate → in_progress', () => {
    expect(mapStatus(makeIssue({ statusCategoryKey: 'indeterminate', statusName: 'In Progress' }))).toBe('in_progress')
    expect(mapStatus(makeIssue({}))).toBe('in_progress')
  })

  it('maps done → done', () => {
    expect(mapStatus(makeIssue({ statusCategoryKey: 'done', statusName: 'Done' }))).toBe('done')
  })

  it('maps done + cancel-like name → cancelled (Won\'t Do)', () => {
    expect(mapStatus(makeIssue({ statusCategoryKey: 'done', statusName: "Won't Do" }))).toBe('cancelled')
  })

  it.each([
    'Rejected',
    'Cancelled',
    'Canceled',
    'Abandoned',
    'Invalid',
    'Duplicate',
    'Declined',
    'WONT DO',
    'Discarded',
    'Discard',
  ])('maps done + %s → cancelled', (name) => {
    expect(mapStatus(makeIssue({ statusCategoryKey: 'done', statusName: name }))).toBe('cancelled')
  })

  it('does NOT misclassify a done status whose name merely CONTAINS a cancel substring', () => {
    // Whole-word matching: 'invalid' must not flag "Invalidate Cache", 'duplicate'
    // must not flag a status like "Deduplicated" — these are legitimately done.
    expect(mapStatus(makeIssue({ statusCategoryKey: 'done', statusName: 'Invalidate Cache' }))).toBe('done')
    expect(mapStatus(makeIssue({ statusCategoryKey: 'done', statusName: 'Deduplicated' }))).toBe('done')
  })

  it('maps done with no status name → done (no cancel match)', () => {
    // statusCategoryKey present but status.name absent → done branch, empty name.
    const issue = makeIssue({ statusCategoryKey: 'done' })
    // remove the name explicitly to exercise the `?? ''` fallback
    delete (issue.fields.status as { name?: string }).name
    expect(mapStatus(issue)).toBe('done')
  })

  it('preserves on_review when the status NAME matches statusMap.on_review (case-insensitive)', () => {
    const statusMap = { on_review: 'In Review' }
    expect(mapStatus(makeIssue({ statusCategoryKey: 'indeterminate', statusName: 'In Review' }), statusMap)).toBe('on_review')
    expect(mapStatus(makeIssue({ statusCategoryKey: 'indeterminate', statusName: 'IN REVIEW' }), statusMap)).toBe('on_review')
  })

  it('without a configured statusMap.on_review the category fallback is byte-identical', () => {
    expect(mapStatus(makeIssue({ statusCategoryKey: 'indeterminate', statusName: 'In Review' }))).toBe('in_progress')
    expect(mapStatus(makeIssue({ statusCategoryKey: 'indeterminate', statusName: 'In Review' }), null)).toBe('in_progress')
    expect(mapStatus(makeIssue({ statusCategoryKey: 'indeterminate', statusName: 'In Review' }), { done: 'Released' })).toBe('in_progress')
  })

  it('a non-matching name keeps the normal mapping even when on_review is configured', () => {
    const statusMap = { on_review: 'In Review' }
    expect(mapStatus(makeIssue({ statusCategoryKey: 'indeterminate', statusName: 'In Progress' }), statusMap)).toBe('in_progress')
    expect(mapStatus(makeIssue({ statusCategoryKey: 'new', statusName: 'Backlog' }), statusMap)).toBe('todo')
    expect(mapStatus(makeIssue({ statusCategoryKey: 'done', statusName: 'Done' }), statusMap)).toBe('done')
  })
})

// ─── mapPriority ─────────────────────────────────────────────────────────────

describe('mapPriority', () => {
  it.each(['Highest', 'Blocker', 'Critical', 'highest'])('maps %s → critical', (p) => {
    expect(mapPriority(p)).toBe('critical')
  })

  it.each(['High', 'high'])('maps %s → high', (p) => {
    expect(mapPriority(p)).toBe('high')
  })

  it.each(['Low', 'Lowest', 'Trivial', 'Minor', 'low'])('maps %s → low', (p) => {
    expect(mapPriority(p)).toBe('low')
  })

  it('maps Medium / unknown / undefined → medium', () => {
    expect(mapPriority('Medium')).toBe('medium')
    expect(mapPriority('Whatever')).toBe('medium')
    expect(mapPriority(undefined)).toBe('medium')
  })
})

// ─── issueUrl ────────────────────────────────────────────────────────────────

describe('issueUrl', () => {
  it('joins base + /browse/<key>', () => {
    expect(issueUrl('https://acme.atlassian.net', 'PROJ-7')).toBe('https://acme.atlassian.net/browse/PROJ-7')
  })

  it('strips trailing slashes from the base url', () => {
    expect(issueUrl('https://acme.atlassian.net/', 'PROJ-7')).toBe('https://acme.atlassian.net/browse/PROJ-7')
    expect(issueUrl('https://acme.atlassian.net///', 'PROJ-7')).toBe('https://acme.atlassian.net/browse/PROJ-7')
  })
})

// ─── extractEpic ─────────────────────────────────────────────────────────────

describe('extractEpic', () => {
  function withParent(parent: unknown): JiraIssue {
    const i = makeIssue({ id: '900', key: 'PROJ-9' })
    ;(i.fields as Record<string, unknown>).parent = parent
    return i
  }

  it('returns null/null when the issue has no parent', () => {
    expect(extractEpic(makeIssue({}))).toEqual({ key: null, name: null })
  })

  it('captures a parent whose issue type is Epic', () => {
    expect(
      extractEpic(withParent({ key: 'PROJ-1', fields: { summary: 'Big epic', issuetype: { name: 'Epic' } } }))
    ).toEqual({ key: 'PROJ-1', name: 'Big epic' })
  })

  it('ignores a parent that is not an Epic (e.g. a parent story for a subtask)', () => {
    expect(
      extractEpic(withParent({ key: 'PROJ-2', fields: { summary: 'A story', issuetype: { name: 'Story' } } }))
    ).toEqual({ key: null, name: null })
  })

  it('captures the parent when issue type is absent (falls back to the key as name)', () => {
    expect(extractEpic(withParent({ key: 'PROJ-3', fields: {} }))).toEqual({ key: 'PROJ-3', name: 'PROJ-3' })
  })
})

// ─── extractSprint ───────────────────────────────────────────────────────────

describe('extractSprint', () => {
  const FIELD = 'customfield_10020'
  function withSprint(value: unknown): JiraIssue {
    const i = makeIssue({ id: '950', key: 'PROJ-95' })
    ;(i.fields as Record<string, unknown>)[FIELD] = value
    return i
  }

  it('returns null/null when there is no sprint field id', () => {
    expect(extractSprint(withSprint([{ id: 1, name: 'S1', state: 'active' }]), null)).toEqual({ id: null, name: null, state: null })
    expect(extractSprint(withSprint([{ id: 1, name: 'S1' }]), 'none')).toEqual({ id: null, name: null, state: null })
  })

  it('returns null/null when the field is absent or not an array', () => {
    expect(extractSprint(makeIssue({}), FIELD)).toEqual({ id: null, name: null, state: null })
    expect(extractSprint(withSprint('not-an-array'), FIELD)).toEqual({ id: null, name: null, state: null })
    expect(extractSprint(withSprint([]), FIELD)).toEqual({ id: null, name: null, state: null })
  })

  it('prefers the ACTIVE sprint when several are present', () => {
    expect(
      extractSprint(
        withSprint([
          { id: 10, name: 'Past', state: 'closed' },
          { id: 11, name: 'Now', state: 'active' },
          { id: 12, name: 'Next', state: 'future' },
        ]),
        FIELD,
      ),
    ).toEqual({ id: '11', name: 'Now', state: 'active' })
  })

  it('falls back to the last sprint when none is active', () => {
    expect(
      extractSprint(withSprint([{ id: 10, name: 'A', state: 'closed' }, { id: 11, name: 'B', state: 'closed' }]), FIELD),
    ).toEqual({ id: '11', name: 'B', state: 'closed' })
  })

  it('uses the id as the name when name is missing', () => {
    expect(extractSprint(withSprint([{ id: 7 }]), FIELD)).toEqual({ id: '7', name: '7', state: null })
  })

  it('lowercases the active sprint state for the "current" marker', () => {
    expect(extractSprint(withSprint([{ id: 9, name: 'Cur', state: 'ACTIVE' }]), FIELD)).toEqual({
      id: '9', name: 'Cur', state: 'active',
    })
  })
})

// ─── mapIssueToTicket ────────────────────────────────────────────────────────

describe('mapIssueToTicket', () => {
  it('captures the active sprint id + name from the configured field', () => {
    const issue = makeIssue({ id: '960', key: 'PROJ-96' })
    ;(issue.fields as Record<string, unknown>)['customfield_10020'] = [{ id: 42, name: 'Sprint 42', state: 'active' }]
    const t = mapIssueToTicket(issue, 96, makeConn({ sprintFieldId: 'customfield_10020' }))
    expect(t.jira_sprint_id).toBe('42')
    expect(t.jira_sprint_name).toBe('Sprint 42')
  })

  it('captures the parent epic key + name', () => {
    const issue = makeIssue({ id: '777', key: 'PROJ-77' })
    ;(issue.fields as Record<string, unknown>).parent = { key: 'PROJ-5', fields: { summary: 'Epic five', issuetype: { name: 'Epic' } } }
    const t = mapIssueToTicket(issue, 77, makeConn())
    expect(t.jira_epic_key).toBe('PROJ-5')
    expect(t.jira_epic_name).toBe('Epic five')
  })

  it('maps a fresh issue to a jira-sourced ticket', () => {
    const conn = makeConn()
    const issue = makeIssue({
      id: '200',
      key: 'PROJ-42',
      summary: 'Implement widget',
      description: 'Just text',
      labels: ['backend', 'urgent'],
      statusCategoryKey: 'new',
      priorityName: 'High',
      assignee: { displayName: 'Ada Lovelace' },
    })
    const t = mapIssueToTicket(issue, 42, conn)
    expect(t.id).toBe(42)
    expect(t.title).toBe('Implement widget')
    expect(t.description).toBe('Just text')
    expect(t.status).toBe('todo')
    expect(t.priority).toBe('high')
    expect(t.labels).toEqual(['backend', 'urgent'])
    expect(t.assignee).toBe('Ada Lovelace')
    expect(t.source).toBe('jira')
    expect(t.jira_key).toBe('PROJ-42')
    expect(t.jira_url).toBe('https://acme.atlassian.net/browse/PROJ-42')
    expect(t.created_by).toBe('jira')
    // No existing → created_at == updated_at (both `now`)
    expect(t.created_at).toBe(t.updated_at)
    // Defaults for local-only fields
    expect(t.prerequisites).toEqual([])
    expect(t.metadata).toEqual({})
    expect(t.comments).toEqual([])
    expect(t.attachments).toBeUndefined()
    expect(t.origin_conversation_id).toBeNull()
    expect(t.is_epic).toBe(false)
    expect(t.parent_epic_id).toBeNull()
    expect(t.execution_order).toBeNull()
    expect(t.short_summary).toBeNull()
  })

  it('falls back to (key) title and empty labels/description when fields are absent', () => {
    const conn = makeConn()
    const issue = makeIssue({ key: 'PROJ-9', summary: '' })
    issue.fields.labels = undefined
    issue.fields.description = undefined
    const t = mapIssueToTicket(issue, 9, conn)
    expect(t.title).toBe('(PROJ-9)')
    expect(t.description).toBe('')
    expect(t.labels).toEqual([])
    expect(t.priority).toBe('medium') // no priority → medium
    expect(t.assignee).toBeNull()
  })

  it('resolves assignee via emailAddress when displayName is absent', () => {
    const conn = makeConn()
    const issue = makeIssue({ assignee: { emailAddress: 'dev@acme.io' } })
    expect(mapIssueToTicket(issue, 1, conn).assignee).toBe('dev@acme.io')
  })

  it('preserves existing.created_at and other local-only fields', () => {
    const conn = makeConn()
    const existing: Ticket = {
      id: 5,
      title: 'old',
      description: 'old',
      status: 'todo',
      priority: 'low',
      labels: [],
      assignee: null,
      prerequisites: [3, 4],
      metadata: { effort_level: 'L' },
      comments: [{ id: 1, body: 'hi', created_at: 'x', created_by: 'me' }],
      attachments: [
        { id: 'a', filename: 'f', storedName: 's', mimeType: 'text/plain', size: 1, addedAt: 'x' },
      ],
      origin_conversation_id: 'conv-7',
      is_epic: true,
      parent_epic_id: 2,
      execution_order: 9,
      short_summary: 'short',
      created_at: '2020-05-05T05:05:05.000Z',
      updated_at: '2020-05-05T05:05:05.000Z',
      created_by: 'human',
      source: 'manual',
    }
    const issue = makeIssue({ summary: 'new title', statusCategoryKey: 'done' })
    const t = mapIssueToTicket(issue, 5, conn, existing)
    expect(t.created_at).toBe('2020-05-05T05:05:05.000Z')
    expect(t.created_at).not.toBe(t.updated_at) // updated_at is fresh `now`
    expect(t.prerequisites).toEqual([3, 4])
    expect(t.metadata).toEqual({ effort_level: 'L' })
    expect(t.comments).toEqual([{ id: 1, body: 'hi', created_at: 'x', created_by: 'me' }])
    expect(t.attachments).toEqual(existing.attachments)
    expect(t.origin_conversation_id).toBe('conv-7')
    expect(t.is_epic).toBe(true)
    expect(t.parent_epic_id).toBe(2)
    expect(t.execution_order).toBe(9)
    expect(t.short_summary).toBe('short')
    expect(t.created_by).toBe('human') // preserved from existing
    // But Jira-authoritative fields are overwritten:
    expect(t.title).toBe('new title')
    expect(t.status).toBe('done')
    expect(t.source).toBe('jira')
  })
})

// ─── upsertIssuesIntoStore ───────────────────────────────────────────────────

describe('upsertIssuesIntoStore', () => {
  const conn = () => makeConn()
  const storePath = () => resolveTicketStoragePath(projectPath)

  it('inserts new tickets, mints links and bumps next_id (no collision)', () => {
    const issues = [
      makeIssue({ id: '900', key: 'PROJ-1', summary: 'One', statusCategoryKey: 'new', updated: '2024-03-01T00:00:00.000Z' }),
      makeIssue({ id: '901', key: 'PROJ-2', summary: 'Two', statusCategoryKey: 'done', updated: '2024-03-02T00:00:00.000Z' }),
    ]
    const result = upsertIssuesIntoStore(db, projectPath, conn(), issues)

    expect(result.upserted).toBe(2)
    expect(result.changedLocalIds).toHaveLength(2)

    const store = readStore(storePath())
    // Each Jira ticket got a local id == its minted link local id.
    for (const localId of result.changedLocalIds) {
      const t = store.tickets[String(localId)]
      expect(t).toBeDefined()
      expect(t.source).toBe('jira')
    }
    // Links exist for both issues.
    const link1 = getLinkByIssueId(db, '900')
    const link2 = getLinkByIssueId(db, '901')
    expect(link1).not.toBeNull()
    expect(link2).not.toBeNull()
    // next_id is bumped past the highest minted local id so a future local spec
    // never collides with a Jira #id.
    const maxLocal = Math.max(link1!.localId, link2!.localId)
    expect(store.next_id).toBe(maxLocal + 1)
    // status_category persisted on the links.
    expect(link1!.statusCategory).toBe('new')
    expect(link2!.statusCategory).toBe('done')
  })

  it('mints local ids from the UNION of store.next_id and jira_links max (no collision with local specs)', () => {
    // Seed the store with a local spec occupying #1 and next_id=2.
    const sp = storePath()
    fs.mkdirSync(path.dirname(sp), { recursive: true })
    const seeded = {
      schema_version: '1.3',
      revision: 1,
      last_updated: '2024-01-01T00:00:00.000Z',
      next_id: 5,
      tickets: {
        '1': {
          id: 1,
          title: 'local spec',
          description: '',
          status: 'todo',
          priority: 'medium',
          labels: [],
          assignee: null,
          prerequisites: [],
          metadata: {},
          comments: [],
          origin_conversation_id: null,
          is_epic: false,
          parent_epic_id: null,
          execution_order: null,
          short_summary: null,
          created_at: '2024-01-01T00:00:00.000Z',
          updated_at: '2024-01-01T00:00:00.000Z',
          created_by: 'human',
          source: 'manual',
        },
      },
    }
    fs.writeFileSync(sp, JSON.stringify(seeded), 'utf-8')

    const result = upsertIssuesIntoStore(db, projectPath, conn(), [
      makeIssue({ id: '700', key: 'PROJ-1', summary: 'jira one' }),
    ])
    const link = getLinkByIssueId(db, '700')!
    // store.next_id was 5, jira_links was empty (max 0 → 1), so localId = max(5,1) = 5.
    expect(link.localId).toBe(5)
    expect(result.changedLocalIds).toEqual([5])

    const store = readStore(sp)
    // The pre-existing local spec #1 is untouched (surgical merge).
    expect(store.tickets['1'].source).toBe('manual')
    expect(store.tickets['1'].title).toBe('local spec')
    // The Jira ticket lives at #5 and next_id moved to 6.
    expect(store.tickets['5'].source).toBe('jira')
    expect(store.next_id).toBe(6)
  })

  it('does not bump next_id when minted local id is below the existing next_id (link max wins)', () => {
    // Pre-create a link at local_id 10 by upserting an issue once, then add a
    // second issue: its minted id should come from max(next_id, links_max+1).
    upsertIssuesIntoStore(db, projectPath, conn(), [makeIssue({ id: '1', key: 'PROJ-1' })])
    const store1 = readStore(storePath())
    const firstNext = store1.next_id

    upsertIssuesIntoStore(db, projectPath, conn(), [makeIssue({ id: '2', key: 'PROJ-2' })])
    const link2 = getLinkByIssueId(db, '2')!
    const store2 = readStore(storePath())
    // Second link got an id and next_id advanced past it.
    expect(store2.next_id).toBe(link2.localId + 1)
    expect(store2.next_id).toBeGreaterThan(firstNext)
  })

  it('updates an existing ticket in place on a re-poll (idempotent on issue id)', () => {
    const c = conn()
    upsertIssuesIntoStore(db, projectPath, c, [
      makeIssue({ id: '500', key: 'PROJ-1', summary: 'first', statusCategoryKey: 'new' }),
    ])
    const link = getLinkByIssueId(db, '500')!
    const localId = link.localId

    // Re-poll with a changed summary/status; same issue id → same local id, no new link.
    upsertIssuesIntoStore(db, projectPath, c, [
      makeIssue({ id: '500', key: 'PROJ-1', summary: 'second', statusCategoryKey: 'done', statusName: 'Done' }),
    ])
    const store = readStore(storePath())
    expect(Object.keys(store.tickets)).toHaveLength(1)
    expect(store.tickets[String(localId)].title).toBe('second')
    expect(store.tickets[String(localId)].status).toBe('done')
    // Still only one link for issue 500.
    expect(getLinkByLocalId(db, localId)!.jiraIssueId).toBe('500')
  })

  it('preserves status (and existing priority) for frozenLocalIds', () => {
    const c = conn()
    // First poll: issue is "todo".
    upsertIssuesIntoStore(db, projectPath, c, [
      makeIssue({ id: '600', key: 'PROJ-1', statusCategoryKey: 'new', priorityName: 'Low' }),
    ])
    const localId = getLinkByIssueId(db, '600')!.localId

    // Second poll: Jira now says "done", but the id is frozen (pending outbox op),
    // so the locally-authoritative status must survive.
    const result = upsertIssuesIntoStore(
      db,
      projectPath,
      c,
      [makeIssue({ id: '600', key: 'PROJ-1', statusCategoryKey: 'done', statusName: 'Done', priorityName: 'High' })],
      new Set([localId])
    )
    const store = readStore(storePath())
    expect(store.tickets[String(localId)].status).toBe('todo') // preserved, NOT done
    // existing priority (low) preserved over the inbound high
    expect(store.tickets[String(localId)].priority).toBe('low')
    // Frozen + everything else identical ⇒ no actual change ⇒ no write/broadcast.
    expect(result.changedLocalIds).toEqual([])
    expect(result.wrote).toBe(false)
  })

  it('frozen flag has no effect when the ticket does not yet exist (first insert)', () => {
    const c = conn()
    // local id 1 is frozen but there is no existing ticket → status comes from Jira.
    upsertIssuesIntoStore(
      db,
      projectPath,
      c,
      [makeIssue({ id: '601', key: 'PROJ-1', statusCategoryKey: 'done', statusName: 'Done' })],
      new Set([1])
    )
    const localId = getLinkByIssueId(db, '601')!.localId
    const store = readStore(storePath())
    expect(store.tickets[String(localId)].status).toBe('done')
  })

  it('materializes an issue sitting on the mapped on_review status as on_review', () => {
    const c = makeConn({ statusMap: { on_review: 'In Review' } })
    upsertIssuesIntoStore(db, projectPath, c, [
      makeIssue({ id: '620', key: 'PROJ-620', statusCategoryKey: 'indeterminate', statusName: 'In Review' }),
    ])
    const localId = getLinkByIssueId(db, '620')!.localId
    expect(readStore(storePath()).tickets[String(localId)].status).toBe('on_review')
  })

  it('does NOT revert a local on_review after the outbox op drains (no longer frozen)', () => {
    // The frozen guard only protects the pending window. Once the on_review
    // transition drains, the next poll re-maps the issue — with the conn-aware
    // mapStatus, an issue parked on the mapped "In Review" status stays
    // on_review instead of flattening to category-indeterminate in_progress.
    const c = makeConn({ statusMap: { on_review: 'In Review' } })
    // First poll: issue already moved to In Review by the drained transition.
    upsertIssuesIntoStore(db, projectPath, c, [
      makeIssue({ id: '621', key: 'PROJ-621', statusCategoryKey: 'indeterminate', statusName: 'In Review' }),
    ])
    const localId = getLinkByIssueId(db, '621')!.localId

    // Second poll, UNFROZEN (empty set): identical inbound content must neither
    // change the status nor write the store at all.
    const result = upsertIssuesIntoStore(
      db,
      projectPath,
      c,
      [makeIssue({ id: '621', key: 'PROJ-621', statusCategoryKey: 'indeterminate', statusName: 'In Review' })],
      new Set()
    )
    expect(readStore(storePath()).tickets[String(localId)].status).toBe('on_review')
    expect(result.changedLocalIds).toEqual([])
    expect(result.wrote).toBe(false)
  })

  it('frozen guard still preserves a local on_review while the transition is pending in Jira', () => {
    // Jira has not applied the transition yet (issue still "In Progress"), but the
    // outbox op is pending → the id is frozen and the local on_review survives.
    const c = makeConn({ statusMap: { on_review: 'In Review' } })
    upsertIssuesIntoStore(db, projectPath, c, [
      makeIssue({ id: '622', key: 'PROJ-622', statusCategoryKey: 'indeterminate', statusName: 'In Review' }),
    ])
    const localId = getLinkByIssueId(db, '622')!.localId
    expect(readStore(storePath()).tickets[String(localId)].status).toBe('on_review')

    const result = upsertIssuesIntoStore(
      db,
      projectPath,
      c,
      [makeIssue({ id: '622', key: 'PROJ-622', statusCategoryKey: 'indeterminate', statusName: 'In Progress' })],
      new Set([localId])
    )
    expect(readStore(storePath()).tickets[String(localId)].status).toBe('on_review')
    expect(result.changedLocalIds).toEqual([])
    expect(result.wrote).toBe(false)
  })

  it('unconfigured statusMap.on_review keeps inbound indeterminate → in_progress (legacy)', () => {
    const c = conn() // statusMap: null
    upsertIssuesIntoStore(db, projectPath, c, [
      makeIssue({ id: '623', key: 'PROJ-623', statusCategoryKey: 'indeterminate', statusName: 'In Review' }),
    ])
    const localId = getLinkByIssueId(db, '623')!.localId
    expect(readStore(storePath()).tickets[String(localId)].status).toBe('in_progress')
  })

  it('refreshes the display key when the issue key changes (link keyed on immutable id)', () => {
    const c = conn()
    upsertIssuesIntoStore(db, projectPath, c, [makeIssue({ id: '777', key: 'OLD-1' })])
    expect(getLinkByIssueId(db, '777')!.jiraKey).toBe('OLD-1')

    // Issue moved project → new key, same immutable id.
    upsertIssuesIntoStore(db, projectPath, c, [makeIssue({ id: '777', key: 'NEW-9' })])
    const link = getLinkByIssueId(db, '777')!
    expect(link.jiraKey).toBe('NEW-9')
    const store = readStore(storePath())
    expect(store.tickets[String(link.localId)].jira_key).toBe('NEW-9')
    expect(store.tickets[String(link.localId)].jira_url).toBe('https://acme.atlassian.net/browse/NEW-9')
  })

  it('does not rewrite the key when it is unchanged or empty', () => {
    const c = conn()
    upsertIssuesIntoStore(db, projectPath, c, [makeIssue({ id: '778', key: 'SAME-1' })])
    const updatedBefore = getLinkByIssueId(db, '778')!.updatedAt

    // Same key → no UPDATE branch.
    upsertIssuesIntoStore(db, projectPath, c, [makeIssue({ id: '778', key: 'SAME-1' })])
    const link = getLinkByIssueId(db, '778')!
    expect(link.jiraKey).toBe('SAME-1')
    // sanity: still a valid timestamp string
    expect(typeof updatedBefore).toBe('string')
  })

  it('returns maxUpdatedMs derived from the Jira `updated` timestamps', () => {
    const c = conn()
    const result = upsertIssuesIntoStore(db, projectPath, c, [
      makeIssue({ id: '1', key: 'PROJ-1', updated: '2024-05-01T00:00:00.000Z' }),
      makeIssue({ id: '2', key: 'PROJ-2', updated: '2024-06-15T12:30:00.000Z' }),
      makeIssue({ id: '3', key: 'PROJ-3', updated: '2024-04-01T00:00:00.000Z' }),
    ])
    expect(result.maxUpdatedMs).toBe(Date.parse('2024-06-15T12:30:00.000Z'))
  })

  it('seeds maxUpdatedMs from conn.highWaterMs and never regresses below it', () => {
    const high = Date.parse('2025-01-01T00:00:00.000Z')
    const c = makeConn({ highWaterMs: high })
    const result = upsertIssuesIntoStore(db, projectPath, c, [
      makeIssue({ id: '1', key: 'PROJ-1', updated: '2024-06-15T12:30:00.000Z' }),
    ])
    // Jira's update is older than the high-water mark → stays at high water.
    expect(result.maxUpdatedMs).toBe(high)
  })

  it('treats a missing or invalid `updated` as 0 and starts from the (0) high water', () => {
    const c = conn() // highWaterMs null → 0
    const result = upsertIssuesIntoStore(db, projectPath, c, [
      makeIssue({ id: '1', key: 'PROJ-1' }), // no updated
    ])
    expect(result.maxUpdatedMs).toBe(0)
  })

  it('ignores an unparseable `updated` (NaN guard) and keeps the high water', () => {
    const high = Date.parse('2024-02-02T00:00:00.000Z')
    const c = makeConn({ highWaterMs: high })
    const result = upsertIssuesIntoStore(db, projectPath, c, [
      makeIssue({ id: '1', key: 'PROJ-1', updated: 'not-a-date' }),
    ])
    expect(result.maxUpdatedMs).toBe(high)
  })

  it('handles an empty issue batch (no writes, no link, high water preserved)', () => {
    const high = 123456
    const c = makeConn({ highWaterMs: high })
    const result = upsertIssuesIntoStore(db, projectPath, c, [])
    expect(result).toMatchObject({ changedLocalIds: [], maxUpdatedMs: high, upserted: 0, wrote: false })
    const store = readStore(storePath())
    expect(Object.keys(store.tickets)).toHaveLength(0)
  })
})

// ─── upsertIssuesIntoStore — change detection (B) ────────────────────────────

describe('upsertIssuesIntoStore — change detection (B)', () => {
  const conn = () => makeConn()
  const storePath = () => resolveTicketStoragePath(projectPath)

  it('first materialize of a new issue writes, reports the id, and bumps the revision', () => {
    // The store does not exist yet → an empty store reads at revision 0.
    const emptyRevision = readStore(storePath()).revision
    expect(emptyRevision).toBe(0)

    const result = upsertIssuesIntoStore(db, projectPath, conn(), [
      makeIssue({ id: '800', key: 'PROJ-1', summary: 'New issue', statusCategoryKey: 'new' }),
    ])
    const localId = getLinkByIssueId(db, '800')!.localId

    expect(result.wrote).toBe(true)
    expect(result.changedLocalIds).toEqual([localId])

    const store = readStore(storePath())
    expect(store.revision).toBe(result.revision)
    expect(store.revision).toBeGreaterThan(emptyRevision)
  })

  it('re-materializing the SAME unchanged issue is a no-op (no write, no revision bump, updated_at preserved)', () => {
    const c = conn()
    const issue = makeIssue({ id: '801', key: 'PROJ-1', summary: 'Stable', statusCategoryKey: 'new' })
    const first = upsertIssuesIntoStore(db, projectPath, c, [issue])
    const localId = getLinkByIssueId(db, '801')!.localId

    const before = readStore(storePath())
    const updatedAtBefore = before.tickets[String(localId)].updated_at

    // Identical issue (same id/key/summary/status) → nothing changes.
    const result = upsertIssuesIntoStore(db, projectPath, c, [
      makeIssue({ id: '801', key: 'PROJ-1', summary: 'Stable', statusCategoryKey: 'new' }),
    ])

    expect(result.wrote).toBe(false)
    expect(result.changedLocalIds).toEqual([])
    // Revision is returned unchanged AND the on-disk store was not rewritten.
    expect(result.revision).toBe(first.revision)
    expect(result.revision).toBe(before.revision)

    const after = readStore(storePath())
    expect(after.revision).toBe(before.revision)
    // The ticket's updated_at is NOT bumped — the row was left exactly as-is.
    expect(after.tickets[String(localId)].updated_at).toBe(updatedAtBefore)
  })

  it('re-materializing with a real change writes and reports the id', () => {
    const c = conn()
    upsertIssuesIntoStore(db, projectPath, c, [
      makeIssue({ id: '802', key: 'PROJ-1', summary: 'Before', statusCategoryKey: 'new' }),
    ])
    const localId = getLinkByIssueId(db, '802')!.localId

    // New summary + status → a genuine content change.
    const result = upsertIssuesIntoStore(db, projectPath, c, [
      makeIssue({ id: '802', key: 'PROJ-1', summary: 'After', statusCategoryKey: 'done', statusName: 'Done' }),
    ])

    expect(result.wrote).toBe(true)
    expect(result.changedLocalIds).toEqual([localId])

    const store = readStore(storePath())
    expect(store.tickets[String(localId)].title).toBe('After')
    expect(store.tickets[String(localId)].status).toBe('done')
  })

  it('a batch where only ONE issue changed reports only that id', () => {
    const c = conn()
    upsertIssuesIntoStore(db, projectPath, c, [
      makeIssue({ id: '810', key: 'PROJ-1', summary: 'One', statusCategoryKey: 'new' }),
      makeIssue({ id: '811', key: 'PROJ-2', summary: 'Two', statusCategoryKey: 'new' }),
      makeIssue({ id: '812', key: 'PROJ-3', summary: 'Three', statusCategoryKey: 'new' }),
    ])
    const changedLocalId = getLinkByIssueId(db, '811')!.localId

    // Re-poll: only issue 811's summary changed; 810 and 812 are byte-identical.
    const result = upsertIssuesIntoStore(db, projectPath, c, [
      makeIssue({ id: '810', key: 'PROJ-1', summary: 'One', statusCategoryKey: 'new' }),
      makeIssue({ id: '811', key: 'PROJ-2', summary: 'Two (edited)', statusCategoryKey: 'new' }),
      makeIssue({ id: '812', key: 'PROJ-3', summary: 'Three', statusCategoryKey: 'new' }),
    ])

    expect(result.wrote).toBe(true)
    expect(result.changedLocalIds).toEqual([changedLocalId])

    const store = readStore(storePath())
    expect(store.tickets[String(changedLocalId)].title).toBe('Two (edited)')
  })

  it('advances maxUpdatedMs even when nothing was written (newer timestamp, identical content)', () => {
    const c = conn()
    upsertIssuesIntoStore(db, projectPath, c, [
      makeIssue({ id: '820', key: 'PROJ-1', summary: 'Stable', statusCategoryKey: 'new', updated: '2024-01-01T00:00:00.000Z' }),
    ])

    // Same content but a newer Jira `updated` than the high water (still 0/old).
    const newer = '2024-09-09T09:09:09.000Z'
    const result = upsertIssuesIntoStore(db, projectPath, c, [
      makeIssue({ id: '820', key: 'PROJ-1', summary: 'Stable', statusCategoryKey: 'new', updated: newer }),
    ])

    // No content change → no write …
    expect(result.wrote).toBe(false)
    expect(result.changedLocalIds).toEqual([])
    // … but the high-water mark still advances to the newer Jira timestamp.
    expect(result.maxUpdatedMs).toBe(Date.parse(newer))
  })
})

// ─── Raw Jira workflow status (jira_status) ──────────────────────────────────
// The board's Jira-status filter dimension needs the RAW status name (e.g.
// "Code Review") persisted per ticket, not just the mapped logical state.

describe('raw jira_status persistence', () => {
  const conn = () => makeConn()
  const storePath = () => resolveTicketStoragePath(projectPath)

  it('mapIssueToTicket captures the raw status name verbatim', () => {
    const issue = makeIssue({ statusName: 'Code Review', statusCategoryKey: 'indeterminate' })
    const t = mapIssueToTicket(issue, 1, conn())
    expect(t.jira_status).toBe('Code Review')
    expect(t.status).toBe('in_progress') // mapped logical state is separate
  })

  it('mapIssueToTicket sets jira_status null when the issue carries no status', () => {
    const issue = makeIssue({}) // no statusName / no category → fields.status undefined
    expect(issue.fields.status).toBeUndefined()
    expect(mapIssueToTicket(issue, 1, conn()).jira_status).toBeNull()
  })

  it('a raw-status-only move (same logical category) still writes + reports the id', () => {
    const c = conn()
    upsertIssuesIntoStore(db, projectPath, c, [
      makeIssue({ id: '830', key: 'PROJ-1', summary: 'S', statusName: 'In Progress', statusCategoryKey: 'indeterminate' }),
    ])
    const localId = getLinkByIssueId(db, '830')!.localId

    // "In Progress" → "Code Review": both indeterminate ⇒ logical status is
    // unchanged (in_progress), but the RAW name changed → must write so the
    // Jira-status filter counts stay live.
    const result = upsertIssuesIntoStore(db, projectPath, c, [
      makeIssue({ id: '830', key: 'PROJ-1', summary: 'S', statusName: 'Code Review', statusCategoryKey: 'indeterminate' }),
    ])
    expect(result.wrote).toBe(true)
    expect(result.changedLocalIds).toEqual([localId])

    const t = readStore(storePath()).tickets[String(localId)]
    expect(t.jira_status).toBe('Code Review')
    expect(t.status).toBe('in_progress')
  })

  it('jira_status is frozen WITH the logical status for pending-outbox ids (no write)', () => {
    const c = conn()
    upsertIssuesIntoStore(db, projectPath, c, [
      makeIssue({ id: '831', key: 'PROJ-2', summary: 'F', statusName: 'To Do', statusCategoryKey: 'new' }),
    ])
    const localId = getLinkByIssueId(db, '831')!.localId

    // Inbound says the issue moved to "Done" but the id is frozen (pending
    // outbox op): BOTH the logical status and the raw name are preserved so
    // the pair never disagrees mid-window — and no write/flicker happens. The
    // high-water does not advance past frozen issues, so the raw change is
    // re-applied on the first poll after the op drains.
    const result = upsertIssuesIntoStore(
      db,
      projectPath,
      c,
      [makeIssue({ id: '831', key: 'PROJ-2', summary: 'F', statusName: 'Done', statusCategoryKey: 'done' })],
      new Set([localId])
    )
    expect(result.wrote).toBe(false)
    expect(result.changedLocalIds).toEqual([])

    const t = readStore(storePath()).tickets[String(localId)]
    expect(t.status).toBe('todo') // frozen guard held
    expect(t.jira_status).toBe('To Do') // raw name frozen alongside

    // Unfrozen next poll → both refresh.
    const after = upsertIssuesIntoStore(db, projectPath, c, [
      makeIssue({ id: '831', key: 'PROJ-2', summary: 'F', statusName: 'Done', statusCategoryKey: 'done' }),
    ])
    expect(after.wrote).toBe(true)
    const t2 = readStore(storePath()).tickets[String(localId)]
    expect(t2.status).toBe('done')
    expect(t2.jira_status).toBe('Done')
  })
})


describe('project-owned repository scope', () => {
  it('retains repository selections and local IDs when Jira overwrites issue-owned fields', () => {
    const existing = mapIssueToTicket(makeIssue(), 7, makeConn())
    existing.repositoryIds = ['primary-proj-1', 'api']
    const next = mapIssueToTicket(makeIssue({ summary: 'Updated in Jira' }), 7, makeConn(), existing)
    expect(next.id).toBe(7)
    expect(next.title).toBe('Updated in Jira')
    expect(next.repositoryIds).toEqual(existing.repositoryIds)
    expect(next.repositoryIds).not.toBe(existing.repositoryIds)
    expect(mapIssueToTicket(makeIssue(), 8, makeConn()).repositoryIds).toBeUndefined()
  })
})
