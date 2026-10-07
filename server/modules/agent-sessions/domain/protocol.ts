/**
 * Session protocol v1 wire types, as Desktop consumes them from the Core
 * session host (`specrails-core runtime host --stdio`). This is Desktop's
 * anti-corruption layer for the protocol: Core's internals never leak in.
 * Drift is checked against the resolved Core's integration contract
 * (`agentRuntime.sessions`) by `checkSessionContract` and check-core-compat.
 */

export const SUPPORTED_PROTOCOL_VERSIONS: readonly number[] = Object.freeze([1])

/** Event types this Desktop understands; newer Cores may send more (ignored). */
export const KNOWN_EVENT_TYPES = Object.freeze([
  'session.opened',
  'session.phase',
  'session.process',
  'session.provider-ref',
  'session.updated',
  'session.closed',
  'input.accepted',
  'input.state',
  'turn.started',
  'turn.output',
  'turn.tool',
  'turn.completed',
  'subagent.started',
  'subagent.phase',
  'subagent.output',
  'subagent.usage',
  'subagent.result',
  'subagents.settled',
  'output.truncated',
  'notice.interruption',
  'provider.diagnostic',
] as const)

export type SessionPhase = 'idle' | 'turn' | 'background'
export type TurnOrigin = 'user' | 'subagent' | 'system'
export type TurnStatus = 'completed' | 'failed' | 'stopped' | 'interrupted'
export type SubagentPhase = 'running' | 'idle' | 'failed' | 'stopped' | 'killed' | 'interrupted'

export interface Usage {
  inputTokens: number | null
  outputTokens: number | null
  cacheReadTokens: number | null
  cacheWriteTokens: number | null
  totalTokens: number | null
  costUsd: number | null
  costEstimated: boolean
  model: string | null
}

export interface ToolActivity {
  toolUseId: string
  name: string
  phase: 'started' | 'completed'
  input?: unknown
  output?: string
  isError?: boolean
}

export type SessionEvent = { at: string } & (
  | { type: 'session.opened'; driver: string; model: string; effort?: string; resumed: boolean; providerSessionRef: string | null }
  | { type: 'session.phase'; phase: SessionPhase }
  | { type: 'session.process'; state: 'started' | 'retired' | 'exited'; generation: number; reason?: string; exitCode?: number | null }
  | { type: 'session.provider-ref'; providerSessionRef: string }
  | { type: 'session.updated'; changes: Record<string, unknown>; outcome: 'applied' | 'deferred' }
  | { type: 'session.closed'; reason: string }
  | { type: 'input.accepted'; inputId: string; delivery: 'queue' | 'steer'; text: string }
  | { type: 'input.state'; inputId: string; state: 'queued' | 'started' | 'completed' | 'rejected' | 'interrupted'; turnId?: string; reason?: string }
  | { type: 'turn.started'; turnId: string; origin: TurnOrigin; inputIds: string[]; trigger?: { subagentIds: string[] } }
  | { type: 'turn.output'; turnId: string; channel: 'text' | 'thinking'; delta: string }
  | ({ type: 'turn.tool'; turnId: string } & ToolActivity)
  | { type: 'turn.completed'; turnId: string; status: TurnStatus; text: string; error?: string; usage: Usage }
  | { type: 'subagent.started'; subagentId: string; parentId: string | null; kind: 'foreground' | 'background'; agentType?: string; description: string; prompt?: string }
  | { type: 'subagent.phase'; subagentId: string; phase: SubagentPhase; reason?: string }
  | { type: 'subagent.output'; subagentId: string; channel: 'text' | 'tool'; delta?: string; tool?: ToolActivity }
  | { type: 'subagent.usage'; subagentId: string; usage: Usage; toolUses?: number; durationMs?: number }
  | { type: 'subagent.result'; subagentId: string; summary: string }
  | { type: 'subagents.settled'; settled: boolean; live: number }
  | { type: 'output.truncated'; scope: { turnId: string } | { subagentId: string }; droppedEvents: number; droppedBytes: number }
  | { type: 'notice.interruption'; subagentIds: string[]; inputIds: string[] }
  | { type: 'provider.diagnostic'; level: 'info' | 'warning'; code: string; message: string }
)

