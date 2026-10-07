/**
 * Agent sessions: Desktop as the host of Core's agent session runtime.
 * Public API for conversational features (missions first). Adapters and the
 * runtime registry are exposed through focused subpaths, not this barrel.
 */
export {
  SUPPORTED_PROTOCOL_VERSIONS,
  KNOWN_EVENT_TYPES,
  checkSessionContract,
  type DriverDescriptor,
  type InitializeResult,
  type McpServerSpec,
  type SessionContractBlock,
  type SessionContractCheck,
  type SessionEvent,
  type SessionEventEnvelope,
  type SessionPhase,
  type SessionPolicyInput,
  type SubagentPhase,
  type ToolActivity,
  type TurnOrigin,
  type TurnStatus,
  type Usage,
} from './domain/protocol'
export { SessionRequestError, isSessionRequestError } from './domain/errors'
export { initialProjection, liveSubagentCount, reduceEnvelope, type ProjectionOp, type ProjectionState, type SubagentView } from './domain/projection'
export { DEFAULT_SUPERVISION, acceptsSessions, type HostStatus, type HostSupervisionPolicy } from './domain/host-state'
export { SessionEventPump, type PumpListener } from './application/session-event-pump'
export type { Clock, HostProcessLauncher, ProjectionSink, SessionHostClient, TimerHandle } from './ports'
