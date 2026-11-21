import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { AgentConversation, ArchiveScope } from '../lib/agent-api'
import {
  addPaneAtEdge, equalizeAt, equalizeTree, fitTree, hasPane, leaf, movePaneInDirection, paneRects, PRIMARY_PANE,
  MIN_PANE_SIZE, removePane, replacePane, setRatioAt, splitLeaves, splitPane, swapPanes,
  type SplitNode, type SplitPath, type SplitSide, type SplitSize,
} from '../lib/mission-split-tree'
import { loadMissionSplitTree, saveMissionSplitTree } from '../lib/mission-split-storage'

export { PRIMARY_PANE }
export type { SplitSide }

export interface MissionSplitOpenOptions {
  focusComposer?: boolean
  /** Where the new pane goes; default: right of the focused pane when it is wide enough, else below. */
  side?: SplitSide
  /** The pane to split; default: the focused pane. */
  beside?: string
}

export interface MissionSplitViews {
  /** The conversation shown in the primary pane (`null`: a new mission). */
  primaryId: string | null
  /** Conversations shown in extra panes, in the order their panes were added (stable DOM order). */
  conversationIds: string[]
  primaryVisible: boolean
  /** The focused extra pane; `null` = the primary pane. */
  focusedId: string | null
  composerFocusId: string | null
  /** The arrangement of panes (`PRIMARY_PANE` or a conversation id per leaf). */
  tree: SplitNode
  /** The pane zoomed to the whole layout (a view state, the tree is unchanged). */
  maximizedId: string | null
  /** Panes actually visible (not hidden by a maximized pane or by the stacked narrow layout). */
  visiblePaneIds: readonly string[]
  open(id: string, options?: MissionSplitOpenOptions): void
  openBeside(id: string, side: SplitSide, beside?: string): void
  close(id: string): void
  closePrimary(): void
  showPrimary(): void
  /** Close any pane: the primary one hides (stays mounted), an extra one closes. */
  closePane(paneId: string): void
  focus(id: string | null): void
  focusExisting(id: string): boolean
  /** Focus a pane by pane id (`PRIMARY_PANE` included). */
  focusPane(paneId: string): void
  move(paneId: string, side: SplitSide): void
  swap(a: string, b: string): void
  setRatio(path: SplitPath, ratio: number): void
  /** Equalize one split (`path`) or the whole layout. */
  equalize(path?: SplitPath): void
  toggleMaximize(paneId?: string): void
  /** The layout reports its pixel size (for default split sides) and whether it shows panes stacked. */
  reportLayout(size: SplitSize, stacked: boolean): void
  layoutSize(): SplitSize
}
const noop = () => {}
const DEFAULT_TREE = leaf(PRIMARY_PANE)
const Context = createContext<MissionSplitViews>({ primaryId: null, conversationIds: [], primaryVisible: true, focusedId: null, composerFocusId: null,
  tree: DEFAULT_TREE, maximizedId: null, visiblePaneIds: [PRIMARY_PANE],
  open: noop, openBeside: noop, close: noop, closePrimary: noop, showPrimary: noop, closePane: noop, focus: noop, focusExisting: () => false,
  focusPane: noop, move: noop, swap: noop, setRatio: noop, equalize: noop, toggleMaximize: noop, reportLayout: noop, layoutSize: () => ({ width: 0, height: 0 }) })

interface LayoutState {
  tree: SplitNode
  /** Extra panes in the order they were added: the DOM order, never reordered by moves. */
  order: string[]
  focusedId: string | null
  composerFocusId: string | null
  maximizedId: string | null
}

const toPane = (id: string | null) => id ?? PRIMARY_PANE
const fromPane = (paneId: string) => paneId === PRIMARY_PANE ? null : paneId

