/**
 * Cross-feature request to open the live board. The board is owned by
 * `features/live-board`; the shell, the sidebar and the command palette ask
 * for it through a window event instead of importing the feature (same idea as
 * `inbox-events`). The board itself is a place (`?live=1`).
 */
export const OPEN_LIVE_BOARD_EVENT = 'specrails:open-live-board'

export function requestOpenLiveBoard(): void {
  try {
    window.dispatchEvent(new CustomEvent(OPEN_LIVE_BOARD_EVENT))
  } catch {
    // non-DOM environment: nothing to open
  }
}
