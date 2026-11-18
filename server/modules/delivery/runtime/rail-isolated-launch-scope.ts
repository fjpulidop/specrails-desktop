/**
 * Isolated launch stage 0 — validation and frozen scope. Routes a launch whose
 * write targets are not exactly the primary repository to the coordinated
 * multi-repository execution, then freezes everything decided ONCE at launch
 * entry: the revision briefing and constants, the spec-addenda plan, the
 * PR-delivery mode and the isolation units.
 */
import { loadConstantMap } from '../../loops/runtime/loop-constants'
import { getProjectRepositories } from '../../../project-repositories'
import { isRailPrDeliveryEnabled } from './rail-isolation'
import { claimSpecAddendaForRun, planSpecAddendaAt, ticketStorePathForProject } from '../../specs/runtime/spec-addenda'
import { assertLoopShellRepositoryScope } from '../../loops/runtime/loop-graph'
import type { IsolatedLaunchInput, IsolatedLaunchIO } from './rail-isolated-launch-contracts'
import { buildRevisionSeedForLaunch } from './rail-isolated-launch-support'

export interface SingleRepositoryRoute {
  input: IsolatedLaunchInput
  singleRepositoryId: string | undefined
  expectedRepositoryBaseSha: string | undefined
}

/**
 * A one-repository launch continues here (returned synchronously: the launch
 * prefix up to its first real await stays in the caller's tick, as it was
 * when this was inline); anything else is delegated to the coordinated
 * multi-repository execution and resolves to its run ids.
 */
export function routeLaunchRepositories(
  input: IsolatedLaunchInput,
  io: IsolatedLaunchIO,
): SingleRepositoryRoute | Promise<string[]> {
  const { ctx, ticketIds, loopGraph } = input
  let expectedRepositoryBaseSha = input.repositoryExecution?.expectedBaseSha
  let singleRepositoryId = input.repositoryExecution?.repositoryId
  if (!input.repositoryExecution) {
    const members = getProjectRepositories(ctx.project)
    const primary = members.find((repo) => repo.isPrimary) ?? members[0]
    const selected = input.repositoryIds ?? (ticketIds.length === 0 && primary ? [primary.id] : [...new Set(ticketIds.flatMap((id) => {
      const ids = (ctx.getTicketSpec(id) as { repositoryIds?: string[] } | undefined)?.repositoryIds
      return ids?.length ? ids : primary ? [primary.id] : []
    }))])
    assertLoopShellRepositoryScope(loopGraph, selected)
    if (primary && selected.length === 1 && selected[0] === primary.id) {
      input = { ...input, baseBranch: input.repositoryBaseBranches?.[primary.id] ?? input.baseBranch }
      singleRepositoryId = primary.id
      expectedRepositoryBaseSha = input.repositoryBaseShas?.[primary.id]
    }
    if (selected.length !== 1 || selected[0] !== primary?.id) {
      return delegateMultiRepositoryLaunch({ ...input, repositoryIds: selected }, io)
    }
  }
  return { input, singleRepositoryId, expectedRepositoryBaseSha }
}

async function delegateMultiRepositoryLaunch(input: IsolatedLaunchInput, io: IsolatedLaunchIO): Promise<string[]> {
  const { launchMultiRepositoryRail } = await import('./multi-repo-execution')
  return launchMultiRepositoryRail(input, io)
}

export type IsolationUnit = { ticketId: number; ticketIds: number[] }
export type ClaimedAddendaByRun = Map<string, ReturnType<typeof claimSpecAddendaForRun>>
export type FrozenLaunchScope = ReturnType<typeof freezeLaunchScope>

export function freezeLaunchScope(input: IsolatedLaunchInput) {
  const { ctx, ticketIds, loopId } = input
  // A revision run is seeded with a full briefing (the instruction PLUS the
  // frozen spec, the branch that carries the work and what the previous run
  // actually reported) rather than the bare sentence — the run starts a FRESH
  // provider session by contract, so durable context is the only thing it has.
  // Per-RUN data, so it is layered over the project's constant map for this
  // launch only and never persisted as a constant.
  const revisionSeed = input.revision ? buildRevisionSeedForLaunch(ctx.db, input.revision, ticketIds, !['factory:sdd-quick-openspec', 'factory:openspec', 'factory:revision'].includes(loopId)) : undefined
  const constants = input.revision && revisionSeed
    ? {
        ...loadConstantMap(ctx.desktopDb),
        REVISION_REQUEST: revisionSeed.briefing,
        REVISION_NUMBER: String(revisionSeed.number),
        REVISION_OF_DELIVERY_ID: input.revision.ofDeliveryId,
      }
    : loadConstantMap(ctx.desktopDb)
  // Spec addenda (spec-addenda): the iteration notes the specs carry are
  // planned ONCE at launch entry (frozen on the delivery row below), then
  // claimed per allocated unit with that unit's run id and rendered into the
  // briefing every AI step of the run receives.
  const addendaStorePath = ticketStorePathForProject(ctx.project)
  const addendaPlan = planSpecAddendaAt(addendaStorePath, ticketIds)
  const claimedAddendaByRun: ClaimedAddendaByRun = new Map()
  // Capture the PR-delivery mode ONCE at launch entry so a mid-flight env flip
  // can never split one launch across the two delivery paths.
  const prMode = Boolean(input.repositoryExecution) || isRailPrDeliveryEnabled()
  // Units of isolation: `all` → ONE unit covering every ticket (one worktree, one
  // run — the batch pipeline handles the tickets internally); `per-ticket` → one
  // unit per ticket. The branch/ledger key is the unit's primary (first) ticket.
  const scope = input.scope ?? 'per-ticket'
  const units: IsolationUnit[] =
    input.repositoryExecution && ticketIds.length === 0 ? [{ ticketId: 0, ticketIds: [] }] : scope === 'all'
      ? [{ ticketId: ticketIds[0], ticketIds: [...ticketIds] }]
      : ticketIds.map((id) => ({ ticketId: id, ticketIds: [id] }))
  return { constants, addendaStorePath, addendaPlan, claimedAddendaByRun, prMode, units }
}
