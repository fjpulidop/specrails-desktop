/**
 * "Test in Mobile Device": the mission card after a delivery (a system row, like the PR CI offer), the
 * start that records the run's target and launches `factory:mobile-test`, and the card's follow-up. The
 * same start serves Loops ▸ Test in Mobile Device and the agents' MCP, where the person picks the target.
 *
 * What is tested:
 * - a delivery: its own worktree while it is on review (it stays mounted for the decision, so the person
 *   can test before deciding), or the project checkout after a local merge. A delivery published as a
 *   pull request has released its worktree: the offer expires (test before publishing);
 * - the project checkout as it is (the person's own work in progress);
 * - a branch, without touching the checkout: a temporary detached worktree, removed when the run ends;
 * - the mission's own Intent session worktree (a mission agent asked to run the app, MCP target `mission`).
 *
 * A run started from a mission (its delivery card, or its agent) shows in that mission's Processes, with
 * the run's log and Tapflow's, and its device in the mission's Resources.
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { ProjectContext } from '../../../project-registry'
import { getDesktopSetting, setDesktopSetting } from '../../../desktop-db'
import { newId } from '../../../ids'
import { getAdapter } from '../../../providers'
import { isReasoningEffortValidForModel } from '../../../providers/runtime'
import type { ReasoningEffort } from '../../../providers/types'
import { resolveProjectRepository } from '../../../project-repositories'
import { resolveAgentDefaults } from '../../agents/runtime/agent-defaults'
import { loadCoreAgentRuntime } from '../../agent-runtime/runtime/agent-runtime-loader'
import { getPrDelivery, listActivePrDeliveries, readSpecSnapshot, type RailPrDeliveryRow } from '../../delivery/runtime/rail-pr-store'
import { listRailWorktrees } from '../../delivery/runtime/rail-worktrees-store'
import { loadConstantMap } from '../../loops/runtime/loop-constants'
import { resolveBuiltinLoop } from '../../loops/runtime/builtin-loops'
import { MOBILE_TEST_LOOP_ID, mobileTestGraph } from '../../loops/runtime/loop-mobile-test-recipe'
import { getAgentChatManager } from '../../missions/runtime/agent-chat-registry'
import { choosePlatforms, detectMobileApps, type MobilePlatform } from '../mobile-project'
import { projectFilesAt } from './mobile-build'
import { withRepoLock } from '../../../repo-lock'
import { backgroundProcessHooks } from '../../terminals/runtime/background-process-service'
import { finishMobileRun, trackMobileRun } from './mobile-run-process'
import type { ChoosableDevice } from './delivery'
import { createMobileRunsStore, type MobileTestRun } from './mobile-runs-store'

export const MOBILE_TEST_OFFER_KIND = 'mobile-test-offer'
export const mobileTestOfferKey = (deliveryId: string) => `mobile-test-offer:${deliveryId}`
/** The card of a run a mission's agent started (no delivery): one per run. */
export const mobileTestRunCardKey = (runId: string) => `mobile-test-run:${runId}`

export interface MobileTestOfferRow {
  kind: typeof MOBILE_TEST_OFFER_KIND
  projectId: string
  /** Empty for a run the mission's agent started (no delivery to offer or retry). */
  deliveryId: string
  /** Platforms the project builds; more than one means the card asks. */
  platforms: MobilePlatform[]
  recommended: MobilePlatform | 'both'
  state: 'offered' | 'started' | 'launched' | 'failed' | 'expired' | 'dismissed'
  runId?: string
  reason?: string
  /** Where the app runs; enough to open the device window. */
  devices?: Array<{ platform: MobilePlatform; name: string; id: string; sessionId: string; buildId: number }>
  /** The person asked for this run (Start on the card, or their agent): the client opens the device once it runs. */
  autoOpen?: boolean
  at: string
}

export interface MobileOfferEnv {
  /** Tapflow is installed and supported on this machine (the offer is pointless otherwise). */
  tapflowReady: () => Promise<boolean>
  capabilities?: () => Promise<Record<string, number> | undefined>
  /** The devices Tapflow offers while it is on (null when off); for the start form. */
  devices?: () => Promise<ChoosableDevice[] | null>
  /** Tapflow's service log while Specrails runs it: a mission's Processes entry follows it during a run. */
  serviceLog?: () => string | null
  /** Releases a device: shut down after the grace period (as when its window closes), or now. */
  releaseDevice?: (target: { deviceId: string; sessionId: string; buildId: number; platform: MobilePlatform; name: string }, now: boolean) => Promise<void> | void
}

