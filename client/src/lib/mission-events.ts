/**
 * Cross-feature request to open a mission. Missions are owned by
 * `features/missions`; the inbox (mounted above the mission providers) and other
 * shell code ask for one through a window event instead of importing the
 * feature (same idea as `inbox-events`). `MissionOpenRequests` answers it.
 */
export const OPEN_MISSION_EVENT = 'specrails:open-mission'

export interface OpenMissionDetail {
  conversationId: string
}

export function requestOpenMission(conversationId: string): void {
  try {
    window.dispatchEvent(new CustomEvent<OpenMissionDetail>(OPEN_MISSION_EVENT, { detail: { conversationId } }))
  } catch {
    // non-DOM environment: nothing to open
  }
}
