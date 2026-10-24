import { type PrDecisionAction } from '../..'
import type { DbInstance } from '../../../../db'
import { type GitRunner } from '../../../../worktree-manager'
import { type Exec } from '../../runtime/pr-publisher'
import type { WsMessage, PrDecisionCardEnvelope } from '../../../../types'



export interface PrDecisionDeps {
  /** Internal authority granted only by the group coordinator after parent admission. */
  repositoryChildOf?: string
  repositoryIntegrationBranch?: string
  db: DbInstance
  project: { id: string; slug: string; path: string }
  git: GitRunner
  exec: Exec
  broadcast: (msg: WsMessage) => void
  /** Optional (tests / partial contexts); calls are best-effort and never fatal. */
  jiraSyncManager?: {
    onRailMerged(ticketIds: number[], refId: string, prUrl: string | null): boolean | void
    onRailDiscard(ticketIds: number[], refId: string): boolean | void
    onRailCompleted?(ticketIds: number[], refId: string): boolean | void
    onRailRefined?(ticketIds: number[], refId: string): boolean | void
  }
  /** Agent-chat accessor (default: the process-wide registry). Null-safe. */
  agentChat?: () => { updatePrDecisionCard(conversationId: string, envelope: PrDecisionCardEnvelope): void } | null
  /** Mission agent accessor for automatic briefing turns (default: the
   * process-wide agent-chat registry). Null-safe; never fatal. */
  missionAgent?: () => {
    startAutomaticTurn(conversationId: string, text: string, opts: { turnKey: string; label: string }): Promise<'started' | 'skipped'>
  } | null
  /** Write-capable conflict resolver confined to a stash-restore worktree
   * (default: the AI merge-resolver, see runtime/local-restore-resolver). */
  localRestoreResolver?: (input: {
    worktreePath: string
    branch: string
    targetBranch: string
    conflictPaths: readonly string[]
    stashName: string
  }) => Promise<void>
  /** Ticket-store file override (tests) — default resolves via workspace-resolution. */
  ticketFile?: string
  /** Temporary local-integration worktree root override (tests). */
  assemblyRoot?: string
  /** Router-captured project generation, rechecked only after acquiring the
   * repository lock so a queued action cannot outlive project quiescence. */
  assertAdmission?: () => void
}


export interface PrDecisionInput {
  repositoryId?: string
  prDeliveryId: string
  action: PrDecisionAction
  expectedDecision: string
}


/** HTTP-shaped outcome the route relays verbatim. */
export interface PrDecisionResult {
  status: number
  body: Record<string, unknown>
}
