/**
 * Cross-feature request to replay the platform tour (the onboarding wizard).
 * The wizard is owned by the app shell (App.tsx), so Help surfaces (the guide,
 * the command palette) ask for it through a window event instead of importing
 * the shell, exactly like `openDocs` and `openAppSettings`.
 */
export const REPLAY_TOUR_EVENT = 'specrails:replay-tour'

export function replayTour(): void {
  try {
    window.dispatchEvent(new CustomEvent(REPLAY_TOUR_EVENT))
  } catch {
    // non-DOM environment — nothing to replay
  }
}
