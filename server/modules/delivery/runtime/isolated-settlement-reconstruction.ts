import path from 'node:path'
import type { DbInstance } from '../../../db'
import { readDefinitionRun, readDefinitionSuccessor } from '../../loops/runtime/loop-runs-store'
import { saveIsolatedSettlementSnapshot, type IsolatedSettlementSnapshot } from './isolated-settlement-store'
import { type RailPrDeliveryRow, type DeliverBranchRecord, TERMINAL_PR_DECISIONS } from './rail-pr-store'
import { getRailWorktree } from './rail-worktrees-store'

const unavailable = (reason: string): never => { throw new Error(`Original isolated settlement snapshot is unavailable: ${reason}`) }
const list = <T>(json: string): T[] => {
  const value: unknown = JSON.parse(json)
  return Array.isArray(value) ? value as T[] : unavailable('invalid durable list')
}
const absolute = (value: unknown): value is string => typeof value === 'string' && !value.includes('\0') && path.isAbsolute(value)
const sha = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{40,64}$/i.test(value)

/** Explicit recovery only. Proof comes from original records, never live settings
 * or checkout contents. All legs freeze together, without cleanup authority. */
export function ensureIsolatedSettlementSnapshot(db: DbInstance, projectId: string, runId: string): { delivery_id: string } | undefined {
  return db.transaction(() => {
    const frozen = readDefinitionRun(db, runId)
    // Standalone/older callers still let Loop Manager validate its own request.
    if (!frozen) return undefined
    if (frozen.row.project_id !== projectId) return unavailable('run belongs to another project')
    const existing = db.prepare('SELECT delivery_id FROM definition_delivery_settlements WHERE project_id=? AND run_id=? AND superseded_by IS NULL LIMIT 1')
      .get(projectId, runId) as { delivery_id: string } | undefined
    if (existing) return existing
    if (!frozen.request.deferTerminalOutcome) return undefined
    if (readDefinitionSuccessor(db, runId)) return unavailable('an adopted fork owns this allocation')
    const manifest = frozen.request.executionManifest
    const context = frozen.metadata.context as { runId?: unknown; repositories?: Array<{ id?: unknown; path?: unknown }> } | undefined
    if (!manifest || manifest.version !== 1 || manifest.projectId !== projectId || !manifest.repositories.length ||
      context?.runId !== runId || !Array.isArray(context.repositories)) return unavailable('original repository manifest/context is missing')
    const candidates = db.prepare(`SELECT * FROM rail_pr_deliveries WHERE repository_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(run_ids) THEN run_ids ELSE '[]' END) WHERE value=?)`)
      .all(runId) as RailPrDeliveryRow[]
    const snapshots: IsolatedSettlementSnapshot[] = []
    const seen = new Set<string>()
    const runTickets = new Set(list<number>(frozen.row.ticket_ids_json ?? unavailable('launch ticket set was not captured')))
    for (const repository of manifest.repositories) {
      if (seen.has(repository.repositoryId) || !manifest.selectedRepositoryIds.includes(repository.repositoryId)) return unavailable('ambiguous repository identity')
      seen.add(repository.repositoryId)
      if (![repository.sourcePath, repository.worktreePath, repository.gitCommonDir].every(absolute) || !sha(repository.baseSha)) return unavailable('repository paths or base identity were not captured')
      if (!context.repositories.some(item => item.id === repository.repositoryId && item.path === repository.worktreePath)) return unavailable('repository is outside the frozen Core mount')
      const matches = candidates.filter(row => row.repository_id === repository.repositoryId && list<string>(row.worktree_ids).includes(repository.worktreeId))
      if (matches.length !== 1) return unavailable('repository delivery is missing or ambiguous')
      const delivery = matches[0]
      if (TERMINAL_PR_DECISIONS.has(delivery.decision) || delivery.operation_token || delivery.is_continuation ||
        delivery.repository_path !== repository.sourcePath || delivery.parent_delivery_id !== manifest.groupId) return unavailable('delivery ownership or continuation contract changed')
      const parent = db.prepare('SELECT decision,operation_token FROM rail_pr_deliveries WHERE id=?').get(manifest.groupId) as Pick<RailPrDeliveryRow, 'decision' | 'operation_token'> | undefined
      if (!parent || TERMINAL_PR_DECISIONS.has(parent.decision) || parent.operation_token) return unavailable('delivery group ownership changed')
      const ledger = getRailWorktree(db, repository.worktreeId)
      if (!ledger || ledger.run_id !== runId || ledger.repository_id !== repository.repositoryId || ledger.repository_path !== repository.sourcePath ||
        ledger.branch !== repository.branch || ledger.worktree_path !== repository.worktreePath || !['building', 'built', 'needs-review'].includes(ledger.merge_state)) return unavailable('worktree ledger does not prove the original allocation')
      const branches = list<DeliverBranchRecord>(delivery.branches).filter(branch => branch.runId === runId)
      const branch = branches[0]
      if (!branch || !sha(branch.initialSha) || !['created', 'preexisting'].includes(branch.branchOwnership ?? '') ||
        branch.branch !== repository.branch || branch.worktreePath !== repository.worktreePath || !Array.isArray(branch.overlayExcludes) ||
        branch.overlayExcludes.some(value => typeof value !== 'string' || !value || value.includes('\0') || path.isAbsolute(value) || value.split(/[\\/]/).includes('..'))) return unavailable('initial SHA, branch or never-commit exclusions were not captured')
      if (branches.some(item => item.initialSha !== branch.initialSha || item.branchOwnership !== branch.branchOwnership || item.branch !== branch.branch ||
        item.worktreePath !== branch.worktreePath || JSON.stringify(item.overlayExcludes) !== JSON.stringify(branch.overlayExcludes) ||
        !Number.isSafeInteger(item.ticketId) || item.ticketId < 0 || item.ticketId !== 0 && !runTickets.has(item.ticketId))) return unavailable('branch records disagree with the frozen run')
      const ticketIds = [...new Set(branches.map(item => item.ticketId).filter(id => id > 0))].sort((a, b) => a - b)
      if (ledger.ticket_id !== 0 && !ticketIds.includes(ledger.ticket_id)) return unavailable('worktree ticket ownership changed')
      const message = `specrails: ticket-${ledger.ticket_id} recovered (run ${runId})`
      snapshots.push({ version: 1, projectId, deliveryId: delivery.id, reconstructedFrom: 'durable-branch-records',
        baseRepo: repository.sourcePath, overlaySourceRoot: repository.sourcePath, overlayProviderDir: '', overlayInstructions: '',
        commitMessage: message, partialCommitMessage: `specrails: ticket-${ledger.ticket_id} partial recovered (run ${runId})`,
        run: { runId, ledgerId: ledger.id, ticketId: ledger.ticket_id, ticketIds,
          handle: { branch: repository.branch, worktreePath: repository.worktreePath },
          baseRef: repository.baseSha, initialSha: branch.initialSha, branchOwnership: branch.branchOwnership as 'created' | 'preexisting',
          worktreeOwnership: 'preexisting', automaticRelease: false, overlayExcludes: [...branch.overlayExcludes], overlayCleanupEvidence: [], warmLinkEvidence: [],
          settlementIgnoredPaths: null, provenanceSnapshot: null, continuationTarget: null } })
    }
    if (snapshots.length !== manifest.selectedRepositoryIds.length || candidates.length !== snapshots.length) return unavailable('repository delivery set is incomplete or ambiguous')
    for (const snapshot of snapshots) saveIsolatedSettlementSnapshot(db, snapshot)
    return { delivery_id: snapshots[0].deliveryId }
  }).immediate()
}