/** The device a run put the app on (the first, or the one of `platform`), as a device window target. */
export function runDevice(c: Pick<ProjectContext, 'db'>, runId: string, platform?: MobilePlatform): { deviceId: string; sessionId: string; buildId: number; platform: MobilePlatform; name: string } | null {
  const view = mobileTestRunView(c, runId)
  const devices = (view?.devices ?? []) as Array<{ platform?: unknown; name?: unknown; id?: unknown; sessionId?: unknown; buildId?: unknown }>
  const device = devices.find((candidate) => !platform || candidate.platform === platform)
  if (!device || typeof device.id !== 'string' || typeof device.sessionId !== 'string' || typeof device.buildId !== 'number' || (device.platform !== 'ios' && device.platform !== 'android')) return null
  return { deviceId: device.id, sessionId: device.sessionId, buildId: device.buildId, platform: device.platform, name: typeof device.name === 'string' ? device.name : device.id }
}

const REVIEW_DECISIONS = new Set(['on_review'])
const LOCAL_DECISIONS = new Set(['merged', 'completed'])

async function coreCapabilities(env: MobileOfferEnv): Promise<Record<string, number> | undefined> {
  try {
    return await (env.capabilities ?? (async () => (await loadCoreAgentRuntime()).api?.capabilities as Record<string, number> | undefined))()
  } catch { return undefined }
}
const runsHostTasks = (caps: Record<string, number> | undefined) => caps?.engineV2 === 1 && caps.workflowDefinitions === 1 && caps.hostTasks === 1
async function hostTasksSupported(env: MobileOfferEnv): Promise<boolean> {
  return runsHostTasks(await coreCapabilities(env))
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
    kind: MOBILE_TEST_OFFER_KIND, projectId, deliveryId, ...base, runId: run.runId, at, autoOpen: true,
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

/**
 * The card of a run the mission's agent started (no delivery): building → running on <device> (with Open
 * <device>, opened for the person once it runs) | failed (reason). Advisory: never throws.
 */
export function refreshMissionRunCard(c: Pick<ProjectContext, 'db' | 'project'>, runId: string): void {
  try {
    const run = createMobileRunsStore(c.db).get(runId)
    const chat = getAgentChatManager()
    if (!run?.conversationId || run.deliveryId || !chat) return
    const row = rowFor(c.project.id, '', { platforms: run.platforms, recommended: run.platforms.length > 1 ? 'both' : run.platforms[0]! }, run)
    chat.upsertSystemRow(run.conversationId, { ...row }, mobileTestRunCardKey(runId))
  } catch (err) {
    console.error('[tapflow] mobile test card failed:', err)
  }
}

export type MobileStartResult = { ok: true; runId: string } | { ok: false; status: number; error: string; code?: string }

/** What a run tests: a delivery (the card), the checkout as it is, a branch (Loops, MCP), or the calling
 * mission's Intent worktree (MCP, `conversationId` required). */
export type MobileTestTargetRequest = { kind: 'delivery'; deliveryId: string } | { kind: 'checkout' } | { kind: 'branch'; branch: string } | { kind: 'mission' }

export interface MobileStartRequest {
  target: MobileTestTargetRequest
  platforms: MobilePlatform[]
  /** The device chosen per platform (Tapflow device id); absent = Tapflow picks. */
  devices?: Partial<Record<MobilePlatform, string>>
  /** The mission that asks (its agent through MCP): the run shows in its Processes and Resources. */
  conversationId?: string
}

/** A mission of this project (its pin), or null. */
function missionOf(c: Pick<ProjectContext, 'desktopDb' | 'project'>, conversationId: string | undefined): string | null {
  if (!conversationId) return null
  const row = c.desktopDb.prepare('SELECT pinned_project_id FROM agent_conversations WHERE id = ? AND deleted_at IS NULL').get(conversationId) as { pinned_project_id: string | null } | undefined
  return row?.pinned_project_id === c.project.id ? conversationId : null
}

/** The mission's ACTIVE Intent session worktree (as the agent's own tools see it), or null. */
function missionWorkspace(c: Pick<ProjectContext, 'flow'>, conversationId: string): { flowId: string; worktreePath: string; repositoryId?: string } | null {
  try {
    const flow = c.flow?.getByConversation(conversationId)
    if (!flow || flow.state !== 'active' || flow.step !== null || !flow.worktreePath || !fs.existsSync(flow.worktreePath)) return null
    return { flowId: flow.id, worktreePath: flow.worktreePath, ...(flow.repositoryId ? { repositoryId: flow.repositoryId } : {}) }
  } catch { return null }
}

const git = (cwd: string, args: string[]) => new Promise<{ ok: boolean; out: string }>((resolve) => {
  execFile('git', args, { cwd, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => resolve({ ok: !err, out: (err ? stderr : stdout).trim() }))
})

/** Where branch runs get their temporary worktrees: beside the project's database, never in the repository. */
const scratchRoot = (c: Pick<ProjectContext, 'project'>) => path.join(path.dirname(c.project.db_path), 'mobile-test')

/** The commit a branch name points at (local first, then a remote-tracking one), or null. */
async function branchCommit(repo: string, branch: string): Promise<string | null> {
  if (!branch || branch.startsWith('-') || /[\s~^:?*[\\]|\.\.|@\{/.test(branch)) return null
  for (const ref of [`refs/heads/${branch}`, `refs/remotes/${branch}`]) {
    const found = await git(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
    if (found.ok && /^[0-9a-f]{40,64}$/.test(found.out)) return found.out
  }
  return null
}

/** Removes a branch run's temporary worktree (best effort; `git worktree prune` covers a vanished folder). */
async function removeScratchWorktree(repo: string, dir: string): Promise<void> {
  await withRepoLock(repo, async () => {
    await git(repo, ['worktree', 'remove', '--force', dir])
    fs.rmSync(dir, { recursive: true, force: true })
    await git(repo, ['worktree', 'prune'])
  }).catch(() => undefined)
}

/** Leftovers of branch runs the server did not see end (a restart mid-run). */
async function sweepScratchWorktrees(c: Pick<ProjectContext, 'db' | 'project'>, repo: string): Promise<void> {
  const root = scratchRoot(c)
  let entries: string[] = []
  try { entries = fs.readdirSync(root) } catch { return }
  const store = createMobileRunsStore(c.db)
  for (const runId of entries) {
    if (store.get(runId)?.state !== 'running') await removeScratchWorktree(repo, path.join(root, runId))
  }
}

/** Records the run's target, remembers the platform choice and launches `factory:mobile-test`. */
export async function startMobileTest(c: ProjectContext, request: MobileStartRequest, env: MobileOfferEnv): Promise<MobileStartResult> {
  const delivery = request.target.kind === 'delivery' ? getPrDelivery(c.db, request.target.deliveryId) : undefined
  if (request.target.kind === 'delivery' && !delivery) return { ok: false, status: 404, error: 'Delivery not found', code: 'delivery_not_found' }
  if (!(await env.tapflowReady())) return { ok: false, status: 409, error: 'Tapflow is not installed. Install it in Plugins ▸ Tapflow.', code: 'tapflow_not_installed' }
  const capabilities = await coreCapabilities(env)
  if (!runsHostTasks(capabilities)) return { ok: false, status: 409, error: 'This Specrails Core cannot run host tasks; update Core.', code: 'engine_unsupported' }
  const platforms = [...new Set(request.platforms)].filter((platform): platform is MobilePlatform => platform === 'ios' || platform === 'android')
  if (!platforms.length) return { ok: false, status: 400, error: 'Choose iOS, Android or both.', code: 'platforms_required' }
  const mission = missionOf(c, request.conversationId) ?? (delivery?.origin_conversation_id ?? null)
  if (request.conversationId && !missionOf(c, request.conversationId)) return { ok: false, status: 404, error: 'That mission is not in this project.', code: 'mission_not_found' }
  const workspace = request.target.kind === 'mission' && mission ? missionWorkspace(c, mission) : null
  if (request.target.kind === 'mission' && !workspace) return { ok: false, status: 409, error: 'This mission has no active Intent session to build from. Use target checkout or branch, or start an Intent session.', code: 'no_intent_session' }
  const repository = resolveProjectRepository(c.project, workspace?.repositoryId)
  const runId = newId()

  let target: { path: string; kind: MobileTestRun['targetKind'] }
  let scratch: string | null = null
  if (request.target.kind === 'delivery') {
    const found = mobileTestTarget(c, delivery!)
    if (!found) return { ok: false, status: 409, error: 'The code of this delivery is no longer on this machine (it was published or discarded).', code: 'delivery_code_gone' }
    target = found
  } else if (request.target.kind === 'checkout') {
    target = { path: repository.path, kind: 'checkout' }
  } else if (request.target.kind === 'mission') {
    target = { path: workspace!.worktreePath, kind: 'intent' }
  } else {
    const branch = request.target.branch.trim()
    const commit = await branchCommit(repository.path, branch)
    if (!commit) return { ok: false, status: 404, error: `There is no branch "${branch}" in this project.`, code: 'branch_not_found' }
    await sweepScratchWorktrees(c, repository.path)
    scratch = path.join(scratchRoot(c), runId)
    fs.mkdirSync(path.dirname(scratch), { recursive: true })
    const added = await withRepoLock(repository.path, () => git(repository.path, ['worktree', 'add', '--detach', scratch!, commit]))
    if (!added.ok) return { ok: false, status: 500, error: `Could not check out ${branch} to build it: ${added.out}`, code: 'branch_checkout_failed' }
    target = { path: scratch, kind: 'branch' }
  }
  const apps = detectMobileApps(projectFilesAt(target.path))
  const missing = platforms.filter((platform) => !apps.some((app) => app.platform === platform))
  if (missing.length === platforms.length) {
    if (scratch) await removeScratchWorktree(repository.path, scratch)
    return { ok: false, status: 409, error: `This code has no ${missing.map((platform) => (platform === 'ios' ? 'iOS' : 'Android')).join(' or ')} app Specrails can build.`, code: 'no_app' }
  }
  const devices = Object.fromEntries(Object.entries(request.devices ?? {}).filter(([platform, id]) => platforms.includes(platform as MobilePlatform) && typeof id === 'string' && /^[A-Za-z0-9:._-]{1,128}$/.test(id))) as MobileTestRun['devices']

  const store = createMobileRunsStore(c.db)
  store.create({ runId, projectId: c.project.id, platforms, targetPath: target.path, targetKind: target.kind, deliveryId: delivery?.id ?? null, conversationId: mission, devices })
  if (mission) {
    const what = target.kind === 'branch' ? `branch ${(request.target as { branch: string }).branch.trim()}` : target.kind === 'intent' ? 'Intent session' : target.kind === 'review' ? 'delivery on review' : 'checkout'
    trackMobileRun(runId, {
      projectId: c.project.id, chatId: mission, cwd: target.path, hooks: backgroundProcessHooks(c.broadcast),
      label: `Test in Mobile Device · ${platforms.map((platform) => (platform === 'ios' ? 'iOS' : 'Android')).join(' + ')} · ${what}`,
      repositoryId: repository.id, repositoryName: repository.name, ...(workspace ? { flowId: workspace.flowId } : {}),
      serviceLog: env.serviceLog?.() ?? null,
    })
  }
  setDesktopSetting(c.desktopDb, rememberKey(c.project.id), platforms.length > 1 ? 'both' : platforms[0]!)
  const provider = c.project.provider ?? 'claude'
  const adapter = getAdapter(provider)
  const defaults = resolveAgentDefaults(c.desktopDb, provider)
  const model = defaults?.pipelineModel ?? adapter.defaultModel()
  const effort = defaults?.pipelineEffort && isReasoningEffortValidForModel(adapter, model, defaults.pipelineEffort) ? defaults.pipelineEffort as ReasoningEffort : undefined
  // The built-in as the person edited and published it in Loops (its contract is checked on publish).
  const resolved = resolveBuiltinLoop(c.desktopDb, MOBILE_TEST_LOOP_ID, capabilities)
  c.loopRunManager.run({
    runId, loopId: MOBILE_TEST_LOOP_ID, loopName: resolved?.name ?? 'Test in Mobile Device', graph: resolved?.graph ?? mobileTestGraph(), projectId: c.project.id,
    repositoryId: repository.id, cwd: target.path, repoDir: target.path,
    railIndex: null, ticketId: null, spec: undefined,
    constants: loadConstantMap(c.desktopDb), provider, model, ...(effort ? { effort } : {}),
  })
    .then((result) => c.onLoopRunFinished(result.runId, result.outcome, result.stallReason ? { stallReason: result.stallReason } : undefined))
    .catch((error) => { console.error('[tapflow] mobile test run failed:', error); c.onLoopRunFinished(runId, 'failed') })
    .finally(() => {
      // The mission's Processes entry ends with the run's outcome (the store has it once a handler settled).
      const settled = store.get(runId)
      const summary = typeof settled?.result?.summary === 'string' ? settled.result.summary : null
      const detail = typeof settled?.result?.detail === 'string' ? settled.result.detail : null
      if (settled?.state === 'launched') finishMobileRun(runId, 'exited', summary ? `Running: ${summary}` : undefined)
      else finishMobileRun(runId, 'failed', detail ?? 'The mobile test stopped before the app was running; the run log has the details.')
      // The app is installed on the device: the branch's worktree is no longer needed.
      if (scratch) void removeScratchWorktree(repository.path, scratch)
      if (delivery) void refreshMobileTestOffer(c, delivery.id, env)
      else refreshMissionRunCard(c, runId)
    })
  if (delivery) void refreshMobileTestOffer(c, delivery.id, env)
  else refreshMissionRunCard(c, runId)
  return { ok: true, runId }
}

/** A run's state for the start form and the MCP (what ran where, or why it stopped). */
export function mobileTestRunView(c: Pick<ProjectContext, 'db'>, runId: string) {
  const run = createMobileRunsStore(c.db).get(runId)
  if (!run) return null
  const result = run.result ?? {}
  return {
    runId: run.runId, state: run.state, platforms: run.platforms, targetKind: run.targetKind, deliveryId: run.deliveryId,
    ...(typeof result.summary === 'string' ? { summary: result.summary } : {}),
    ...(typeof result.detail === 'string' ? { detail: result.detail } : {}),
    ...(typeof result.command === 'string' ? { command: result.command } : {}),
    devices: Array.isArray(result.devices) ? (result.devices as Array<Record<string, unknown>>).map((device) => ({ platform: device.platform, name: device.name, id: device.id, sessionId: device.sessionId, buildId: device.buildId })) : [],
  }
}

const deliveryLabel = (row: RailPrDeliveryRow) => {
  const titles = (readSpecSnapshot(row.spec_snapshot) ?? []).map((entry) => entry.title).filter((title): title is string => Boolean(title))
  return titles.length ? titles.join(' · ').slice(0, 140) : row.loop_name ?? row.branch ?? row.id.slice(0, 8)
}

/**
 * What the start form offers (Loops ▸ Test in Mobile Device ▸ Run on a device): the checkout's apps and
 * current branch, the deliveries on review with an app, the local branches, and Tapflow's devices.
 */
export async function mobileTestOptions(c: ProjectContext, env: MobileOfferEnv) {
  const repository = resolveProjectRepository(c.project)
  const [ready, hostTasks, current, branchList] = await Promise.all([
    env.tapflowReady(), hostTasksSupported(env),
    git(repository.path, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(repository.path, ['for-each-ref', '--sort=-committerdate', '--count=50', '--format=%(refname:short)', 'refs/heads']),
  ])
  const apps = detectMobileApps(projectFilesAt(repository.path))
  const remembered = rememberedPlatforms(c)
  const choice = choosePlatforms(apps, [], remembered)
  const deliveries = listActivePrDeliveries(c.db)
    .filter((row) => REVIEW_DECISIONS.has(row.decision) && row.loop_id !== MOBILE_TEST_LOOP_ID)
    .flatMap((row) => {
      const found = mobileTestTarget(c, row)
      const platforms = found ? [...new Set(detectMobileApps(projectFilesAt(found.path)).map((app) => app.platform))] : []
      return found && platforms.length ? [{ id: row.id, label: deliveryLabel(row), platforms }] : []
    })
    .slice(0, 20)
  const devices = ready && env.devices ? await env.devices().catch(() => null) : null
  return {
    ready, hostTasks,
    checkout: {
      branch: current.ok && current.out !== 'HEAD' ? current.out : null,
      platforms: [...new Set(apps.map((app) => app.platform))],
      recommended: choice.kind === 'single' ? choice.platform : choice.kind === 'ask' ? choice.recommended : remembered ?? 'both',
    },
    remembered,
    deliveries,
    branches: branchList.ok ? branchList.out.split('\n').filter(Boolean) : [],
    devices,
  }
}

export function dismissMobileTestOffer(c: ProjectContext, deliveryId: string): boolean {
  const delivery = getPrDelivery(c.db, deliveryId)
  const chat = getAgentChatManager()
  if (!delivery?.origin_conversation_id || !chat) return false
  const id = chat.upsertSystemRow(delivery.origin_conversation_id, { kind: MOBILE_TEST_OFFER_KIND, projectId: c.project.id, deliveryId, platforms: [], recommended: 'both', state: 'dismissed', at: new Date().toISOString() }, mobileTestOfferKey(deliveryId))
  return id !== null
}
