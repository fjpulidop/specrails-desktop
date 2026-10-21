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

/**
 * Flow mode needs two Core capabilities: `flowSessions` (interrupt delivery in
 * agent sessions) and `deriveChange` (the derive-change node the Flow -> Spec
 * loop runs). Flow is offered only when Core sessions are usable AND both are
 * advertised; there is no legacy path. Pure.
 */
export interface FlowAvailability {
  available: boolean
  reason: string
  /** Capabilities the selected Core lacks (empty when available). */
  missing: Array<'sessions' | 'flowSessions' | 'deriveChange'>
}

export function resolveFlowAvailability(sessions: CoreSessionsAvailability, capabilities: Record<string, number> | undefined | null): FlowAvailability {
  const missing: FlowAvailability['missing'] = []
  if (!sessions.enabled) missing.push('sessions')
  if ((capabilities?.flowSessions ?? 0) < 1) missing.push('flowSessions')
  if ((capabilities?.deriveChange ?? 0) < 1) missing.push('deriveChange')
  if (missing.length === 0) return { available: true, reason: 'Flow is available', missing }
  const reason = !sessions.enabled
    ? `Flow needs Core agent sessions: ${sessions.reason}`
    : `Flow needs a Core that advertises ${missing.join(' and ')}; update Core to use Flow`
  return { available: false, reason, missing }
}
