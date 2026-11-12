/**
 * Project the app should switch to when a mission is selected, or null for no switch.
 * Home missions (no pin), unregistered projects and the already-active project never switch.
 */
export function resolveMissionProjectSwitch(
  missionProjectId: string | null | undefined,
  activeProjectId: string | null,
  projects: ReadonlyArray<{ id: string }>,
): string | null {
  if (!missionProjectId) return null
  if (missionProjectId === activeProjectId) return null
  if (!projects.some((p) => p.id === missionProjectId)) return null
  return missionProjectId
}
