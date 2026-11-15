import { expect, it } from 'vitest'
import { missionSplitLayout, missionSplitPaneEdges } from '../mission-split-layout'

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

it('draws pane dividers only on edges shared with another pane, never under the title bar', () => {
  const edges = (count: number, width = 1000) => missionSplitLayout(count, width).placements.map(missionSplitPaneEdges)
  // Side by side: one vertical divider, no top line doubling the title bar hairline.
  expect(edges(2)).toEqual([{ left: false, top: false }, { left: true, top: false }])
  expect(edges(4)).toEqual([
    { left: false, top: false }, { left: true, top: false },
    { left: false, top: true }, { left: true, top: true },
  ])
  // Stacked: horizontal dividers only.
  expect(edges(3, 500)).toEqual([{ left: false, top: false }, { left: false, top: true }, { left: false, top: true }])
  // Row 12 is not the first row.
  expect(missionSplitPaneEdges({ gridColumn: 1, gridRow: '12 / span 1' })).toEqual({ left: false, top: true })
})
