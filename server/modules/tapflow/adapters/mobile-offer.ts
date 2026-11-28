/**
 * "Test in Mobile Device" after a delivery: the mission card (a system row, like the PR CI offer), the start
 * that records the run's target and launches `factory:mobile-test`, and the card's follow-up.
 *
 * What is tested: the delivery's own worktree while it is on review (it stays mounted for the decision, so
 * the person can test before deciding), or the project checkout after a local merge. A delivery published
 * as a pull request has released its worktree: the offer expires (test before publishing).
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import type { ProjectContext } from '../../../project-registry'
import { getDesktopSetting, setDesktopSetting } from '../../../desktop-db'
import { newId } from '../../../ids'
import { getAdapter } from '../../../providers'
import { isReasoningEffortValidForModel } from '../../../providers/runtime'
import type { ReasoningEffort } from '../../../providers/types'
import { resolveProjectRepository } from '../../../project-repositories'
import { resolveAgentDefaults } from '../../agents/runtime/agent-defaults'
import { loadCoreAgentRuntime } from '../../agent-runtime/runtime/agent-runtime-loader'
import { getPrDelivery, type RailPrDeliveryRow } from '../../delivery/runtime/rail-pr-store'
import { listRailWorktrees } from '../../delivery/runtime/rail-worktrees-store'
import { loadConstantMap } from '../../loops/runtime/loop-constants'
import { MOBILE_TEST_LOOP_ID, mobileTestGraph } from '../../loops/runtime/loop-mobile-test-recipe'
import { getAgentChatManager } from '../../missions/runtime/agent-chat-registry'
import { choosePlatforms, detectMobileApps, type MobilePlatform } from '../mobile-project'
import { projectFilesAt } from './mobile-build'
import { createMobileRunsStore, type MobileTestRun } from './mobile-runs-store'

export const MOBILE_TEST_OFFER_KIND = 'mobile-test-offer'
export const mobileTestOfferKey = (deliveryId: string) => `mobile-test-offer:${deliveryId}`

export interface MobileTestOfferRow {
  kind: typeof MOBILE_TEST_OFFER_KIND
  projectId: string
  deliveryId: string
  /** Platforms the project builds; more than one means the card asks. */
  platforms: MobilePlatform[]
  recommended: MobilePlatform | 'both'
  state: 'offered' | 'started' | 'launched' | 'failed' | 'expired' | 'dismissed'
  runId?: string
  reason?: string
  /** Where the app runs; enough to open the device window. */
  devices?: Array<{ platform: MobilePlatform; name: string; id: string; sessionId: string; buildId: number }>
  at: string
}

export interface MobileOfferEnv {
  /** Tapflow is installed and supported on this machine (the offer is pointless otherwise). */
  tapflowReady: () => Promise<boolean>
  capabilities?: () => Promise<Record<string, number> | undefined>
}

const REVIEW_DECISIONS = new Set(['on_review'])
const LOCAL_DECISIONS = new Set(['merged', 'completed'])

async function hostTasksSupported(env: MobileOfferEnv): Promise<boolean> {
  try {
    const caps = await (env.capabilities ?? (async () => (await loadCoreAgentRuntime()).api?.capabilities as Record<string, number> | undefined))()
    return caps?.engineV2 === 1 && caps.workflowDefinitions === 1 && caps.hostTasks === 1
  } catch { return false }
}

/** The working copy to test for a delivery, or null when its code is not on this machine any more. */
export function mobileTestTarget(c: Pick<ProjectContext, 'db' | 'project'>, delivery: RailPrDeliveryRow): { path: string; kind: 'review' | 'checkout' } | null {
  if (REVIEW_DECISIONS.has(delivery.decision)) {
    let ids: unknown[] = []
    try { ids = JSON.parse(delivery.worktree_ids || '[]') } catch { /* none */ }
    const worktree = listRailWorktrees(c.db).find((row) => ids.includes(row.id) && row.merge_state !== 'released' && fs.existsSync(row.worktree_path))
    return worktree ? { path: worktree.worktree_path, kind: 'review' } : null
  }
  if (LOCAL_DECISIONS.has(delivery.decision)) return { path: resolveProjectRepository(c.project).path, kind: 'checkout' }
  return null
}

const changedFiles = (cwd: string, base: string) => new Promise<string[]>((resolve) => {
  execFile('git', ['diff', '--name-only', `${base}...HEAD`], { cwd, timeout: 10_000, maxBuffer: 2 * 1024 * 1024 }, (err, stdout) => resolve(err ? [] : stdout.split('\n').filter(Boolean)))
})

const rememberKey = (projectId: string) => `tapflow.platforms.${projectId}`
export function rememberedPlatforms(c: Pick<ProjectContext, 'desktopDb' | 'project'>): MobilePlatform | 'both' | null {
  const value = getDesktopSetting(c.desktopDb, rememberKey(c.project.id))
  return value === 'ios' || value === 'android' || value === 'both' ? value : null
}

function rowFor(projectId: string, deliveryId: string, base: Pick<MobileTestOfferRow, 'platforms' | 'recommended'>, run: MobileTestRun | null): MobileTestOfferRow {
  const at = new Date().toISOString()
  if (!run) return { kind: MOBILE_TEST_OFFER_KIND, projectId, deliveryId, ...base, state: 'offered', at }
  const result = run.result ?? {}
  return {
    kind: MOBILE_TEST_OFFER_KIND, projectId, deliveryId, ...base, runId: run.runId, at,
    state: run.state === 'running' ? 'started' : run.state,
    ...(typeof result.detail === 'string' ? { reason: result.detail } : {}),
    ...(Array.isArray(result.devices) ? { devices: (result.devices as Array<{ platform: MobilePlatform; name: string; id: string; sessionId: string; buildId: number }>).map((device) => ({ platform: device.platform, name: device.name, id: device.id, sessionId: device.sessionId, buildId: device.buildId })) } : {}),
  }
}

