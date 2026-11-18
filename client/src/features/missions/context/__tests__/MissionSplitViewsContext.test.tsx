import { act, render } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import type { ReactNode } from 'react'
import {
  MissionSplitViewsProvider, PRIMARY_PANE, defaultSplitSide, useMissionSplitViews,
  type MissionSplitKnownMissions, type MissionSplitViews,
} from '../MissionSplitViewsContext'
import { MISSION_SPLIT_STORAGE_KEY } from '../../lib/mission-split-storage'
import { leaf, splitLeaves, type SplitNode } from '../../lib/mission-split-tree'
import type { AgentConversation } from '../../lib/agent-api'

let views: MissionSplitViews
function Probe() { views = useMissionSplitViews(); return null }
const mission = (id: string, archivedAt: string | null = null) => ({ id, archivedAt, title: id, updated_at: '' }) as AgentConversation
const known = (ids: string[], over: Partial<MissionSplitKnownMissions> = {}): MissionSplitKnownMissions =>
  ({ conversations: ids.map(id => mission(id)), loading: false, error: null, archiveScope: 'active', ...over })

function setup({ primaryId = 'p', missions, persist = false }: { primaryId?: string | null; missions?: MissionSplitKnownMissions; persist?: boolean } = {}) {
  const ui = (props: { primaryId: string | null; missions?: MissionSplitKnownMissions }, children: ReactNode = <Probe />) =>
    <MissionSplitViewsProvider primaryId={props.primaryId} missions={props.missions} persist={persist}>{children}</MissionSplitViewsProvider>
  const result = render(ui({ primaryId, missions }))
  return { rerender: (props: { primaryId: string | null; missions?: MissionSplitKnownMissions }) => result.rerender(ui(props)), unmount: result.unmount }
}
const row = (first: SplitNode, second: SplitNode, ratio = 0.5): SplitNode => ({ type: 'split', direction: 'row', first, second, ratio })
const column = (first: SplitNode, second: SplitNode, ratio = 0.5): SplitNode => ({ type: 'split', direction: 'column', first, second, ratio })

beforeEach(() => localStorage.clear())

describe('opening panes', () => {
  it('splits the focused pane to the right by default and keeps the stable order', () => {
    setup()
    act(() => views.open('a'))
    act(() => views.open('b'))
    expect(views.tree).toEqual(row(leaf(PRIMARY_PANE), row(leaf('a'), leaf('b'))))
    expect(views.conversationIds).toEqual(['a', 'b'])
    expect(views.focusedId).toBe('b')
    act(() => views.open('a', { focusComposer: true }))
    expect(views.focusedId).toBe('a')
    expect(views.composerFocusId).toBe('a')
    expect(splitLeaves(views.tree)).toEqual([PRIMARY_PANE, 'a', 'b'])
  })
  it('goes below when the focused pane is too narrow for two', () => {
    setup()
    act(() => views.reportLayout({ width: 1000, height: 900 }, false))
    act(() => views.open('a'))
    act(() => views.open('b'))
    expect(views.tree).toEqual(row(leaf(PRIMARY_PANE), column(leaf('a'), leaf('b'))))
    expect(defaultSplitSide(leaf('x'), 'x', { width: 500, height: 300 })).toBe('right')
    expect(defaultSplitSide(leaf('x'), 'missing', { width: 1000, height: 600 })).toBe('right')
  })
  it('opens beside a given pane and side, moving a pane already open', () => {
    setup()
    act(() => views.open('a'))
    act(() => views.openBeside('b', 'down', PRIMARY_PANE))
    expect(views.tree).toEqual(row(column(leaf(PRIMARY_PANE), leaf('b')), leaf('a')))
    act(() => views.openBeside('a', 'up', 'b'))
    expect(views.tree).toEqual(column(leaf(PRIMARY_PANE), column(leaf('a'), leaf('b'))))
    expect(views.conversationIds).toEqual(['a', 'b'])
  })
  it('shows the primary pane when opening the primary mission', () => {
    setup()
    act(() => views.open('a'))
    act(() => views.closePrimary())
    expect(views.primaryVisible).toBe(false)
    act(() => views.open('p'))
    expect(views.primaryVisible).toBe(true)
    expect(views.focusedId).toBeNull()
  })
})

