// Delivery review routes: the read-only review packet and its Changes tab
// (file list and lazy per-file diff), the single PR decision action, the
// local-changes restore/bring-back/discard-branch actions and checking the
// delivered branch out into the project repository. Action logic lives in
// rail-pr-decision.ts and the git/checkout helpers; routes validate and map.

import path from 'path'
import type { Router, Request, Response } from 'express'
import type { ProjectContext } from '../../../project-registry'
import { isReviewPacketEnabled } from '../../../feature-flags'
import { refreshPrCiOffer } from './pr-ci/pr-ci-projection'
import { getLoopRun } from '../../loops/runtime/loop-runs-store'
import { resolveProjectExecution } from '../../../workspace-resolution'
import { getActivePrDeliveryByRail, appendPrDeliverySafetyArchive, getPrDelivery, toPrDecisionCardEnvelope, toPrDeliverySnapshot, toRailPrStateMessage, transitionDecision, updatePrDeliverySettleEvidence } from './rail-pr-store'
import { composeReviewPacket } from './review-packet'
import { composeDeliveryChanges, composeFileDiff } from './delivery-changes'
import { readSettleEvidence, groupSettleEvidence, healRuntimeEvidence, coreAnnouncesReviewBrief } from './delivery-evidence'
import { probeDefinitionRuns } from '../../loops/runtime/loop-definition-recovery'
import { resolveAcceptCapability } from '../../execution/runtime/accept-ladder'
import { executePrDecision, isPrDecisionAction, PR_DECISION_ACTIONS, runBringBackLocalChanges, runDiscardRestoreBranch, runRestoreLocalChanges } from './rail-pr-decision'
import { defaultGitRunner } from '../../../worktree-manager'
import { durableBranchHeads, durableOverlayCleanupEvidence, durableSettlementIgnoredPaths, releaseRailWorktrees } from './rail-worktree-release'
import { checkoutProjectReviewBranch, getProjectGitInfo, inspectProjectCheckoutCleanliness } from '../../../project-git'
import { defaultExec } from './pr-publisher'
import { resolveProjectRepository, RepositoryValidationError } from '../../../project-repositories'
import { checkoutRepositoryDelivery } from './multi-repo-checkout'
import { listRepositoryDeliveries } from './multi-repo-execution'
import { readExecutionManifest } from './multi-repo-execution-store'
import { withRepoLock } from '../../../repo-lock'
import { getAgentChatManager } from '../../missions/runtime/agent-chat-registry'
import { isRunCardId } from '../../missions/runtime/mission-run-notify'
import { captureProcessAdmission, ProcessAdmissionClosedError } from '../../../process-admission'
import { projectContextOf, emitPrDeliveryUpdate } from './rails-http-shared'
import { prDeliveryCheckoutTarget, prDeliveryCheckoutBlock } from './rail-delivery-revision'