/** A layout state whose order, focus and zoom agree with its tree. */
function settle(state: LayoutState, tree: SplitNode | null): LayoutState {
  const next = tree ?? DEFAULT_TREE
  const order = state.order.filter(id => hasPane(next, id))
  for (const id of splitLeaves(next)) if (id !== PRIMARY_PANE && !order.includes(id)) order.push(id)
  return {
    tree: next,
    order: order.length === state.order.length && order.every((id, index) => id === state.order[index]) ? state.order : order,
    focusedId: hasPane(next, toPane(state.focusedId)) ? state.focusedId : fromPane(splitLeaves(next)[0] ?? PRIMARY_PANE),
    composerFocusId: state.composerFocusId && hasPane(next, state.composerFocusId) ? state.composerFocusId : null,
    maximizedId: state.maximizedId && hasPane(next, state.maximizedId) && next.type === 'split' ? state.maximizedId : null,
  }
}

/** Right of the pane when it holds two panes side by side, else below when it holds two stacked, else right. */
export function defaultSplitSide(tree: SplitNode, paneId: string, size: SplitSize): SplitSide {
  if (size.width <= 0 || size.height <= 0) return 'right'
  const rect = paneRects(fitTree(tree, size)).get(paneId)
  if (!rect) return 'right'
  if (rect.width * size.width >= MIN_PANE_SIZE.width * 2) return 'right'
  if (rect.height * size.height >= MIN_PANE_SIZE.height * 2) return 'down'
  return 'right'
}

export interface MissionSplitKnownMissions {
  conversations: readonly AgentConversation[]
  loading: boolean
  error: string | null
  archiveScope: ArchiveScope
}

function initialState(persist: boolean): LayoutState {
  const stored = persist ? loadMissionSplitTree() : null
  const tree = stored ?? DEFAULT_TREE
  return settle({ tree, order: [], focusedId: null, composerFocusId: null, maximizedId: null }, tree)
}

/**
 * Window-local layout. Closing a pane never deletes its conversation or aborts
 * a turn. With `persist`, the arrangement and its ratios survive reloads
 * (missions that no longer exist or were archived are dropped on restore).
 */