describe('closing panes', () => {
  it('collapses the parent and focuses the sibling', () => {
    setup()
    act(() => views.open('a'))
    act(() => views.openBeside('b', 'down', 'a'))
    act(() => views.close('b'))
    expect(views.tree).toEqual(row(leaf(PRIMARY_PANE), leaf('a')))
    expect(views.focusedId).toBe('a')
    act(() => views.close('a'))
    expect(views.tree).toEqual(leaf(PRIMARY_PANE))
    expect(views.focusedId).toBeNull()
  })
  it('hides the primary only while another pane remains and brings it back when the last pane closes', () => {
    setup()
    act(() => views.closePrimary())
    expect(views.primaryVisible).toBe(true)
    act(() => views.open('a'))
    act(() => views.closePrimary())
    expect(views.primaryVisible).toBe(false)
    expect(views.focusedId).toBe('a')
    expect(views.focusExisting('a')).toBe(true)
    expect(views.focusExisting('zzz')).toBe(false)
    act(() => views.close('a'))
    expect(views.tree).toEqual(leaf(PRIMARY_PANE))
    act(() => views.open('a'))
    act(() => views.closePrimary())
    act(() => views.showPrimary())
    expect(views.tree).toEqual(row(leaf(PRIMARY_PANE), leaf('a')))
  })
})

describe('primary mission switch', () => {
  it('a mission already in a pane leaves it (primary shown) or takes the hidden primary pane place', () => {
    const { rerender } = setup()
    act(() => views.open('a'))
    act(() => views.open('b'))
    rerender({ primaryId: 'a' })
    expect(views.tree).toEqual(row(leaf(PRIMARY_PANE), leaf('b')))
    act(() => views.closePrimary())
    rerender({ primaryId: 'b' })
    expect(views.tree).toEqual(leaf(PRIMARY_PANE))
  })
  it('shows a hidden primary pane on a real switch', () => {
    const { rerender } = setup()
    act(() => views.open('a'))
    act(() => views.closePrimary())
    rerender({ primaryId: 'q' })
    expect(views.tree).toEqual(row(leaf(PRIMARY_PANE), leaf('a')))
    expect(views.focusedId).toBeNull()
  })
})

describe('layout actions', () => {
  it('moves, swaps, resizes and equalizes', () => {
    setup()
    act(() => views.open('a'))
    act(() => views.open('b'))
    act(() => views.move('b', 'left'))
    expect(splitLeaves(views.tree)).toEqual([PRIMARY_PANE, 'b', 'a'])
    act(() => views.swap(PRIMARY_PANE, 'a'))
    expect(splitLeaves(views.tree)).toEqual(['a', 'b', PRIMARY_PANE])
    act(() => views.setRatio([], 0.2))
    expect((views.tree as { ratio: number }).ratio).toBe(0.2)
    act(() => views.equalize())
    expect((views.tree as { ratio: number }).ratio).toBeCloseTo(1 / 3)
    act(() => views.setRatio([1], 0.9))
    act(() => views.equalize([1]))
    expect(((views.tree as { second: { ratio: number } }).second).ratio).toBe(0.5)
    expect(views.conversationIds).toEqual(['a', 'b'])
  })
  it('maximizes and restores one pane without changing the tree', () => {
    setup()
    act(() => views.toggleMaximize())
    expect(views.maximizedId).toBeNull()
    act(() => views.open('a'))
    const tree = views.tree
    act(() => views.toggleMaximize('a'))
    expect(views.maximizedId).toBe('a')
    expect(views.visiblePaneIds).toEqual(['a'])
    expect(views.tree).toBe(tree)
    act(() => views.toggleMaximize())
    expect(views.maximizedId).toBeNull()
    act(() => views.toggleMaximize(PRIMARY_PANE))
    act(() => views.open('b'))
    expect(views.maximizedId).toBeNull()
    act(() => views.toggleMaximize('b'))
    act(() => views.close('b'))
    expect(views.maximizedId).toBeNull()
  })
  it('reports only the focused pane as visible while stacked', () => {
    setup()
    act(() => views.open('a'))
    act(() => views.reportLayout({ width: 400, height: 400 }, true))
    expect(views.visiblePaneIds).toEqual(['a'])
    act(() => views.focusPane(PRIMARY_PANE))
    expect(views.visiblePaneIds).toEqual([PRIMARY_PANE])
    expect(views.layoutSize()).toEqual({ width: 400, height: 400 })
  })
})