export interface SessionEventEnvelope {
  sessionId: string
  seq: number
  event: SessionEvent
}

export interface DriverDescriptor {
  id: string
  displayName: string
  capabilities: {
    resident: boolean
    nativeInputQueue: boolean
    subagents: 'supported' | 'unsupported'
    subagentDisable: boolean
    autonomousContinuation: boolean
    steer: boolean
    toolFiltering: boolean
    usage: { costUsd: 'session-cumulative' | 'per-turn' | 'none'; tokens: 'per-turn' | 'cumulative' | 'none' }
  }
}

export interface McpServerSpec {
  name: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
  /** The host authorizes each call itself; providers must not gate this server's tools. */
  autoApprove?: boolean
}

export interface SessionPolicyInput {
  subagents: 'enabled' | 'disabled'
  onSubagentsSettled?: 'provider-native' | 'resume-agent' | 'notify-only'
  tools?: { mode: 'default' | 'read-only' | 'none'; allow?: string[]; deny?: string[] }
  permissions?: 'bypass' | 'workspace-write' | 'read-only'
  mcp?: { servers?: McpServerSpec[]; inheritUserScope?: boolean }
  limits?: Partial<Record<'idleMs' | 'stallMs' | 'backgroundMaxMs' | 'turnInactivityMs' | 'maxSettleHandoffs' | 'settleDebounceMs', number>>
}

export interface InitializeResult {
  protocolVersion: number
  scope: string
  runtime: Record<string, unknown>
  capabilities: { sessions?: number }
  drivers: DriverDescriptor[]
}

/** `error.data` of a failed protocol request. */
export interface SessionErrorData {
  code: string
  retryable: boolean
  detail?: Record<string, unknown>
}

/** The `agentRuntime.sessions` block of Core's integration contract. */
export interface SessionContractBlock {
  version: number
  protocolVersions: number[]
  capability: string
  cliOperation: string
  eventTypes: string[]
}

export interface SessionContractCheck {
  compatible: boolean
  protocolVersion: number | null
  /** Event types Core may send that this Desktop ignores. */
  unknownEventTypes: string[]
  /** Event types this Desktop expects that Core no longer declares. */
  missingEventTypes: string[]
  reasons: string[]
}

/** Compare a Core contract block with what this Desktop speaks. Pure. */
export function checkSessionContract(block: SessionContractBlock | undefined | null): SessionContractCheck {
  if (!block) return { compatible: false, protocolVersion: null, unknownEventTypes: [], missingEventTypes: [], reasons: ['Core does not declare agentRuntime.sessions'] }
  const common = block.protocolVersions.filter((version) => SUPPORTED_PROTOCOL_VERSIONS.includes(version))
  const declared = new Set(block.eventTypes)
  const known = new Set<string>(KNOWN_EVENT_TYPES)
  const missingEventTypes = KNOWN_EVENT_TYPES.filter((type) => !declared.has(type))
  const reasons: string[] = []
  if (common.length === 0) reasons.push(`No common protocol version (Core ${block.protocolVersions.join(', ')}; Desktop ${SUPPORTED_PROTOCOL_VERSIONS.join(', ')})`)
  if (block.cliOperation !== 'host') reasons.push(`Unexpected session CLI operation "${block.cliOperation}"`)
  if (missingEventTypes.length) reasons.push(`Core no longer declares: ${missingEventTypes.join(', ')}`)
  return {
    compatible: reasons.length === 0,
    protocolVersion: common.length ? Math.max(...common) : null,
    unknownEventTypes: block.eventTypes.filter((type) => !known.has(type)),
    missingEventTypes,
    reasons,
  }
}
