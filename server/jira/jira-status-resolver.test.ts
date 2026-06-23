import { describe, it, expect, vi } from 'vitest'
import {
  targetCategoryFor,
  categoryRank,
  pickDirectTransition,
  pickProgressTransition,
  buildTransitionFields,
  walkToCategory,
  type TransitionFieldPlan,
} from './jira-status-resolver'
import type { JiraTransition, JiraStatusCategory, JiraTransitionField } from './types'

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function tx(opts: {
  id?: string
  name?: string
  toId: string
  toName: string
  category?: JiraStatusCategory | string | null
  fields?: Record<string, JiraTransitionField>
  hasScreen?: boolean
}): JiraTransition {
  const t: JiraTransition = {
    id: opts.id ?? `tr-${opts.toId}`,
    name: opts.name ?? `Go ${opts.toName}`,
    to: {
      id: opts.toId,
      name: opts.toName,
      ...(opts.category === null
        ? {}
        : opts.category === undefined
          ? {}
          : { statusCategory: { key: String(opts.category) } }),
    },
  }
  if (opts.hasScreen !== undefined) t.hasScreen = opts.hasScreen
  if (opts.fields) t.fields = opts.fields
  return t
}

function field(opts: Partial<JiraTransitionField>): JiraTransitionField {
  return {
    required: opts.required ?? false,
    ...(opts.hasDefaultValue !== undefined ? { hasDefaultValue: opts.hasDefaultValue } : {}),
    ...(opts.name !== undefined ? { name: opts.name } : {}),
    ...(opts.allowedValues !== undefined ? { allowedValues: opts.allowedValues } : {}),
    ...(opts.schema !== undefined ? { schema: opts.schema } : {}),
  }
}

// ---------------------------------------------------------------------------
// targetCategoryFor
// ---------------------------------------------------------------------------

describe('targetCategoryFor', () => {
  it('maps todo → new', () => {
    expect(targetCategoryFor('todo')).toBe('new')
  })
  it('maps in_progress → indeterminate', () => {
    expect(targetCategoryFor('in_progress')).toBe('indeterminate')
  })
  it('maps done → done', () => {
    expect(targetCategoryFor('done')).toBe('done')
  })
  it('maps cancelled → done', () => {
    expect(targetCategoryFor('cancelled')).toBe('done')
  })
})

// ---------------------------------------------------------------------------
// categoryRank
// ---------------------------------------------------------------------------

