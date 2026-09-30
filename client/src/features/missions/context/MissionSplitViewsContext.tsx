import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

interface MissionSplitViews {
  conversationIds: string[]
  primaryVisible: boolean
  focusedId: string | null
  open(id: string): void
  close(id: string): void
  closePrimary(): void
  showPrimary(): void
  focus(id: string | null): void
  focusExisting(id: string): boolean
}
const noop = () => {}
const Context = createContext<MissionSplitViews>({ conversationIds: [], primaryVisible: true, focusedId: null,
  open: noop, close: noop, closePrimary: noop, showPrimary: noop, focus: noop, focusExisting: () => false })

/** Window-local layout. Closing a pane never deletes its conversation or aborts a turn. */
export function MissionSplitViewsProvider({ primaryId, children }: { primaryId: string | null; children: ReactNode }) {
  const [conversationIds, setIds] = useState<string[]>([])
  const [primaryVisible, setPrimaryVisible] = useState(true)
  const [focusedId, focus] = useState<string | null>(null)
  useEffect(() => {
    setIds(ids => ids.filter(id => id !== primaryId))
    setPrimaryVisible(true)
    focus(null)
  }, [primaryId])
  const open = useCallback((id: string) => {
    if (id === primaryId) { setPrimaryVisible(true); focus(null); return }
    setIds(ids => ids.includes(id) ? ids : [...ids, id])
    focus(id)
  }, [primaryId])
  const close = useCallback((id: string) => {
    setIds(ids => ids.filter(value => value !== id))
    focus(current => current === id ? null : current)
  }, [])
  useEffect(() => { if (!conversationIds.length) setPrimaryVisible(true) }, [conversationIds.length])
  const showPrimary = useCallback(() => { setPrimaryVisible(true); focus(null) }, [])
  const closePrimary = useCallback(() => { if (conversationIds.length) { setPrimaryVisible(false); focus(conversationIds[0]) } }, [conversationIds])
  const focusExisting = useCallback((id: string) => {
    if (!conversationIds.includes(id)) return false
    focus(id)
    return true
  }, [conversationIds])
  const value = useMemo(() => ({ conversationIds, primaryVisible, focusedId, open, close, closePrimary, showPrimary, focus, focusExisting }),
    [conversationIds, primaryVisible, focusedId, open, close, closePrimary, showPrimary, focusExisting])
  return <Context.Provider value={value}>{children}</Context.Provider>
}
export function useMissionSplitViews() { return useContext(Context) }

const LayoutContext = createContext('agent-composer-dock')
const PaneContext = createContext<(() => void) | null>(null)
export function MissionPaneControls({ onClose, paneId, children }: { onClose: (() => void) | null; paneId?: string; children: ReactNode }) {
  const inheritedLayout = useContext(LayoutContext)
  return <PaneContext.Provider value={onClose}><LayoutContext.Provider value={paneId ? `agent-composer-dock:${paneId}` : inheritedLayout}>{children}</LayoutContext.Provider></PaneContext.Provider>
}
export function useMissionPaneClose() { return useContext(PaneContext) }

export function useMissionPaneLayoutId() { return useContext(LayoutContext) }
