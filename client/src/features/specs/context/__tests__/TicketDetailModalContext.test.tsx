import { describe, it, expect } from 'vitest'
import { reduceSplit, INITIAL_STATE, INITIAL_RATIO, MIN_RATIO, MAX_RATIO } from '../TicketDetailModalContext'

describe('TicketDetailModalContext reduceSplit', () => {
  it('opens a ticket centered (single-modal mode)', () => {
    const next = reduceSplit(INITIAL_STATE, { type: 'openCentered', id: 1 })
    expect(next).toEqual({ leftId: 1, rightId: null, originSide: null, splitRatio: INITIAL_RATIO })
  })

  it('closes all', () => {
    const opened = reduceSplit(INITIAL_STATE, { type: 'openCentered', id: 1 })
    expect(reduceSplit(opened, { type: 'closeAll' })).toEqual(INITIAL_STATE)
  })

  it('enters split-left: ticket stays left, picker on right', () => {
    const opened = reduceSplit(INITIAL_STATE, { type: 'openCentered', id: 1 })
    const split = reduceSplit(opened, { type: 'enterSplit', side: 'left' })
    expect(split).toMatchObject({ leftId: 1, rightId: null, originSide: 'left' })
  })

  it('enters split-right: ticket moves to right, picker on left', () => {
    const opened = reduceSplit(INITIAL_STATE, { type: 'openCentered', id: 1 })
    const split = reduceSplit(opened, { type: 'enterSplit', side: 'right' })
    expect(split).toMatchObject({ leftId: null, rightId: 1, originSide: 'right' })
  })

  it('cannot enter split when no ticket is open', () => {
    expect(reduceSplit(INITIAL_STATE, { type: 'enterSplit', side: 'left' })).toBe(INITIAL_STATE)
  })

  it('enterSplit accepts an explicit ticketId (third-party modal bootstrap)', () => {
    // Provider has no leftId but a third-party modal (DashboardPage) passes its
    // own ticket id when entering split.
    const split = reduceSplit(INITIAL_STATE, { type: 'enterSplit', side: 'right', ticketId: 42 })
    expect(split).toMatchObject({ leftId: null, rightId: 42, originSide: 'right' })
  })

  it('enterSplit-left with explicit ticketId puts ticket on left side', () => {
    const split = reduceSplit(INITIAL_STATE, { type: 'enterSplit', side: 'left', ticketId: 42 })
    expect(split).toMatchObject({ leftId: 42, rightId: null, originSide: 'left' })
  })

  it('cannot enter split twice', () => {
    const split = reduceSplit(
      reduceSplit(INITIAL_STATE, { type: 'openCentered', id: 1 }),
      { type: 'enterSplit', side: 'left' },
    )
    const noOp = reduceSplit(split, { type: 'enterSplit', side: 'right' })
    expect(noOp).toBe(split)
  })

  it('sets compared ticket on non-origin side only', () => {
    const split = reduceSplit(
      reduceSplit(INITIAL_STATE, { type: 'openCentered', id: 1 }),
      { type: 'enterSplit', side: 'left' },
    )
    // origin = left, opposite = right
    const withCompare = reduceSplit(split, { type: 'setComparedTicket', id: 2, side: 'right' })
    expect(withCompare).toMatchObject({ leftId: 1, rightId: 2 })
  })

  it('ignores setComparedTicket on the origin side', () => {
    const split = reduceSplit(
      reduceSplit(INITIAL_STATE, { type: 'openCentered', id: 1 }),
      { type: 'enterSplit', side: 'left' },
    )
    const noOp = reduceSplit(split, { type: 'setComparedTicket', id: 99, side: 'left' })
    expect(noOp).toBe(split)
  })

  it('returns side B to picker via setComparedTicket(null)', () => {
    const withCompare = reduceSplit(
      reduceSplit(
        reduceSplit(INITIAL_STATE, { type: 'openCentered', id: 1 }),
        { type: 'enterSplit', side: 'left' },
      ),
      { type: 'setComparedTicket', id: 2, side: 'right' },
    )
    const noB = reduceSplit(withCompare, { type: 'setComparedTicket', id: null, side: 'right' })
    expect(noB).toMatchObject({ leftId: 1, rightId: null, originSide: 'left' })
  })

  it('exits split keeps the origin-side ticket centered', () => {
    const split = reduceSplit(
      reduceSplit(
        reduceSplit(INITIAL_STATE, { type: 'openCentered', id: 1 }),
        { type: 'enterSplit', side: 'right' },
      ),
      { type: 'setComparedTicket', id: 2, side: 'left' },
    )
    // origin = right; collapsing should keep ticket 1
    const collapsed = reduceSplit(split, { type: 'exitSplit' })
    expect(collapsed).toEqual({ leftId: 1, rightId: null, originSide: null, splitRatio: INITIAL_RATIO })
  })

  it('third-spec rule: openCentered with new id while in split collapses to centered', () => {
    const withTwo = reduceSplit(
      reduceSplit(
        reduceSplit(INITIAL_STATE, { type: 'openCentered', id: 1 }),
        { type: 'enterSplit', side: 'left' },
      ),
      { type: 'setComparedTicket', id: 2, side: 'right' },
    )
    const third = reduceSplit(withTwo, { type: 'openCentered', id: 3 })
    expect(third).toEqual({ leftId: 3, rightId: null, originSide: null, splitRatio: INITIAL_RATIO })
  })

  it('openCentered with id already on screen during split is a no-op', () => {
    const withTwo = reduceSplit(
      reduceSplit(
        reduceSplit(INITIAL_STATE, { type: 'openCentered', id: 1 }),
        { type: 'enterSplit', side: 'left' },
      ),
      { type: 'setComparedTicket', id: 2, side: 'right' },
    )
    expect(reduceSplit(withTwo, { type: 'openCentered', id: 1 })).toBe(withTwo)
    expect(reduceSplit(withTwo, { type: 'openCentered', id: 2 })).toBe(withTwo)
  })

  it('clamps splitRatio to [MIN_RATIO, MAX_RATIO]', () => {
    const s = reduceSplit(INITIAL_STATE, { type: 'setSplitRatio', ratio: 0.1 })
    expect(s.splitRatio).toBe(MIN_RATIO)
    const s2 = reduceSplit(s, { type: 'setSplitRatio', ratio: 0.9 })
    expect(s2.splitRatio).toBe(MAX_RATIO)
    const s3 = reduceSplit(s2, { type: 'setSplitRatio', ratio: 0.4 })
    expect(s3.splitRatio).toBe(0.4)
  })

  it('handles non-finite ratios safely', () => {
    const s = reduceSplit(INITIAL_STATE, { type: 'setSplitRatio', ratio: Number.NaN })
    expect(s.splitRatio).toBe(INITIAL_RATIO)
  })

  it('resets ratio to default when entering split fresh', () => {
    const widened = reduceSplit(
      reduceSplit(INITIAL_STATE, { type: 'openCentered', id: 1 }),
      { type: 'setSplitRatio', ratio: 0.7 },
    )
    const intoSplit = reduceSplit(widened, { type: 'enterSplit', side: 'left' })
    expect(intoSplit.splitRatio).toBe(INITIAL_RATIO)
  })
})
