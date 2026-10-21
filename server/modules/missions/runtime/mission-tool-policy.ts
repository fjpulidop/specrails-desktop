import { isMissionReadOnlyEnabled } from '../../../feature-flags'
import { supportsToolPolicy } from '../../../providers/runtime'
import type { ProviderAdapter } from '../../../providers/types'
import type { DriverDescriptor, SessionPolicyInput } from '../../agent-sessions'

/**
 * Mission read-only policy (mission-read-only-policy).
 *
 * Mission agents drive the app through the `specrails_*` MCP tools; they never
 * edit a workspace themselves. This module turns that rule into the provider's
 * native boundary so it holds by construction rather than by prompt wording:
 * the only write-capable mission mode is Flow, which uses its own session.
 *
 * Every mapping keeps MCP tools callable — verified per provider in the
 * change's design. `SPECRAILS_MISSION_READ_ONLY=false` restores the previous
 * write-capable argv and session policy without a release.
 */

export interface MissionSpawnPolicy {
  toolPolicy?: 'read-only'
  retainMcpTools?: true
}

/** Why a mission does not run read-only, for logs and the turn status line. */
export type MissionReadOnlyGap = 'disabled' | 'unsupported'

/**
 * Spawn options for a legacy (one-shot or native live) mission turn. Providers
 * without a native read-only mode (Kimi prompt mode) keep their default tools:
 * a mission must still work, and prompt-only guidance is not a boundary.
 */
export function missionSpawnPolicy(adapter: ProviderAdapter): MissionSpawnPolicy {
  if (!isMissionReadOnlyEnabled() || !supportsToolPolicy(adapter, 'read-only')) return {}
  return { toolPolicy: 'read-only', retainMcpTools: true }
}

/** The reason a provider's mission turns stay write-capable, or null when read-only. */
export function missionReadOnlyGap(adapter: ProviderAdapter): MissionReadOnlyGap | null {
  if (!isMissionReadOnlyEnabled()) return 'disabled'
  return supportsToolPolicy(adapter, 'read-only') ? null : 'unsupported'
}

/**
 * Permission and tool fields of a mission's Core session policy. Uses the
 * adapter's declared read-only session mapping when the Core driver can
 * enforce it; otherwise keeps the legacy mapping (`sessionPermissions`).
 * A tool restriction is only requested from a driver with `toolFiltering`,
 * because Core refuses an unenforceable policy instead of ignoring it.
 */
export function missionSessionBoundary(
  adapter: ProviderAdapter,
  driver: DriverDescriptor | undefined,
): Pick<SessionPolicyInput, 'permissions' | 'tools'> {
  const legacy = { permissions: adapter.capabilities.sessionPermissions ?? 'workspace-write' } as const
  const readOnly = adapter.capabilities.missionReadOnlySession
  if (!isMissionReadOnlyEnabled() || !readOnly) return legacy
  if (readOnly.tools === 'read-only' && driver?.capabilities.toolFiltering !== true) return legacy
  return {
    permissions: readOnly.permissions,
    ...(readOnly.tools === 'read-only' ? { tools: { mode: 'read-only' as const } } : {}),
  }
}

/** True when a session boundary actually prevents workspace writes. */
export function isReadOnlySessionBoundary(boundary: Pick<SessionPolicyInput, 'permissions' | 'tools'>): boolean {
  return boundary.permissions === 'read-only' || boundary.tools?.mode === 'read-only'
}
