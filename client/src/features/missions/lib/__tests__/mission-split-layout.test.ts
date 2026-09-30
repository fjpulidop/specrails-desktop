import { expect, it } from 'vitest'
import { missionSplitLayout } from '../mission-split-layout'

it('uses two columns, then adds horizontal divisions while keeping the other column full height', () => {
  const two = missionSplitLayout(2, 1000)
  expect(two.columns).toBe(2)
  expect(two.rows).toBe(1)
  const three = missionSplitLayout(3, 1000)
  expect(three.placements).toEqual([
    { gridColumn: 1, gridRow: '1 / span 1' },
    { gridColumn: 2, gridRow: '1 / span 2' },
    { gridColumn: 1, gridRow: '2 / span 1' },
  ])
  expect(missionSplitLayout(4, 1000).placements[3]).toEqual({ gridColumn: 2, gridRow: '2 / span 1' })
  expect(missionSplitLayout(5, 1000).columns).toBe(2)
  expect(missionSplitLayout(5, 1000).rows).toBe(6)
})

it('stacks narrow panes and restores full size when only one remains', () => {
  expect(missionSplitLayout(3, 500).placements).toEqual([
    { gridColumn: 1, gridRow: '1 / span 1' }, { gridColumn: 1, gridRow: '2 / span 1' }, { gridColumn: 1, gridRow: '3 / span 1' },
  ])
  expect(missionSplitLayout(1, 1000)).toMatchObject({ columns: 1, rows: 1, minimumRowHeight: 0 })
  expect(missionSplitLayout(0, 1000)).toMatchObject({ columns: 1, rows: 1 })
})