export function registerRailReviewRoutes(router: Router): void {
  const ctx = projectContextOf

  // GET /rails/pr-deliveries/:id/packet — the plain-language review packet for a
  // settled delivery: composed server-side from durable rows only (no model
  // calls, no live-store reads) plus the pre-resolved Accept ladder, so the
  // client never has to ask the user to choose between git actions. Read-only.
  router.get('/pr-deliveries/:prDeliveryId/packet', async (req: Request, res: Response) => {
    if (!isReviewPacketEnabled()) { res.status(404).json({ error: 'Not Found' }); return }
    const c = ctx(req)
    let row = getPrDelivery(c.db, req.params.prDeliveryId as string)
    if (!row) { res.status(404).json({ error: 'Delivery not found' }); return }
    try {
      const parent = row.parent_delivery_id ? getPrDelivery(c.db, row.parent_delivery_id) : row
      if (!parent) { res.status(404).json({ error: 'Delivery group not found' }); return }
      const repositoryId = req.query.repositoryId
      if (repositoryId !== undefined && (typeof repositoryId !== 'string' || !repositoryId)) { res.status(400).json({ error: 'Invalid repositoryId' }); return }
      if (repositoryId) {
        row = listRepositoryDeliveries(c.db, parent.id).find((child) => child.repository_id === repositoryId)
        if (!row) { res.status(404).json({ error: 'Repository not in this delivery' }); return }
      }
      const manifest = readExecutionManifest(parent.execution_manifest)
      const frozenRepository = row.repository_id ? manifest?.repositories.find((repository) => repository.repositoryId === row!.repository_id && repository.sourcePath === row!.repository_path) : undefined
      if (row.parent_delivery_id && !frozenRepository) { res.status(409).json({ error: 'Repository delivery has no frozen source path' }); return }
      // Evidence heal: deliveries settled before the programmatic-runtime
      // harvest existed (or whose pipeline dir was unreadable then) get their
      // host-run commands + reviewer verdict read now and persisted, so an
      // older packet stops claiming "nothing reported" once the data exists.
      try {
        const existing = readSettleEvidence(row.settle_evidence)
        if (existing) {
          const pipelineDir = path.join(resolveProjectExecution({ slug: c.project.slug, path: c.project.path }).specrailsDir, 'pipeline')
          const definitionStatuses = await probeDefinitionRuns({ db: c.db, cwd: c.project.path, env: process.env },
            existing.units.filter(unit => !unit.runtime && unit.runId && getLoopRun(c.db, unit.runId)?.engine_version === 2).map(unit => unit.runId!), true)
          const healed = healRuntimeEvidence(existing, pipelineDir, {}, definitionStatuses, { reviewBrief: await coreAnnouncesReviewBrief() })
          if (healed) { updatePrDeliverySettleEvidence(c.db, row.id, healed); row = { ...row, settle_evidence: JSON.stringify(healed) } }
        }
      } catch (err) {
        console.warn('[rails-router] packet evidence heal skipped:', err instanceof Error ? err.message : String(err))
      }
      // "All repositories" of a multi-repository delivery: the group row records no
      // evidence of its own, so the packet speaks for the repositories' evidence together
      // instead of claiming nothing was verified or reviewed.
      if (!repositoryId && !readSettleEvidence(row.settle_evidence)) {
        const grouped = groupSettleEvidence(listRepositoryDeliveries(c.db, row.id).map((child) => readSettleEvidence(child.settle_evidence)))
        if (grouped) row = { ...row, settle_evidence: JSON.stringify(grouped) }
      }
      const repositoryNames = manifest ? Object.fromEntries(manifest.repositories.map((repository) => [repository.repositoryId, repository.name])) : undefined
      const packet = composeReviewPacket({ db: c.db, row, flowSettlement: c.flow?.settlementForDelivery(row.id) ?? null, ...(repositoryNames ? { repositoryNames } : {}), ...(frozenRepository ? { repositoryId: frozenRepository.repositoryId, includeLegacyProvenance: frozenRepository.repositoryId === manifest?.primaryRepositoryId } : {}) })
      // Capability probes are read-only and offline; a failure degrades to the
      // confirm-gated local path rather than blocking the packet.
      const acceptCapability = await resolveAcceptCapability({ repoDir: frozenRepository?.sourcePath ?? c.project.path, exec: defaultExec })
      res.json({ packet, acceptCapability, snapshot: toPrDeliverySnapshot(parent), repositoryId: frozenRepository?.repositoryId ?? null })
    } catch (err) {
      console.error('[rails-router] packet composition failed:', err)
      res.status(500).json({ error: 'packet composition failed', detail: (err as Error).message })
    }
  })

  // GET /rails/pr-deliveries/:id/changes[?repositoryId=&source=] — the review
  // packet's Changes tab: the delivery's head vs its merge-base with the base
  // branch (file list + counts + hashes) and the annotations the delivery already
  // holds. GET .../changes/file?path=&full=1 parses ONE file lazily. Read-only;
  // `path` is a lookup key against the diff's own listing, never a pathspec.
  const changesScope = (req: Request, res: Response): { c: ProjectContext; row: NonNullable<ReturnType<typeof getPrDelivery>>; repoDir: string; repositoryId: string | null; source: string | null } | null => {
    if (!isReviewPacketEnabled()) { res.status(404).json({ error: 'Not Found' }); return null }
    const c = ctx(req)
    let row = getPrDelivery(c.db, req.params.prDeliveryId as string)
    if (!row) { res.status(404).json({ error: 'Delivery not found' }); return null }
    const parent = row.parent_delivery_id ? getPrDelivery(c.db, row.parent_delivery_id) : row
    if (!parent) { res.status(404).json({ error: 'Delivery group not found' }); return null }
    const repositoryId = req.query.repositoryId
    if (repositoryId !== undefined && (typeof repositoryId !== 'string' || !repositoryId)) { res.status(400).json({ error: 'Invalid repositoryId' }); return null }
    const source = req.query.source
    if (source !== undefined && (typeof source !== 'string' || !/^(delivery|ticket:\d+)$/.test(source))) { res.status(400).json({ error: 'Invalid source' }); return null }
    if (repositoryId) {
      row = listRepositoryDeliveries(c.db, parent.id).find((child) => child.repository_id === repositoryId)
      if (!row) { res.status(404).json({ error: 'Repository not in this delivery' }); return null }
    }
    const manifest = readExecutionManifest(parent.execution_manifest)
    const frozen = row.repository_id ? manifest?.repositories.find((repository) => repository.repositoryId === row!.repository_id && repository.sourcePath === row!.repository_path) : undefined
    if (row.parent_delivery_id && !frozen) { res.status(409).json({ error: 'Repository delivery has no frozen source path' }); return null }
    return { c, row, repoDir: frozen?.sourcePath ?? c.project.path, repositoryId: frozen?.repositoryId ?? null, source: source ?? null }
  }

  router.get('/pr-deliveries/:prDeliveryId/changes', async (req: Request, res: Response) => {
    const scope = changesScope(req, res)
    if (!scope) return
    try {
      const changes = await composeDeliveryChanges({ row: scope.row, repoDir: scope.repoDir, sourceId: scope.source, repositoryId: scope.repositoryId })
      res.json({ prDeliveryId: scope.row.id, repositoryId: scope.repositoryId, changes })
    } catch (err) {
      console.error('[rails-router] changes composition failed:', err)
      res.status(500).json({ error: 'changes composition failed' })
    }
  })

  router.get('/pr-deliveries/:prDeliveryId/changes/file', async (req: Request, res: Response) => {
    const scope = changesScope(req, res)
    if (!scope) return
    const filePath = req.query.path
    if (typeof filePath !== 'string' || !filePath || filePath.length > 1000 || filePath.includes('\0')) { res.status(400).json({ error: 'Invalid path' }); return }
    try {
      const result = await composeFileDiff({ row: scope.row, repoDir: scope.repoDir, sourceId: scope.source, repositoryId: scope.repositoryId, path: filePath, full: req.query.full === '1' })
      if (!result.ok) { res.status(result.status).json({ error: result.error }); return }
      res.json({ prDeliveryId: scope.row.id, diff: result.diff })
    } catch (err) {
      console.error('[rails-router] file diff failed:', err)
      res.status(500).json({ error: 'file diff failed' })
    }
  })

  // POST /rails/pr-decision — the ONE decision action (safe-pr-review-flow) both
  // surfaces (dashboard rail row + agent-chat card) call on a rail_pr_deliveries
  // row: create-pr | publish | discard/dismiss | poll/reopen | merge-local |
  // acknowledge-no-changes | recover-and-retry, compare-and-set-guarded by
  // expectedDecision (a raced concurrent answer loses with 409 stale_decision).
  // Replaces the stateless v1 POST /rails/pr-review passthrough. The route only
  // validates and delegates — the action logic lives in rail-pr-decision.ts.
  // specrails never merges — the engineer owns the merge.
  router.post('/pr-decision', async (req: Request, res: Response) => {
    const c = ctx(req)
    const { prDeliveryId, action, expectedDecision, repositoryId } = req.body ?? {}
    if (repositoryId !== undefined && (typeof repositoryId !== 'string' || !repositoryId)) { res.status(400).json({ error: 'repositoryId must be a nonempty string' }); return }
    if (typeof prDeliveryId !== 'string' || !prDeliveryId) {
      res.status(400).json({ error: 'prDeliveryId is required' }); return
    }
    if (!isPrDecisionAction(action)) {
      res.status(400).json({ error: `action must be one of: ${PR_DECISION_ACTIONS.join(', ')}` }); return
    }
    if (typeof expectedDecision !== 'string' || !expectedDecision) {
      res.status(400).json({ error: 'expectedDecision is required' }); return
    }
    // mission-rail-cards: a RUN-ONLY card (shared-cwd launch, synthetic
    // `run:<runId>` id) has no delivery row — the only legal decision is
    // dismiss, resolved against the origin conversation's persisted card.
    if (isRunCardId(prDeliveryId)) {
      if (action !== 'dismiss') { res.status(400).json({ error: 'run_card_dismiss_only', detail: 'A run-only card (no git delivery) accepts only dismiss' }); return }
      const conversationId = typeof req.body?.conversationId === 'string' ? req.body.conversationId : ''
      if (!conversationId) { res.status(400).json({ error: 'conversationId is required for a run-only card' }); return }
      const dismissed = getAgentChatManager()?.dismissRunCard(conversationId, prDeliveryId) ?? false
      if (!dismissed) { res.status(404).json({ error: 'run_card_not_found' }); return }
      res.json({ ok: true, decision: 'discarded', prUrl: null, prState: 'none', merged: false, detail: null })
      return
    }
    try {
      const targetDelivery = getPrDelivery(c.db, prDeliveryId)
      if (repositoryId && targetDelivery && !targetDelivery.execution_manifest && !resolveProjectRepository(c.project, repositoryId).isPrimary) {
        res.status(400).json({ error: 'Repository is not part of this delivery' }); return
      }
      const admission = captureProcessAdmission(c.project.id)
      const execute = () => {
        admission.assertCurrent()
        return executePrDecision({
          db: c.db,
          project: { id: c.project.id, slug: c.project.slug, path: c.project.path },
          git: defaultGitRunner,
          exec: defaultExec,
          broadcast: c.broadcast,
          jiraSyncManager: c.jiraSyncManager,
          assertAdmission: () => admission.assertCurrent(),
        }, { prDeliveryId, action, expectedDecision, repositoryId })
      }
      // Every decision that can touch refs/worktrees shares the same project
      // mutex as startup reconciliation, launch allocation and checkout. Local
      // merge already acquires it internally to keep its guarded read/advance
      // sequence atomic, so avoid nesting that non-reentrant lock.
      const result = action === 'merge-local' || !!getPrDelivery(c.db, prDeliveryId)?.execution_manifest
        ? await execute()
        : await withRepoLock(c.project.path, execute)
      // pr-ci-loop: a PR created or published from the card (Intent → Spec
      // stops at review, so its PR is born here, not at run settle) gets the
      // optional "Watch and fix the CI" offer too. Advisory and idempotent.
      refreshPrCiOffer(c, prDeliveryId)
      // The durable row is authoritative. Return its post-action snapshot even
      // when the WebSocket broadcast is dropped or another surface won the
      // race; clients can converge immediately without optimistic inference.
      const current = getPrDelivery(c.db, prDeliveryId)
      res.status(result.status).json({
        ...result.body,
        ...(current ? { snapshot: toPrDeliverySnapshot(current) } : {}),
      })
    } catch (err) {
      if (err instanceof ProcessAdmissionClosedError) {
        res.status(409).json({ error: 'project_recovery_in_progress' }); return
      }
      if (err instanceof RepositoryValidationError) { res.status(err.status).json({ error: err.message }); return }
      console.error('[rails-router] pr-decision error:', err)
      res.status(500).json({ error: 'pr-decision failed', detail: (err as Error).message })
    }
  })

  // POST /rails/pr-local-changes/{restore,bring-back,discard-branch} — the
  // person's uncommitted work "Integrate locally" saved as a stash (by commit
  // sha). "restore" re-applies it (a clean apply drops it; a conflict keeps it
  // and Specrails restores it on its own branch + worktree). "bring-back"
  // fast-forwards the target to the reviewed restore commit and only then
  // drops the stash; "discard-branch" removes the restore branch, keeping the
  // stash. Each takes the repository lock and refuses while a decision lease
  // is held (proactive-local-integration).
  const localChangesActions = {
    restore: runRestoreLocalChanges,
    'bring-back': runBringBackLocalChanges,
    'discard-branch': runDiscardRestoreBranch,
  } as const
  for (const [action, run] of Object.entries(localChangesActions)) {
    router.post(`/pr-local-changes/${action}`, async (req: Request, res: Response) => {
      const c = ctx(req)
      const { prDeliveryId } = req.body ?? {}
      if (typeof prDeliveryId !== 'string' || !prDeliveryId) {
        res.status(400).json({ error: 'prDeliveryId is required' }); return
      }
      try {
        const admission = captureProcessAdmission(c.project.id)
        const result = await run({
          db: c.db,
          project: { id: c.project.id, slug: c.project.slug, path: c.project.path },
          git: defaultGitRunner,
          exec: defaultExec,
          broadcast: c.broadcast,
          jiraSyncManager: c.jiraSyncManager,
          assertAdmission: () => admission.assertCurrent(),
        }, prDeliveryId)
        const current = getPrDelivery(c.db, prDeliveryId)
        const shown = current?.parent_delivery_id ? getPrDelivery(c.db, current.parent_delivery_id) : current
        res.status(result.status).json({ ...result.body, ...(shown ? { snapshot: toPrDeliverySnapshot(shown) } : {}) })
      } catch (err) {
        if (err instanceof ProcessAdmissionClosedError) {
          res.status(409).json({ error: 'project_recovery_in_progress' }); return
        }
        console.error(`[rails-router] local changes ${action} error:`, err)
        res.status(500).json({ error: `${action} failed`, detail: (err as Error).message })
      }
    })
  }

  // POST /rails/pr-checkout — move the user's main checkout to the delivered PR
  // branch. This is intentionally separate from PR decisions: it does not accept,
  // publish, discard, or merge anything. It only releases Specrails-managed
  // worktrees for this delivery (keeping branches) and then checks out the PR
  // branch in the real project repo so the user can test/edit locally.
  router.post('/pr-checkout', async (req: Request, res: Response) => {
    const c = ctx(req)
    const { prDeliveryId } = req.body ?? {}
    if (typeof prDeliveryId !== 'string' || !prDeliveryId) {
      res.status(400).json({ error: 'prDeliveryId is required' }); return
    }
    let admission: ReturnType<typeof captureProcessAdmission>
    try {
      admission = captureProcessAdmission(c.project.id)
    } catch (err) {
      if (err instanceof ProcessAdmissionClosedError) {
        res.status(409).json({ error: 'project_recovery_in_progress' }); return
      }
      throw err
    }
    const row = getPrDelivery(c.db, prDeliveryId)
    if (!row) {
      res.status(404).json({ error: 'Unknown prDeliveryId' }); return
    }
    if (!row.execution_manifest && req.body?.repositoryId !== undefined) {
      try {
        if (typeof req.body.repositoryId !== 'string' || !resolveProjectRepository(c.project, req.body.repositoryId).isPrimary) {
          res.status(400).json({ error: 'Repository is not part of this delivery' }); return
        }
      } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid repositoryId' }); return }
    }
    const active = getActivePrDeliveryByRail(c.db, row.rail_index)
    if (!active || active.id !== row.id) {
      res.status(409).json({
        error: 'stale_decision',
        current: active?.decision ?? null,
        currentPrDeliveryId: active?.id ?? null,
      }); return
    }
    if (row.execution_manifest) {
      const repositoryId = req.body?.repositoryId
      if (repositoryId !== undefined && (typeof repositoryId !== 'string' || !repositoryId)) { res.status(400).json({ error: 'repositoryId must be a nonempty string' }); return }
      try {
      const outcome = await checkoutRepositoryDelivery({
        db: c.db, project: c.project, git: defaultGitRunner, exec: defaultExec,
        broadcast: c.broadcast, jiraSyncManager: c.jiraSyncManager,
        assertAdmission: () => admission.assertCurrent(),
      }, { prDeliveryId, repositoryId })
      res.status(outcome.status).json(outcome.body)
      } catch (error) {
        res.status(error instanceof ProcessAdmissionClosedError ? 409 : 500).json({
          error: error instanceof ProcessAdmissionClosedError ? 'project_recovery_in_progress' : 'pr-checkout failed',
          detail: error instanceof Error ? error.message : String(error),
        })
      }
      return
    }
    const snap = toPrDeliverySnapshot(row)
    const checkoutBlock = prDeliveryCheckoutBlock(snap)
    if (checkoutBlock) {
      res.status(409).json({ error: 'checkout_not_deliverable', detail: checkoutBlock }); return
    }
    try {
      const outcome = await withRepoLock(c.project.path, async () => {
        admission.assertCurrent()
        const current = getActivePrDeliveryByRail(c.db, row.rail_index)
        if (!current || current.id !== row.id) {
          return {
            ok: false as const,
            status: 409,
            error: 'stale_decision',
            detail: 'The delivery generation changed before checkout.',
          }
        }
        const currentSnap = toPrDeliverySnapshot(current)
        const currentCheckoutBlock = prDeliveryCheckoutBlock(currentSnap)
        if (currentCheckoutBlock) {
          return {
            ok: false as const,
            status: 409,
            error: 'checkout_not_deliverable',
            detail: currentCheckoutBlock,
          }
        }
        const target = prDeliveryCheckoutTarget(currentSnap)
        if (!target) {
          return {
            ok: false as const,
            status: 409,
            error: 'checkout_not_deliverable',
            detail: 'The current delivery no longer has a verified local branch.',
          }
        }
        const cleanliness = await inspectProjectCheckoutCleanliness(c.project.path)
        if (!cleanliness.ok) {
          return {
            ok: false as const,
            status: 409,
            error: 'checkout_safety_unknown',
            detail: cleanliness.detail,
          }
        }
        // Compatible local edits are preserved by Git's checkout transaction;
        // only unreadable status prevents attempting the handoff here.
        const info = await getProjectGitInfo(c.project.path)
        if (!info.git) {
          return { ok: false as const, status: 409, error: 'checkout_unavailable', detail: 'project is not a git repository' }
        }
        let archived = false
        const cleanupWarnings = await releaseRailWorktrees({
          db: c.db,
          git: defaultGitRunner,
          repoDir: c.project.path,
          worktreeIds: currentSnap.worktreeIds,
          expectedHeadByBranch: durableBranchHeads(currentSnap.branches),
          overlayEvidenceByBranch: durableOverlayCleanupEvidence(currentSnap.branches),
          settlementIgnoredByBranch: durableSettlementIgnoredPaths(currentSnap.branches),
          onSafetyArchive: (archive) => {
            archived = true
            if (!appendPrDeliverySafetyArchive(c.db, row.id, archive)) {
              throw new Error(`delivery ${row.id} disappeared while recording safety archive ${archive}`)
            }
          },
        })
        if (archived) {
          const archivedRow = getPrDelivery(c.db, row.id)
          if (archivedRow) {
            const archivedSnap = toPrDeliverySnapshot(archivedRow)
            c.broadcast(toRailPrStateMessage(c.project.id, archivedSnap))
            if (archivedRow.origin_conversation_id) {
              getAgentChatManager()?.updatePrDecisionCard(
                archivedRow.origin_conversation_id,
                toPrDecisionCardEnvelope(c.project.id, archivedSnap),
              )
            }
          }
        }
        // A preserved unit worktree need not hold the assembled review branch.
        // Keep its warnings visible, but let Git decide whether the requested
        // branch is actually occupied instead of blocking every batch checkout.
        if (cleanupWarnings.length > 0 || currentSnap.cleanupWarnings.length > 0 || currentSnap.statusCode === 'cleanup_incomplete') {
          transitionDecision(c.db, row.id, currentSnap.decision, currentSnap.decision, {
            cleanupWarnings,
            ...(cleanupWarnings.length > 0 ? { statusCode: 'cleanup_incomplete' as const }
              : currentSnap.statusCode === 'cleanup_incomplete' ? { statusCode: null } : {}),
          })
          emitPrDeliveryUpdate(c, row.id)
        }
        const checkedOut = await checkoutProjectReviewBranch(
          c.project.path,
          target.branch,
          target.sha,
        )
        if (!checkedOut.ok) {
          return {
            ok: false as const, status: 409, error: 'checkout_failed',
            detail: [checkedOut.error, ...cleanupWarnings].join('\n'),
          }
        }
        return { ok: true as const, branch: target.branch, git: await getProjectGitInfo(c.project.path), cleanupWarnings }
      })
      if (!outcome.ok) {
        res.status(outcome.status).json({ error: outcome.error, detail: outcome.detail }); return
      }
      res.json(outcome)
    } catch (err) {
      console.error('[rails-router] pr-checkout error:', err)
      res.status(500).json({ error: 'pr-checkout failed', detail: (err as Error).message })
    }
  })
}
