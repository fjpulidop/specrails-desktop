import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'
import { MissionWindowController, type MissionWindowHandlers, type MissionWindowsState } from '../lib/mission-window-controller'
import { isMissionWindowRoute, missionWindowBridge, type MissionWindowBridge } from '../lib/mission-windows'
import { isTauri } from '../lib/tauri-shell'

export interface MissionWindowsContextValue extends MissionWindowsState {
  registerHandlers(handlers: MissionWindowHandlers): () => void
  detach(projectId: string | null, conversationId: string): Promise<boolean>
  attach(): Promise<boolean>
  focus(conversationId: string): Promise<boolean>
  discard(conversationId: string): Promise<boolean>
  isEditable(conversationId: string): boolean
  isPending(conversationId: string): boolean
  clearError(): void
  refresh(): Promise<void>
}
const noop = () => {}
const fallback: MissionWindowsContextValue = {
  available: false, initialized: true, current: null, transfers: [], pending: [], error: null,
  registerHandlers: () => noop, detach: async () => false, attach: async () => false, focus: async () => false, discard: async () => false,
  isEditable: () => true, isPending: () => false, clearError: noop, refresh: async () => {},
}
const MissionWindowsContext = createContext<MissionWindowsContextValue>(fallback)

export function MissionWindowsProvider({ children, bridge = missionWindowBridge, secondary = isMissionWindowRoute() }: {
  children: ReactNode
  bridge?: MissionWindowBridge
  secondary?: boolean
}) {
  const [controller] = useState(() => new MissionWindowController(bridge, secondary, isTauri() || bridge !== missionWindowBridge))
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
  useEffect(() => {
    void controller.start()
    const refresh = () => { void controller.refresh() }
    window.addEventListener('focus', refresh)
    return () => { window.removeEventListener('focus', refresh); controller.stop() }
  }, [controller])
  const value = useMemo<MissionWindowsContextValue>(() => ({ ...state,
    registerHandlers: controller.registerHandlers, detach: controller.detach, attach: controller.attach,
    focus: controller.focus, isEditable: controller.isEditable, isPending: controller.isPending,
    discard: controller.discard,
    clearError: controller.clearError, refresh: controller.refresh,
  }), [state, controller])
  return <MissionWindowsContext.Provider value={value}>{children}</MissionWindowsContext.Provider>
}
export function useMissionWindows(): MissionWindowsContextValue { return useContext(MissionWindowsContext) }
export type { MissionWindowHandlers }
