/**
 * The mission chat's WebSocket `agent_*` frame shape, the window-wide live
 * id counters, and how a turn failure reads for the person: known Core
 * failures localized, others keep the server's own text.
 */
import i18n from '../../../lib/i18n'
import type { AgentContextReference, AgentDeliveryReceipt, AgentMessage } from './agent-api'

/**
 * Known Core turn failures, matched on Core's own (English) wording, read in
 * the person's language. Order matters: the tool variant contains the plain one.
 */
const KNOWN_TURN_ERRORS: ReadonlyArray<readonly [string, string]> = [
  ['A tool call produced no provider activity before the tool inactivity limit', 'agent:turnErrors.toolInactivity'],
  ['No provider activity before the inactivity limit', 'agent:turnErrors.providerInactivity'],
]

/** A Core failure the user can act on reads in their language; others keep the server text. */
/** Toast form of a turn failure: always a localized headline; the server's own text stays secondary. */
export function describeAgentErrorToast(msg: Pick<WsAgentMsg, 'error' | 'code' | 'provider'>): { title: string; detail?: string } {
  const explained = msg.code === 'policy_unenforceable' || (!!msg.error && KNOWN_TURN_ERRORS.some(([text]) => msg.error!.includes(text)))
  return explained ? { title: describeAgentError(msg) } : { title: i18n.t('agent:turnErrors.generic'), detail: msg.error || undefined }
}

export function describeAgentError(msg: Pick<WsAgentMsg, 'error' | 'code' | 'provider'>): string {
  if (msg.code === 'policy_unenforceable') {
    const provider = msg.provider ? msg.provider.charAt(0).toUpperCase() + msg.provider.slice(1) : ''
    return i18n.t('agent:subagents.policyUnenforceable', { provider })
  }
  const known = msg.error ? KNOWN_TURN_ERRORS.find(([text]) => msg.error!.includes(text)) : undefined
  if (known) return i18n.t(known[1])
  return msg.error || i18n.t('agent:turnErrors.generic')
}

export interface WsAgentMsg {
  type: string
  conversationId?: string
  /** Set on the blueprint-commit placeholder: open it without user action. */
  openOnArrival?: boolean
  delta?: string
  fullText?: string
  /** Core session turn a user turn settled (agent_done). */
  coreTurnId?: string
  error?: string
  /** Known failure the client explains in the user's language. */
  code?: string
  provider?: string
  tool?: string
  input?: string
  toolId?: string
  output?: string
  isError?: boolean
  timestamp?: string
  queueId?: string | null
  text?: string
  contextRefs?: AgentContextReference[]
  attachmentIds?: string[]
  deliveryMode?: 'queue' | 'steer'
  deliveryStatus?: 'delivered' | 'interrupted'
  delivery_receipt?: AgentDeliveryReceipt
  deliveryReceipt?: AgentDeliveryReceipt
  receipt?: 'received' | 'read'
  messageId?: string
  assistantSegment?: { id: string; content: string; created_at: string }
  messages?: AgentMessage[]
  /** Core agent sessions: set on events of turns the agent runs after background work. */
  turnId?: string
  origin?: 'user' | 'subagent' | 'system'
}

let _toolSeq = 0
let _queueSeq = 0
/** Window-wide id counters for live tool chips and client-side queue ids. */
export const nextToolSeq = (): number => _toolSeq++
export const nextQueueSeq = (): number => _queueSeq++
