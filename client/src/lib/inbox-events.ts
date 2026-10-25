/**
 * Cross-feature request to open the "Needs you" inbox. The inbox is owned by
 * `features/inbox`; notifications and other shell code ask for it through a
 * window event instead of importing the feature (same idea as
 * `app-settings-events`). The inbox itself is a place (`?inbox=1`).
 */
export const OPEN_INBOX_EVENT = 'specrails:open-inbox'

export function requestOpenInbox(): void {
  try {
    window.dispatchEvent(new CustomEvent(OPEN_INBOX_EVENT))
  } catch {
    // non-DOM environment: nothing to open
  }
}
