/**
 * What the main window shows of missions right now, published by the mission
 * reply notifier on every render so other attention sources (the inbox) can
 * tell whether an item's mission is already in front of the person.
 * UI state of this window only; it holds no project data.
 */
import { isMainFocused, type WindowFocus } from './window-focus'

/** Routes that cover the Mission-mode centre (the mission is not visible behind them). */
export const CENTRE_ROUTES = ['/loops', '/plugins', '/docs', '/settings']

export interface MissionScreen {
  uiMode: 'kanban' | 'agent'
  pathname: string
  activeId: string | null
  primaryVisible: boolean
  splitIds: readonly string[]
  chatOpen: boolean
  /** conversationId → the label of the native window it is detached to. */
  detached: ReadonlyMap<string, string>
}

/** Is this mission what the person is looking at, given the focus? */
export function missionOnScreen(conversationId: string, screen: MissionScreen, focus: WindowFocus): boolean {
  const windowLabel = screen.detached.get(conversationId)
  if (windowLabel) return focus.label === windowLabel
  if (!isMainFocused(focus)) return false
  if (screen.uiMode === 'kanban') return screen.chatOpen && screen.activeId === conversationId
  if (screen.splitIds.includes(conversationId)) return true
  return screen.primaryVisible && screen.activeId === conversationId && !CENTRE_ROUTES.some((route) => screen.pathname.startsWith(route))
}

let current: MissionScreen | null = null

export function publishMissionScreen(screen: MissionScreen | null): void {
  current = screen
}

/** Is this mission on screen right now (false until the main window has published its screen)? */
export function isMissionOnScreen(conversationId: string, focus: WindowFocus): boolean {
  return !!current && missionOnScreen(conversationId, current, focus)
}