describe('persistence', () => {
  it('saves the arrangement and restores it on reload, clearing it for the single default pane', () => {
    const first = setup({ persist: true })
    act(() => views.open('a'))
    act(() => views.setRatio([], 0.3))
    expect(JSON.parse(localStorage.getItem(MISSION_SPLIT_STORAGE_KEY)!).tree).toEqual(row(leaf(PRIMARY_PANE), leaf('a'), 0.3))
    first.unmount()
    setup({ persist: true, primaryId: null })
    expect(views.tree).toEqual(row(leaf(PRIMARY_PANE), leaf('a'), 0.3))
    expect(views.conversationIds).toEqual(['a'])
    act(() => views.close('a'))
    expect(localStorage.getItem(MISSION_SPLIT_STORAGE_KEY)).toBeNull()
  })
  it('does not persist outside the main window and survives unusable storage', () => {
    setup()
    act(() => views.open('a'))
    expect(localStorage.getItem(MISSION_SPLIT_STORAGE_KEY)).toBeNull()
    localStorage.setItem(MISSION_SPLIT_STORAGE_KEY, '{not json')
    setup({ persist: true })
    expect(views.tree).toEqual(leaf(PRIMARY_PANE))
  })
  it('drops restored missions that no longer exist or are archived, once the list has loaded', () => {
    localStorage.setItem(MISSION_SPLIT_STORAGE_KEY, JSON.stringify({ tree: row(leaf(PRIMARY_PANE), column(leaf('gone'), row(leaf('kept'), leaf('old')))) }))
    const { rerender } = setup({ persist: true, missions: known([], { loading: true }) })
    expect(splitLeaves(views.tree)).toEqual([PRIMARY_PANE, 'gone', 'kept', 'old'])
    rerender({ primaryId: 'p', missions: { ...known(['kept']), conversations: [mission('kept'), mission('old', '2026-01-01')] } })
    expect(views.tree).toEqual(row(leaf(PRIMARY_PANE), leaf('kept')))
  })
  it('keeps a freshly opened pane until it has been listed and then disappears', () => {
    const { rerender } = setup({ missions: known(['a']) })
    act(() => views.open('fresh'))
    rerender({ primaryId: 'p', missions: known(['a']) })
    expect(views.conversationIds).toEqual(['fresh'])
    rerender({ primaryId: 'p', missions: known(['a', 'fresh']) })
    rerender({ primaryId: 'p', missions: known(['a']) })
    expect(views.conversationIds).toEqual([])
  })
  it('in the Archived scope drops listed (archived) panes and keeps the rest', () => {
    const { rerender } = setup({ missions: known(['a', 'b']) })
    act(() => views.open('a'))
    act(() => views.open('b'))
    rerender({ primaryId: 'p', missions: known(['b'], { archiveScope: 'archived', conversations: [mission('b', 'x')] }) })
    expect(views.conversationIds).toEqual(['a'])
    rerender({ primaryId: 'p', missions: known(['a'], { error: 'offline' }) })
    expect(views.conversationIds).toEqual(['a'])
  })
})