describe('categoryRank', () => {
  it('ranks new = 0', () => {
    expect(categoryRank('new')).toBe(0)
  })
  it('ranks indeterminate = 1', () => {
    expect(categoryRank('indeterminate')).toBe(1)
  })
  it('ranks done = 2', () => {
    expect(categoryRank('done')).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// pickDirectTransition
// ---------------------------------------------------------------------------

describe('pickDirectTransition', () => {
  it('returns null on empty list', () => {
    expect(pickDirectTransition([], 'todo')).toBeNull()
  })

  it('explicit target matches by to.id', () => {
    const transitions = [
      tx({ id: 'tA', toId: 's-new', toName: 'New', category: 'new' }),
      tx({ id: 'tB', toId: 's-prog', toName: 'In Progress', category: 'indeterminate' }),
    ]
    const got = pickDirectTransition(transitions, 'todo', 's-prog')
    expect(got).not.toBeNull()
    expect(got!.id).toBe('tB')
  })

  it('explicit target matches by to.name case-insensitively', () => {
    const transitions = [
      tx({ id: 'tA', toId: 's-new', toName: 'New', category: 'new' }),
      tx({ id: 'tB', toId: 's-prog', toName: 'In Progress', category: 'indeterminate' }),
    ]
    const got = pickDirectTransition(transitions, 'todo', 'in progress')
    expect(got!.id).toBe('tB')
  })

  it('explicit target matches by transition id', () => {
    const transitions = [
      tx({ id: 'tA', toId: 's-new', toName: 'New', category: 'new' }),
      tx({ id: 'tB', toId: 's-prog', toName: 'In Progress', category: 'indeterminate' }),
    ]
    const got = pickDirectTransition(transitions, 'todo', 'tB')
    expect(got!.id).toBe('tB')
  })

  it('explicit target that does not match returns null (never substitutes another status)', () => {
    const transitions = [
      tx({ id: 'tA', toId: 's-new', toName: 'New', category: 'new' }),
      tx({ id: 'tB', toId: 's-prog', toName: 'In Progress', category: 'indeterminate' }),
    ]
    // An explicit configured target that isn't directly reachable must NOT be
    // silently swapped for a category candidate — the walker should step forward
    // and look for the real target instead. Returning null signals "no direct".
    const got = pickDirectTransition(transitions, 'todo', 'nonexistent')
    expect(got).toBeNull()
  })

  it('category match for non-done target returns first candidate', () => {
    const transitions = [
      tx({ id: 'tA', toId: 's-new', toName: 'New', category: 'new' }),
      tx({ id: 'tB', toId: 's-prog1', toName: 'In Progress', category: 'indeterminate' }),
      tx({ id: 'tC', toId: 's-prog2', toName: 'Reviewing', category: 'indeterminate' }),
    ]
    const got = pickDirectTransition(transitions, 'in_progress')
    expect(got!.id).toBe('tB')
  })

  it('returns null when no transition lands in the target category', () => {
    const transitions = [
      tx({ id: 'tA', toId: 's-new', toName: 'New', category: 'new' }),
      tx({ id: 'tB', toId: 's-prog', toName: 'In Progress', category: 'indeterminate' }),
    ]
    // target = done, no done-category transitions
    expect(pickDirectTransition(transitions, 'done')).toBeNull()
  })

  it('ignores transitions with unknown statusCategory key', () => {
    const transitions = [
      tx({ id: 'tA', toId: 's-x', toName: 'Weird', category: 'bogus' }),
      tx({ id: 'tB', toId: 's-new', toName: 'New', category: 'new' }),
    ]
    const got = pickDirectTransition(transitions, 'todo')
    expect(got!.id).toBe('tB')
  })

  it('ignores transitions with missing statusCategory', () => {
    const transitions = [
      tx({ id: 'tA', toId: 's-x', toName: 'NoCat', category: null }),
      tx({ id: 'tB', toId: 's-new', toName: 'New', category: 'new' }),
    ]
    const got = pickDirectTransition(transitions, 'todo')
    expect(got!.id).toBe('tB')
  })

  describe('done category disambiguation — success (done state)', () => {
    it('prefers a ship-lexicon transition over a generic done', () => {
      const transitions = [
        tx({ id: 'tCancel', toId: 's-wont', toName: "Won't Do", category: 'done' }),
        tx({ id: 'tShip', toId: 's-released', toName: 'Released', category: 'done' }),
      ]
      const got = pickDirectTransition(transitions, 'done')
      expect(got!.id).toBe('tShip')
    })

    it('does not pick a ship word that is also a cancel word', () => {
      // 'duplicate' is cancel-lexicon; no ship candidate that is not cancel
      const transitions = [
        tx({ id: 'tDup', toId: 's-dup', toName: 'Duplicate Done', category: 'done' }),
        tx({ id: 'tPlain', toId: 's-plain', toName: 'Finished', category: 'done' }),
      ]
      // 'Finished' is not in ship lexicon, 'Duplicate Done' contains 'done' (ship) AND 'duplicate' (cancel) so excluded.
      // ship find fails → nonCancel: 'Finished' is non-cancel → tPlain
      const got = pickDirectTransition(transitions, 'done')
      expect(got!.id).toBe('tPlain')
    })

    it('falls back to nonCancel candidate when no ship word present', () => {
      const transitions = [
        tx({ id: 'tCancel', toId: 's-rej', toName: 'Rejected', category: 'done' }),
        tx({ id: 'tNeutral', toId: 's-neutral', toName: 'Archived', category: 'done' }),
      ]
      // No ship word; nonCancel = 'Archived'
      const got = pickDirectTransition(transitions, 'done')
      expect(got!.id).toBe('tNeutral')
    })

    it('returns null when every done candidate is a reject status (never auto-ship to a reject)', () => {
      const transitions = [
        tx({ id: 'tCancel1', toId: 's-rej', toName: 'Rejected', category: 'done' }),
        tx({ id: 'tCancel2', toId: 's-inv', toName: 'Invalid', category: 'done' }),
      ]
      // No ship, no nonCancel → null (a successful job must not be marked rejected).
      const got = pickDirectTransition(transitions, 'done')
      expect(got).toBeNull()
    })

    it('picks the ship transition when only a generic Done exists', () => {
      const transitions = [tx({ id: 'tDone', toId: 's-done', toName: 'Done', category: 'done' })]
      const got = pickDirectTransition(transitions, 'done')
      expect(got!.id).toBe('tDone')
    })

    it('picks "On Review" over "Discarded" for a successful done (the reported bug)', () => {
      // Both are done-category and neither carries a ship word. "Discarded" is a
      // reject status, so the success path must skip it and land on "On Review".
      const transitions = [
        tx({ id: 'tDiscard', toId: 's-disc', toName: 'Discarded', category: 'done' }),
        tx({ id: 'tReview', toId: 's-rev', toName: 'On Review', category: 'done' }),
      ]
      const got = pickDirectTransition(transitions, 'done')
      expect(got!.id).toBe('tReview')
    })

    it('returns null when the only done transition is "Discarded"', () => {
      const transitions = [tx({ id: 'tDiscard', toId: 's-disc', toName: 'Discarded', category: 'done' })]
      const got = pickDirectTransition(transitions, 'done')
      expect(got).toBeNull()
    })

    it('honors an explicit "On Review" target even when a Discarded edge is present', () => {
      const transitions = [
        tx({ id: 'tDiscard', toId: 's-disc', toName: 'Discarded', category: 'done' }),
        tx({ id: 'tReview', toId: 's-rev', toName: 'On Review', category: 'done' }),
      ]
      const got = pickDirectTransition(transitions, 'done', 'On Review')
      expect(got!.id).toBe('tReview')
    })
  })

  describe('done category disambiguation — discard recognised as a reject', () => {
    it('selects "Discarded" for a cancelled spec', () => {
      const transitions = [
        tx({ id: 'tShip', toId: 's-released', toName: 'Released', category: 'done' }),
        tx({ id: 'tDiscard', toId: 's-disc', toName: 'Discarded', category: 'done' }),
      ]
      const got = pickDirectTransition(transitions, 'cancelled')
      expect(got!.id).toBe('tDiscard')
    })
  })

  describe('done category disambiguation — cancelled state', () => {
    it('prefers the cancel-lexicon transition', () => {
      const transitions = [
        tx({ id: 'tShip', toId: 's-released', toName: 'Released', category: 'done' }),
        tx({ id: 'tCancel', toId: 's-wont', toName: "Won't Do", category: 'done' }),
      ]
      const got = pickDirectTransition(transitions, 'cancelled')
      expect(got!.id).toBe('tCancel')
    })

    it('returns null when only a generic Done exists (no cancel status)', () => {
      const transitions = [tx({ id: 'tDone', toId: 's-done', toName: 'Done', category: 'done' })]
      const got = pickDirectTransition(transitions, 'cancelled')
      expect(got).toBeNull()
    })

    it('returns null when only ship statuses exist for cancelled', () => {
      const transitions = [
        tx({ id: 'tShip', toId: 's-released', toName: 'Released', category: 'done' }),
        tx({ id: 'tDone', toId: 's-done', toName: 'Closed', category: 'done' }),
      ]
      const got = pickDirectTransition(transitions, 'cancelled')
      expect(got).toBeNull()
    })

    it('returns null when no done-category transitions at all (cancelled)', () => {
      const transitions = [tx({ id: 'tA', toId: 's-new', toName: 'New', category: 'new' })]
      expect(pickDirectTransition(transitions, 'cancelled')).toBeNull()
    })
  })
})

// ---------------------------------------------------------------------------
// pickProgressTransition
// ---------------------------------------------------------------------------

describe('pickProgressTransition', () => {
  it('returns null when current category already equals target (dir 0)', () => {
    const transitions = [tx({ toId: 's-1', toName: 'A', category: 'new' })]
    expect(pickProgressTransition(transitions, 'new', 'new', new Set())).toBeNull()
  })

  it('forward step toward goal: new → indeterminate', () => {
    const transitions = [
      tx({ id: 'tP', toId: 's-prog', toName: 'In Progress', category: 'indeterminate' }),
      tx({ id: 'tBack', toId: 's-new2', toName: 'New2', category: 'new' }),
    ]
    const got = pickProgressTransition(transitions, 'new', 'done', new Set())
    expect(got!.id).toBe('tP')
  })

  it('does not overshoot past the goal', () => {
    // goal = indeterminate (rank 1), from new (rank 0). A done (rank 2) overshoots.
    const transitions = [
      tx({ id: 'tDone', toId: 's-done', toName: 'Done', category: 'done' }),
      tx({ id: 'tProg', toId: 's-prog', toName: 'In Progress', category: 'indeterminate' }),
    ]
    const got = pickProgressTransition(transitions, 'new', 'indeterminate', new Set())
    expect(got!.id).toBe('tProg')
  })

  it('prefers furthest forward step without overshooting', () => {
    // from new (0) to done (2). Both indeterminate(1) and done(2) move forward; done is furthest.
    const transitions = [
      tx({ id: 'tProg', toId: 's-prog', toName: 'In Progress', category: 'indeterminate' }),
      tx({ id: 'tDone', toId: 's-done', toName: 'Done', category: 'done' }),
    ]
    const got = pickProgressTransition(transitions, 'new', 'done', new Set())
    expect(got!.id).toBe('tDone')
  })

  it('skips visited target status ids', () => {
    const transitions = [
      tx({ id: 'tProg1', toId: 's-prog1', toName: 'In Progress', category: 'indeterminate' }),
      tx({ id: 'tProg2', toId: 's-prog2', toName: 'Reviewing', category: 'indeterminate' }),
    ]
    const visited = new Set(['s-prog1'])
    const got = pickProgressTransition(transitions, 'new', 'done', visited)
    expect(got!.id).toBe('tProg2')
  })

  it('skips transitions with unknown / missing categories', () => {
    const transitions = [
      tx({ id: 'tBad', toId: 's-bad', toName: 'Bad', category: 'bogus' }),
      tx({ id: 'tNull', toId: 's-null', toName: 'Null', category: null }),
      tx({ id: 'tProg', toId: 's-prog', toName: 'In Progress', category: 'indeterminate' }),
    ]
    const got = pickProgressTransition(transitions, 'new', 'done', new Set())
    expect(got!.id).toBe('tProg')
  })

  it('backward direction: done → indeterminate', () => {
    const transitions = [
      tx({ id: 'tBackP', toId: 's-prog', toName: 'In Progress', category: 'indeterminate' }),
      tx({ id: 'tBackN', toId: 's-new', toName: 'New', category: 'new' }),
    ]
    // from done (2) to indeterminate (1), backward. Both indeterminate(1) and new(0) move backward;
    // must not overshoot below goal → new(0) overshoots, indeterminate(1) is the answer.
    const got = pickProgressTransition(transitions, 'done', 'indeterminate', new Set())
    expect(got!.id).toBe('tBackP')
  })

  it('backward direction prefers furthest (smallest rank) without overshooting goal', () => {
    // from done (2) to new (0). Both indeterminate(1) and new(0) move backward; new is furthest.
    const transitions = [
      tx({ id: 'tBackP', toId: 's-prog', toName: 'In Progress', category: 'indeterminate' }),
      tx({ id: 'tBackN', toId: 's-new', toName: 'New', category: 'new' }),
    ]
    const got = pickProgressTransition(transitions, 'done', 'new', new Set())
    expect(got!.id).toBe('tBackN')
  })

  it('returns null when no transition moves toward the goal', () => {
    // from new(0) to done(2) but the only edge goes back to new(0) — no forward move.
    const transitions = [tx({ id: 'tStay', toId: 's-new2', toName: 'New2', category: 'new' })]
    expect(pickProgressTransition(transitions, 'new', 'done', new Set())).toBeNull()
  })

  it('returns null on empty transitions', () => {
    expect(pickProgressTransition([], 'new', 'done', new Set())).toBeNull()
  })

  it('avoidCancelNames skips a reject (Discarded) done edge', () => {
    // From indeterminate toward done: the only forward edge is "Discarded".
    // With avoidance on, it must not be taken (returns null → walk dead-letters).
    const transitions = [tx({ id: 'tDisc', toId: 's-disc', toName: 'Discarded', category: 'done' })]
    expect(pickProgressTransition(transitions, 'indeterminate', 'done', new Set(), { avoidCancelNames: true })).toBeNull()
    // Without avoidance (legacy default) it is still eligible.
    expect(pickProgressTransition(transitions, 'indeterminate', 'done', new Set())!.id).toBe('tDisc')
  })

  it('avoidCancelNames still takes a non-reject forward edge', () => {
    const transitions = [
      tx({ id: 'tDisc', toId: 's-disc', toName: 'Discarded', category: 'done' }),
      tx({ id: 'tDone', toId: 's-done', toName: 'Done', category: 'done' }),
    ]
    const got = pickProgressTransition(transitions, 'indeterminate', 'done', new Set(), { avoidCancelNames: true })
    expect(got!.id).toBe('tDone')
  })
})

// ---------------------------------------------------------------------------
// buildTransitionFields
// ---------------------------------------------------------------------------

describe('buildTransitionFields', () => {
  it('returns empty plan when transition has no fields', () => {
    const t = tx({ toId: 's-done', toName: 'Done', category: 'done' })
    expect(buildTransitionFields(t, 'done')).toEqual({})
  })

  it('returns empty plan when fields object is empty', () => {
    const t = tx({ toId: 's-done', toName: 'Done', category: 'done', fields: {} })
    expect(buildTransitionFields(t, 'done')).toEqual({})
  })

  it('sets resolution to a ship value for done state (by id)', () => {
    const t = tx({
      toId: 's-done',
      toName: 'Done',
      category: 'done',
      fields: {
        resolution: field({
          required: true,
          allowedValues: [
            { id: '10', name: "Won't Do" },
            { id: '20', name: 'Done' },
          ],
        }),
      },
    })
    const plan = buildTransitionFields(t, 'done')
    expect(plan.fields).toEqual({ resolution: { id: '20' } })
    expect(plan.blockedReason).toBeUndefined()
  })

  it('sets resolution to a cancel value for cancelled state (by id)', () => {
    const t = tx({
      toId: 's-done',
      toName: 'Done',
      category: 'done',
      fields: {
        resolution: field({
          required: true,
          allowedValues: [
            { id: '20', name: 'Done' },
            { id: '10', name: "Won't Do" },
          ],
        }),
      },
    })
    const plan = buildTransitionFields(t, 'cancelled')
    expect(plan.fields).toEqual({ resolution: { id: '10' } })
  })

  it('uses {name} when allowed value has no id (ship)', () => {
    const t = tx({
      toId: 's-done',
      toName: 'Done',
      category: 'done',
      fields: {
        resolution: field({
          required: true,
          allowedValues: [{ name: 'Released' }],
        }),
      },
    })
    const plan = buildTransitionFields(t, 'done')
    expect(plan.fields).toEqual({ resolution: { name: 'Released' } })
  })

  it('uses value field when name absent for lexicon match', () => {
    const t = tx({
      toId: 's-done',
      toName: 'Done',
      category: 'done',
      fields: {
        resolution: field({
          required: true,
          allowedValues: [{ value: 'Done' }],
        }),
      },
    })
    const plan = buildTransitionFields(t, 'done')
    // no id, no name → name ?? value → 'Done'
    expect(plan.fields).toEqual({ resolution: { name: 'Done' } })
  })

  it('falls back to allowed[0] when no lexicon value matches (ship)', () => {
    const t = tx({
      toId: 's-done',
      toName: 'Done',
      category: 'done',
      fields: {
        resolution: field({
          required: true,
          allowedValues: [{ id: '99', name: 'Mystery' }],
        }),
      },
    })
    const plan = buildTransitionFields(t, 'done')
    expect(plan.fields).toEqual({ resolution: { id: '99' } })
  })

  it('produces no resolution field when allowedValues is empty', () => {
    const t = tx({
      toId: 's-done',
      toName: 'Done',
      category: 'done',
      fields: {
        resolution: field({ required: true, allowedValues: [] }),
      },
    })
    const plan = buildTransitionFields(t, 'done')
    // no pick → out stays empty → {}
    expect(plan).toEqual({})
  })

  it('produces no resolution field when allowedValues is undefined', () => {
    const t = tx({
      toId: 's-done',
      toName: 'Done',
      category: 'done',
      fields: {
        resolution: field({ required: true }),
      },
    })
    const plan = buildTransitionFields(t, 'done')
    expect(plan).toEqual({})
  })

  it('blocks on a required custom field with no default', () => {
    const t = tx({
      toId: 's-done',
      toName: 'Done',
      category: 'done',
      fields: {
        customfield_123: field({ required: true, hasDefaultValue: false, name: 'Sprint' }),
      },
    })
    const plan = buildTransitionFields(t, 'done')
    expect(plan.blockedReason).toBe('transition requires field "Sprint" with no default')
    expect(plan.fields).toBeUndefined()
  })

  it('uses the field key in the blocked reason when name is absent', () => {
    const t = tx({
      toId: 's-done',
      toName: 'Done',
      category: 'done',
      fields: {
        customfield_999: field({ required: true, hasDefaultValue: false }),
      },
    })
    const plan = buildTransitionFields(t, 'done')
    expect(plan.blockedReason).toBe('transition requires field "customfield_999" with no default')
  })

  it('does NOT block on a required field that has a default value', () => {
    const t = tx({
      toId: 's-done',
      toName: 'Done',
      category: 'done',
      fields: {
        customfield_1: field({ required: true, hasDefaultValue: true, name: 'Team' }),
      },
    })
    const plan = buildTransitionFields(t, 'done')
    expect(plan).toEqual({})
  })

  it('does NOT block on a non-required field with no default', () => {
    const t = tx({
      toId: 's-done',
      toName: 'Done',
      category: 'done',
      fields: {
        customfield_2: field({ required: false, hasDefaultValue: false, name: 'Optional' }),
      },
    })
    const plan = buildTransitionFields(t, 'done')
    expect(plan).toEqual({})
  })

  it('resolution NOT on screen → no fields even for done state', () => {
    // The screen only carries a benign optional field; resolution is absent.
    const t = tx({
      toId: 's-done',
      toName: 'Done',
      category: 'done',
      fields: {
        comment: field({ required: false }),
      },
    })
    const plan = buildTransitionFields(t, 'done')
    expect(plan).toEqual({})
  })

  it('blocks even when resolution is also present (required field short-circuits)', () => {
    const t = tx({
      toId: 's-done',
      toName: 'Done',
      category: 'done',
      fields: {
        resolution: field({ required: true, allowedValues: [{ id: '1', name: 'Done' }] }),
        customfield_5: field({ required: true, hasDefaultValue: false, name: 'Blocker' }),
      },
    })
    const plan = buildTransitionFields(t, 'done')
    expect(plan.blockedReason).toBe('transition requires field "Blocker" with no default')
  })
})

// ---------------------------------------------------------------------------
// walkToCategory
// ---------------------------------------------------------------------------

describe('walkToCategory', () => {
  it('noop when already in the target category', async () => {
    const getTransitions = vi.fn(async () => [] as JiraTransition[])
    const applyTransition = vi.fn(async () => {})
    const out = await walkToCategory({
      state: 'todo',
      currentCategory: 'new',
      getTransitions,
      applyTransition,
    })
    expect(out).toEqual({ status: 'noop' })
    expect(getTransitions).not.toHaveBeenCalled()
    expect(applyTransition).not.toHaveBeenCalled()
  })

  it('applies a direct transition into the target category', async () => {
    const direct = tx({ id: 'tP', toId: 's-prog', toName: 'In Progress', category: 'indeterminate' })
    const getTransitions = vi.fn(async () => [direct])
    const applyTransition = vi.fn(async () => {})
    const out = await walkToCategory({
      state: 'in_progress',
      currentCategory: 'new',
      getTransitions,
      applyTransition,
    })
    expect(out).toEqual({ status: 'applied', finalCategory: 'indeterminate', transitions: ['tP'] })
    expect(applyTransition).toHaveBeenCalledTimes(1)
    expect(applyTransition).toHaveBeenCalledWith(direct, {})
  })

  it('passes a built field plan to applyTransition for a screened done transition', async () => {
    const direct = tx({
      id: 'tDone',
      toId: 's-done',
      toName: 'Released',
      category: 'done',
      fields: { resolution: field({ required: true, allowedValues: [{ id: '20', name: 'Done' }] }) },
    })
    const getTransitions = vi.fn(async () => [direct])
    const applyTransition = vi.fn(async () => {})
    const out = await walkToCategory({
      state: 'done',
      currentCategory: 'indeterminate',
      getTransitions,
      applyTransition,
    })
    expect(out.status).toBe('applied')
    expect(applyTransition).toHaveBeenCalledWith(direct, { fields: { resolution: { id: '20' } } })
  })

  it('multi-hop BFS Backlog(new) → In Progress(indeterminate) → Done(done)', async () => {
    // Goal: done. Current: new. There is no direct new→done edge, so hop 1 takes the
    // forward progress step into indeterminate, hop 2 finds the direct done edge.
    // Per-hop getTransitions returns the outgoing edges of the *current* status.
    const hopNewToProg = tx({ id: 'h1', toId: 's-prog', toName: 'In Progress', category: 'indeterminate' })
    const hopProgToDone = tx({ id: 'h2', toId: 's-done', toName: 'Done', category: 'done' })

    const calls: JiraTransition[][] = [[hopNewToProg], [hopProgToDone]]
    let idx = 0
    const getTransitions = vi.fn(async () => calls[idx++] ?? [])
    const applied: JiraTransition[] = []
    const applyTransition = vi.fn(async (t: JiraTransition) => {
      applied.push(t)
    })

    const out = await walkToCategory({
      state: 'done',
      currentCategory: 'new',
      getTransitions,
      applyTransition,
    })
    expect(out).toEqual({ status: 'applied', finalCategory: 'done', transitions: ['h1', 'h2'] })
    expect(applied.map((t) => t.id)).toEqual(['h1', 'h2'])
    expect(getTransitions).toHaveBeenCalledTimes(2)
  })

  it('no_path when stuck (no direct and no progress edge)', async () => {
    // Goal indeterminate from new, but the only edge goes back to new (no forward move).
    const stuck = tx({ id: 's1', toId: 's-new2', toName: 'New2', category: 'new' })
    const getTransitions = vi.fn(async () => [stuck])
    const applyTransition = vi.fn(async () => {})
    const out = await walkToCategory({
      state: 'in_progress',
      currentCategory: 'new',
      getTransitions,
      applyTransition,
    })
    expect(out).toEqual({
      status: 'no_path',
      reason: 'no workflow transition from category "new" toward "indeterminate"',
    })
    expect(applyTransition).not.toHaveBeenCalled()
  })

  it('blocked when a direct transition requires a field with no default', async () => {
    const direct = tx({
      id: 'tDone',
      toId: 's-done',
      toName: 'Released',
      category: 'done',
      fields: { customfield_9: field({ required: true, hasDefaultValue: false, name: 'Sprint' }) },
    })
    const getTransitions = vi.fn(async () => [direct])
    const applyTransition = vi.fn(async () => {})
    const out = await walkToCategory({
      state: 'done',
      currentCategory: 'indeterminate',
      getTransitions,
      applyTransition,
    })
    expect(out).toEqual({ status: 'blocked', reason: 'transition requires field "Sprint" with no default' })
    expect(applyTransition).not.toHaveBeenCalled()
  })

  it('blocked when a PROGRESS-step transition requires a field with no default', async () => {
    // No direct edge to done, but the only forward (indeterminate) step has a blocking field.
    const step = tx({
      id: 'sStep',
      toId: 's-prog',
      toName: 'In Progress',
      category: 'indeterminate',
      fields: { customfield_x: field({ required: true, hasDefaultValue: false, name: 'Reviewer' }) },
    })
    const getTransitions = vi.fn(async () => [step])
    const applyTransition = vi.fn(async () => {})
    const out = await walkToCategory({
      state: 'done',
      currentCategory: 'new',
      getTransitions,
      applyTransition,
    })
    expect(out).toEqual({ status: 'blocked', reason: 'transition requires field "Reviewer" with no default' })
    expect(applyTransition).not.toHaveBeenCalled()
  })

  it('error when getTransitions throws (Error)', async () => {
    const getTransitions = vi.fn(async () => {
      throw new Error('boom getTransitions')
    })
    const applyTransition = vi.fn(async () => {})
    const out = await walkToCategory({
      state: 'in_progress',
      currentCategory: 'new',
      getTransitions,
      applyTransition,
    })
    expect(out).toEqual({ status: 'error', reason: 'boom getTransitions' })
  })

  it('error when getTransitions throws a non-Error', async () => {
    const getTransitions = vi.fn(async () => {
      throw 'string failure'
    })
    const applyTransition = vi.fn(async () => {})
    const out = await walkToCategory({
      state: 'in_progress',
      currentCategory: 'new',
      getTransitions,
      applyTransition,
    })
    expect(out).toEqual({ status: 'error', reason: 'string failure' })
  })

  it('error when applyTransition throws on a direct transition (Error)', async () => {
    const direct = tx({ id: 'tP', toId: 's-prog', toName: 'In Progress', category: 'indeterminate' })
    const getTransitions = vi.fn(async () => [direct])
    const applyTransition = vi.fn(async () => {
      throw new Error('apply failed')
    })
    const out = await walkToCategory({
      state: 'in_progress',
      currentCategory: 'new',
      getTransitions,
      applyTransition,
    })
    expect(out).toEqual({ status: 'error', reason: 'apply failed' })
  })

  it('error when applyTransition throws a non-Error on a direct transition', async () => {
    const direct = tx({ id: 'tP', toId: 's-prog', toName: 'In Progress', category: 'indeterminate' })
    const getTransitions = vi.fn(async () => [direct])
    const applyTransition = vi.fn(async () => {
      throw { code: 500 }
    })
    const out = await walkToCategory({
      state: 'in_progress',
      currentCategory: 'new',
      getTransitions,
      applyTransition,
    })
    expect(out.status).toBe('error')
    expect(out).toMatchObject({ status: 'error', reason: '[object Object]' })
  })

  it('error when applyTransition throws on a PROGRESS step', async () => {
    // No direct edge to done; a forward step exists but applyTransition throws.
    const step = tx({ id: 'sStep', toId: 's-prog', toName: 'In Progress', category: 'indeterminate' })
    const getTransitions = vi.fn(async () => [step])
    const applyTransition = vi.fn(async () => {
      throw new Error('step apply failed')
    })
    const out = await walkToCategory({
      state: 'done',
      currentCategory: 'new',
      getTransitions,
      applyTransition,
    })
    expect(out).toEqual({ status: 'error', reason: 'step apply failed' })
  })

  it('takes a progress step then dead-ends with the "no workflow transition" no_path', async () => {
    // Goal: done. Hop 0 takes a forward step new→indeterminate. Hop 1, from indeterminate,
    // only offers an indeterminate→indeterminate edge (rank 1, no forward move toward done),
    // so pickProgressTransition returns null and the walk dead-ends.
    const forward = tx({ id: 'fwd', toId: 's-prog', toName: 'In Progress', category: 'indeterminate' })
    const lateral = tx({ id: 'lat', toId: 's-review', toName: 'Reviewing', category: 'indeterminate' })
    const calls: JiraTransition[][] = [[forward], [lateral]]
    let idx = 0
    const getTransitions = vi.fn(async () => calls[idx++] ?? [])
    const applyTransition = vi.fn(async () => {})
    const out = await walkToCategory({
      state: 'done',
      currentCategory: 'new',
      maxHops: 5,
      getTransitions,
      applyTransition,
    })
    expect(out).toEqual({
      status: 'no_path',
      reason: 'no workflow transition from category "indeterminate" toward "done"',
    })
    // One progress step applied (the forward edge), then stuck.
    expect(applyTransition).toHaveBeenCalledTimes(1)
    expect(applyTransition).toHaveBeenCalledWith(forward, {})
  })

  it('respects maxHops bound by dead-ending before exhaustion when no forward edge appears', async () => {
    // maxHops=1: a single forward step into indeterminate is applied, loop ends, but the
    // target (done) is not reached → final "not reached within N hops" no_path.
    const forward = tx({ id: 'fwd', toId: 's-prog', toName: 'In Progress', category: 'indeterminate' })
    const getTransitions = vi.fn(async () => [forward])
    const applyTransition = vi.fn(async () => {})
    const out = await walkToCategory({
      state: 'done',
      currentCategory: 'new',
      maxHops: 1,
      getTransitions,
      applyTransition,
    })
    expect(out).toEqual({ status: 'no_path', reason: 'target category "done" not reached within 1 hops' })
    expect(applyTransition).toHaveBeenCalledTimes(1)
  })

  it('honours an explicit target during the walk', async () => {
    // explicit transition id wins immediately even though category fallback would also match.
    const explicit = tx({ id: 'tExplicit', toId: 's-special', toName: 'Special Done', category: 'done' })
    const other = tx({ id: 'tOther', toId: 's-done', toName: 'Done', category: 'done' })
    const getTransitions = vi.fn(async () => [other, explicit])
    const applyTransition = vi.fn(async () => {})
    const out = await walkToCategory({
      state: 'done',
      currentCategory: 'indeterminate',
      explicitTarget: 'tExplicit',
      getTransitions,
      applyTransition,
    })
    expect(out).toMatchObject({ status: 'applied', transitions: ['tExplicit'] })
    expect(applyTransition).toHaveBeenCalledWith(explicit, expect.anything())
  })

  it('done walk lands on the configured "On Review" target, not the Discarded edge', async () => {
    // The reported scenario: a completed job whose statusMap.done = "On Review".
    // From In Progress both an "On Review" and a "Discarded" done edge exist; the
    // explicit target must win.
    const review = tx({ id: 'tReview', toId: 's-rev', toName: 'On Review', category: 'done' })
    const discard = tx({ id: 'tDiscard', toId: 's-disc', toName: 'Discarded', category: 'done' })
    const getTransitions = vi.fn(async () => [discard, review])
    const applied: JiraTransition[] = []
    const applyTransition = vi.fn(async (t: JiraTransition) => { applied.push(t) })
    const out = await walkToCategory({
      state: 'done',
      currentCategory: 'indeterminate',
      explicitTarget: 'On Review',
      getTransitions,
      applyTransition,
    })
    expect(out).toMatchObject({ status: 'applied', transitions: ['tReview'] })
    expect(applied.map((t) => t.id)).toEqual(['tReview'])
  })

  it('done walk dead-letters (no_path) rather than discarding when only a Discarded edge exists', async () => {
    // No statusMap target; the only done-category edge is a reject status. A
    // successful job must NOT be auto-discarded — it dead-letters for a manual move.
    const discard = tx({ id: 'tDiscard', toId: 's-disc', toName: 'Discarded', category: 'done' })
    const getTransitions = vi.fn(async () => [discard])
    const applyTransition = vi.fn(async () => {})
    const out = await walkToCategory({
      state: 'done',
      currentCategory: 'indeterminate',
      getTransitions,
      applyTransition,
    })
    expect(out.status).toBe('no_path')
    expect(applyTransition).not.toHaveBeenCalled()
  })

  it('progress step updates current category and reaches target via category check', async () => {
    // Single hop: a forward step to indeterminate that equals the target (no direct done edge needed).
    const step = tx({ id: 'sStep', toId: 's-prog', toName: 'In Progress', category: 'indeterminate' })
    const getTransitions = vi.fn(async () => [step])
    const applyTransition = vi.fn(async () => {})
    const out = await walkToCategory({
      state: 'in_progress',
      currentCategory: 'new',
      getTransitions,
      applyTransition,
    })
    // For in_progress, target IS indeterminate, so pickDirectTransition already matches.
    expect(out).toMatchObject({ status: 'applied', finalCategory: 'indeterminate' })
  })
})

// keep the imported type referenced for tooling without an unused-var warning
const _planType: TransitionFieldPlan = {}
void _planType