export function MissionSplitViewsProvider({ primaryId, missions, persist = false, children }: {
  primaryId: string | null
  missions?: MissionSplitKnownMissions
  persist?: boolean
  children: ReactNode
}) {
  const [state, setState] = useState<LayoutState>(() => initialState(persist))
  const [stacked, setStacked] = useState(false)
  const sizeRef = useRef<SplitSize>({ width: 0, height: 0 })
  const update = useCallback((change: (state: LayoutState) => LayoutState | null) => {
    setState(current => change(current) ?? current)
  }, [])

  // Switching the primary mission: a mission already open in a pane takes the
  // primary pane's place (or simply goes when the primary pane is shown), and
  // a hidden primary pane comes back.
  const previousPrimary = useRef(primaryId)
  useEffect(() => {
    const previous = previousPrimary.current
    previousPrimary.current = primaryId
    if (previous === primaryId) return
    update(current => {
      let tree: SplitNode | null = current.tree
      if (primaryId && hasPane(tree, primaryId)) {
        tree = hasPane(tree, PRIMARY_PANE) ? removePane(tree, primaryId).tree : replacePane(tree, primaryId, PRIMARY_PANE)
      } else if (previous !== null && !hasPane(tree, PRIMARY_PANE)) {
        tree = addPaneAtEdge(tree, PRIMARY_PANE, 'left')
      } else if (tree === current.tree) return { ...current, focusedId: null, composerFocusId: null }
      return settle({ ...current, focusedId: null, composerFocusId: null }, tree)
    })
  }, [primaryId, update])

  // Persist the arrangement (main window only); the default single pane clears it.
  useEffect(() => {
    if (!persist) return
    saveMissionSplitTree(state.tree.type === 'leaf' && state.tree.paneId === PRIMARY_PANE ? null : state.tree)
  }, [persist, state.tree])

  // Drop panes whose mission was archived or deleted. Restored panes are checked
  // against the first list; a pane opened since (a fresh fork) only goes once
  // it has been listed and then disappears, so a list fetched before it existed
  // never closes it.
  const restoredRef = useRef<Set<string> | null>(new Set(splitLeaves(state.tree).filter(id => id !== PRIMARY_PANE)))
  const seenRef = useRef(new Set<string>())
  useEffect(() => {
    if (!missions || missions.loading || missions.error) return
    const listed = new Map(missions.conversations.map(conversation => [conversation.id, conversation]))
    const restored = restoredRef.current
    const scopeHasActive = missions.archiveScope !== 'archived'
    const keep = (id: string): boolean => {
      if (id === PRIMARY_PANE) return true
      const conversation = listed.get(id)
      if (conversation) return !conversation.archivedAt && missions.archiveScope !== 'archived'
      if (!scopeHasActive) return true
      return !(restored?.has(id) || seenRef.current.has(id))
    }
    if (scopeHasActive) {
      restoredRef.current = null
      for (const id of listed.keys()) seenRef.current.add(id)
    }
    update(current => {
      const drop = splitLeaves(current.tree).filter(id => !keep(id))
      if (!drop.length) return null
      let tree: SplitNode | null = current.tree
      for (const id of drop) tree = removePane(tree, id).tree
      return settle(current, tree)
    })
  }, [missions, update])

  const layoutSize = useCallback(() => sizeRef.current, [])
  const reportLayout = useCallback((size: SplitSize, nextStacked: boolean) => {
    sizeRef.current = size
    setStacked(nextStacked)
  }, [])

  const open = useCallback((id: string, options?: MissionSplitOpenOptions) => {
    update(current => {
      const composerFocusId = options?.focusComposer ? id : null
      if (id === primaryId) {
        const tree = hasPane(current.tree, PRIMARY_PANE) ? current.tree : addPaneAtEdge(current.tree, PRIMARY_PANE, 'left')
        return settle({ ...current, focusedId: null, composerFocusId, maximizedId: null }, tree)
      }
      if (hasPane(current.tree, id) && !options?.side) {
        return { ...current, focusedId: id, composerFocusId, maximizedId: current.maximizedId && current.maximizedId !== id ? null : current.maximizedId }
      }
      const focused = toPane(current.focusedId)
      const target = options?.beside && hasPane(current.tree, options.beside) ? options.beside
        : hasPane(current.tree, focused) ? focused : splitLeaves(current.tree)[0]!
      const side = options?.side ?? defaultSplitSide(current.tree, target, sizeRef.current)
      return settle({ ...current, focusedId: id, composerFocusId, maximizedId: null }, splitPane(current.tree, target, id, side))
    })
  }, [primaryId, update])
  const openBeside = useCallback((id: string, side: SplitSide, beside?: string) => open(id, { side, beside }), [open])

  const closePane = useCallback((paneId: string) => {
    update(current => {
      if (!hasPane(current.tree, paneId)) return null
      // The primary pane only hides while another pane remains.
      if (paneId === PRIMARY_PANE && current.tree.type === 'leaf') return null
      const removed = removePane(current.tree, paneId)
      const focusedId = toPane(current.focusedId) === paneId ? fromPane(removed.focus ?? PRIMARY_PANE) : current.focusedId
      return settle({ ...current, focusedId }, removed.tree)
    })
  }, [update])
  const close = useCallback((id: string) => closePane(id), [closePane])
  const closePrimary = useCallback(() => closePane(PRIMARY_PANE), [closePane])
  const showPrimary = useCallback(() => {
    update(current => {
      if (hasPane(current.tree, PRIMARY_PANE)) return { ...current, focusedId: null, maximizedId: current.maximizedId === PRIMARY_PANE ? PRIMARY_PANE : null }
      return settle({ ...current, focusedId: null, maximizedId: null }, addPaneAtEdge(current.tree, PRIMARY_PANE, 'left'))
    })
  }, [update])

  const focus = useCallback((id: string | null) => {
    update(current => current.focusedId === id ? null : { ...current, focusedId: id })
  }, [update])
  const focusPane = useCallback((paneId: string) => focus(fromPane(paneId)), [focus])
  const conversationIdsRef = useRef(state.order)
  conversationIdsRef.current = state.order
  const focusExisting = useCallback((id: string) => {
    if (!conversationIdsRef.current.includes(id)) return false
    update(current => ({ ...current, focusedId: id, maximizedId: current.maximizedId && current.maximizedId !== id ? null : current.maximizedId }))
    return true
  }, [update])

  const move = useCallback((paneId: string, side: SplitSide) => {
    update(current => settle(current, movePaneInDirection(current.tree, paneId, side)))
  }, [update])
  const swap = useCallback((a: string, b: string) => {
    update(current => settle(current, swapPanes(current.tree, a, b)))
  }, [update])
  const setRatio = useCallback((path: SplitPath, ratio: number) => {
    update(current => settle(current, setRatioAt(current.tree, path, ratio)))
  }, [update])
  const equalize = useCallback((path?: SplitPath) => {
    update(current => settle(current, path ? equalizeAt(current.tree, path) : equalizeTree(current.tree)))
  }, [update])
  const toggleMaximize = useCallback((paneId?: string) => {
    update(current => {
      const target = paneId ?? toPane(current.focusedId)
      if (current.tree.type === 'leaf' || !hasPane(current.tree, target)) return current.maximizedId ? { ...current, maximizedId: null } : null
      return { ...current, maximizedId: current.maximizedId === target ? null : target, focusedId: fromPane(target) }
    })
  }, [update])

  const visiblePaneIds = useMemo(() => {
    const panes = splitLeaves(state.tree)
    const only = state.maximizedId ?? (stacked && panes.length > 1 ? toPane(state.focusedId) : null)
    return only && panes.includes(only) ? [only] : panes
  }, [state.tree, state.maximizedId, state.focusedId, stacked])

  const primaryVisible = hasPane(state.tree, PRIMARY_PANE)
  const value = useMemo<MissionSplitViews>(() => ({
    primaryId, conversationIds: state.order, primaryVisible, focusedId: state.focusedId, composerFocusId: state.composerFocusId,
    tree: state.tree, maximizedId: state.maximizedId, visiblePaneIds,
    open, openBeside, close, closePrimary, showPrimary, closePane, focus, focusExisting, focusPane,
    move, swap, setRatio, equalize, toggleMaximize, reportLayout, layoutSize,
  }), [primaryId, state, primaryVisible, visiblePaneIds, open, openBeside, close, closePrimary, showPrimary, closePane, focus, focusExisting, focusPane,
    move, swap, setRatio, equalize, toggleMaximize, reportLayout, layoutSize])
  return <Context.Provider value={value}>{children}</Context.Provider>
}
export function useMissionSplitViews() { return useContext(Context) }

const LayoutContext = createContext('agent-composer-dock')
const PaneContext = createContext<(() => void) | null>(null)
const PaneIdContext = createContext<string | null>(null)
/** `splitPaneId` names the pane inside the split layout (`PRIMARY_PANE` for the primary one). */
export function MissionPaneControls({ onClose, paneId, splitPaneId, children }: {
  onClose: (() => void) | null; paneId?: string; splitPaneId?: string; children: ReactNode
}) {
  const inheritedLayout = useContext(LayoutContext)
  const inheritedPane = useContext(PaneIdContext)
  return <PaneIdContext.Provider value={splitPaneId ?? inheritedPane}><PaneContext.Provider value={onClose}>
    <LayoutContext.Provider value={paneId ? `agent-composer-dock:${paneId}` : inheritedLayout}>{children}</LayoutContext.Provider>
  </PaneContext.Provider></PaneIdContext.Provider>
}
export function useMissionPaneClose() { return useContext(PaneContext) }
/** The split pane this surface renders in, or null outside the split layout. */
export function useMissionPaneId() { return useContext(PaneIdContext) }

export function useMissionPaneLayoutId() { return useContext(LayoutContext) }
