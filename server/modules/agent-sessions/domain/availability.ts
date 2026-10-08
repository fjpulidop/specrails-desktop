/**
 * Whether conversational features should run on Core sessions. Pure: the
 * runtime supplies the rollout flag and the selected Core's capabilities.
 *
 * SPECRAILS_CORE_SESSIONS: `auto` (default) | `on` | `off`. `auto` uses sessions
 * only when the selected Core advertises them with a compatible contract.
 * `on` cannot force a Core without the `sessions` capability; the reason says so.
 */
export type CoreSessionsFlag = 'off' | 'auto' | 'on'

export interface CoreSessionsAvailability {
  enabled: boolean
  flag: CoreSessionsFlag
  reason: string
}

export const DEFAULT_CORE_SESSIONS_FLAG: CoreSessionsFlag = 'auto'

export function parseCoreSessionsFlag(raw: string | undefined): CoreSessionsFlag {
  const value = raw?.trim().toLowerCase()
  if (value === 'on' || value === '1' || value === 'true') return 'on'
  if (value === 'auto') return 'auto'
  if (value === 'off' || value === '0' || value === 'false') return 'off'
  return DEFAULT_CORE_SESSIONS_FLAG
}

export function resolveCoreSessionsAvailability(flag: CoreSessionsFlag, capabilities: Record<string, number> | undefined | null, contractCompatible = true): CoreSessionsAvailability {
  if (flag === 'off') return { enabled: false, flag, reason: 'Core sessions are disabled (SPECRAILS_CORE_SESSIONS=off)' }
  if (capabilities?.sessions !== 1) return { enabled: false, flag, reason: 'The selected Core does not advertise the sessions capability; using legacy transports' }
  if (!contractCompatible) return { enabled: false, flag, reason: 'The selected Core session contract is not compatible with this Desktop; using legacy transports' }
  return { enabled: true, flag, reason: flag === 'on' ? 'Core sessions forced on' : 'Core sessions available' }
}