/** Advisory: posts or updates the card after any delivery change. Never throws. */
export async function refreshMobileTestOffer(c: ProjectContext, deliveryId: string, env: MobileOfferEnv): Promise<void> {
  try {
    const delivery = getPrDelivery(c.db, deliveryId)
    const conversationId = delivery?.origin_conversation_id
    const chat = getAgentChatManager()
    if (!delivery || !conversationId || !chat || delivery.loop_id === MOBILE_TEST_LOOP_ID) return
    const store = createMobileRunsStore(c.db)
    const run = store.latestForDelivery(deliveryId)
    const target = mobileTestTarget(c, delivery)
    if (!run && (!target || !(await env.tapflowReady()) || !(await hostTasksSupported(env)))) return
    const apps = target ? detectMobileApps(projectFilesAt(target.path)) : []
    if (!run && !apps.length) return
    const platforms = [...new Set(apps.map((app) => app.platform))]
    const choice = choosePlatforms(apps, target?.kind === 'review' ? await changedFiles(target.path, delivery.base_branch) : [], rememberedPlatforms(c))
    const recommended = choice.kind === 'single' ? choice.platform : choice.kind === 'ask' ? choice.recommended : 'both'
    const row = rowFor(c.project.id, deliveryId, { platforms, recommended }, run)
    // The code left the machine (published as a pull request) before anyone tested it.
    if (!run && !target) row.state = 'expired'
    chat.upsertSystemRow(conversationId, { ...row }, mobileTestOfferKey(deliveryId))
  } catch (err) {
    console.error('[tapflow] mobile test offer failed:', err)
  }
}

export type MobileStartResult = { ok: true; runId: string } | { ok: false; status: number; error: string }

/** Records the run's target, remembers the platform choice and launches `factory:mobile-test`. */
export async function startMobileTest(c: ProjectContext, request: { deliveryId: string; platforms: MobilePlatform[] }, env: MobileOfferEnv): Promise<MobileStartResult> {
  const delivery = getPrDelivery(c.db, request.deliveryId)
  if (!delivery) return { ok: false, status: 404, error: 'Delivery not found' }
  if (!(await env.tapflowReady())) return { ok: false, status: 409, error: 'Tapflow is not installed. Install it in Plugins ▸ Tapflow.' }
  if (!(await hostTasksSupported(env))) return { ok: false, status: 409, error: 'This Specrails Core cannot run host tasks; update Core.' }
  const target = mobileTestTarget(c, delivery)
  if (!target) return { ok: false, status: 409, error: 'The code of this delivery is no longer on this machine (it was published or discarded).' }
  const platforms = [...new Set(request.platforms)].filter((platform): platform is MobilePlatform => platform === 'ios' || platform === 'android')
  if (!platforms.length) return { ok: false, status: 400, error: 'Choose iOS, Android or both.' }
  const runId = newId()
  const store = createMobileRunsStore(c.db)
  store.create({ runId, projectId: c.project.id, platforms, targetPath: target.path, targetKind: target.kind, deliveryId: delivery.id, conversationId: delivery.origin_conversation_id ?? null })
  setDesktopSetting(c.desktopDb, rememberKey(c.project.id), platforms.length > 1 ? 'both' : platforms[0]!)
  const provider = c.project.provider ?? 'claude'
  const adapter = getAdapter(provider)
  const defaults = resolveAgentDefaults(c.desktopDb, provider)
  const model = defaults?.pipelineModel ?? adapter.defaultModel()
  const effort = defaults?.pipelineEffort && isReasoningEffortValidForModel(adapter, model, defaults.pipelineEffort) ? defaults.pipelineEffort as ReasoningEffort : undefined
  const repository = resolveProjectRepository(c.project)
  c.loopRunManager.run({
    runId, loopId: MOBILE_TEST_LOOP_ID, loopName: 'Test in Mobile Device', graph: mobileTestGraph(), projectId: c.project.id,
    repositoryId: repository.id, cwd: target.path, repoDir: target.path,
    railIndex: null, ticketId: null, spec: undefined,
    constants: loadConstantMap(c.desktopDb), provider, model, ...(effort ? { effort } : {}),
  })
    .then((result) => c.onLoopRunFinished(result.runId, result.outcome, result.stallReason ? { stallReason: result.stallReason } : undefined))
    .catch((error) => { console.error('[tapflow] mobile test run failed:', error); c.onLoopRunFinished(runId, 'failed') })
    .finally(() => { void refreshMobileTestOffer(c, delivery.id, env) })
  void refreshMobileTestOffer(c, delivery.id, env)
  return { ok: true, runId }
}

export function dismissMobileTestOffer(c: ProjectContext, deliveryId: string): boolean {
  const delivery = getPrDelivery(c.db, deliveryId)
  const chat = getAgentChatManager()
  if (!delivery?.origin_conversation_id || !chat) return false
  const id = chat.upsertSystemRow(delivery.origin_conversation_id, { kind: MOBILE_TEST_OFFER_KIND, projectId: c.project.id, deliveryId, platforms: [], recommended: 'both', state: 'dismissed', at: new Date().toISOString() }, mobileTestOfferKey(deliveryId))
  return id !== null
}
