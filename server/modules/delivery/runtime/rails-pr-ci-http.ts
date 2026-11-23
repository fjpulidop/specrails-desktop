// PR CI loop ("Watch and fix the PR's CI") read and admission routes: live CI
// status of a delivery's open PRs (cached per project context), whether the
// offer is available, the mission-origin admission lifecycle (prepare, start,
// dismiss — keyed by host admission, never by rail) and "Not now" on a
// delivery's offer. Starting the loop on a rail is a launch and lives in
// rails-launch-http.ts.

import path from 'path'
import type { Router, Request, Response } from 'express'
import { isLoopsEnabled } from '../../../feature-flags'
import { ciFixActiveRepositories } from '../domain/decision-policy'
import { prCiCapable } from './pr-ci/pr-ci-projection'
import { dismissPrCiOffer, prCiOfferKey } from './pr-ci/pr-ci-offer'
import { createPrCiAdmissionRuntime, type PrCiAdmissionRuntime } from './pr-ci/pr-ci-admission-runtime'
import { createPrCiStatusCache, readPrCiStatus } from './pr-ci/pr-ci-status'
import { defaultExec as prCiExec } from './pr-publisher'
import { isRailPrDeliveryEnabled } from './rail-isolation'
import { getPrDelivery } from './rail-pr-store'
import { listRepositoryDeliveries } from './multi-repo-execution'
import { getAgentChatManager } from '../../missions/runtime/agent-chat-registry'
import { projectContextOf } from './rails-http-shared'

export function registerRailPrCiRoutes(router: Router): void {
  const ctx = projectContextOf

  // pr-ci-loop: whether "Watch and fix CI" can be offered (flag + Core `hostTasks`).
  // Live CI of a delivery's open PR(s), read from GitHub whether or not a CI loop ran.
  const prCiStatusCaches = new WeakMap<object, ReturnType<typeof createPrCiStatusCache>>()
  router.get('/pr-ci-status', async (req: Request, res: Response) => {
    const id = typeof req.query.deliveryId === 'string' ? req.query.deliveryId : ''
    if (!/^[A-Za-z0-9-]{1,64}$/.test(id)) { res.status(400).json({ error: 'invalid_pr_delivery_id' }); return }
    const c = ctx(req)
    const row = getPrDelivery(c.db, id)
    if (!row) { res.status(404).json({ error: 'pr_delivery_not_found' }); return }
    if (row.decision !== 'pr_draft' && row.decision !== 'pr_ready') { res.json({ deliveryId: id, prs: [] }); return }
    let cache = prCiStatusCaches.get(c)
    if (!cache) { cache = createPrCiStatusCache((cwd, prUrl) => readPrCiStatus(prCiExec, cwd, prUrl)); prCiStatusCaches.set(c, cache) }
    const watched = row.execution_manifest
      ? ciFixActiveRepositories(listRepositoryDeliveries(c.db, row.id)).filter(child => child.pr_url)
        .map(child => ({ repository: path.basename(child.repository_path ?? ''), prUrl: child.pr_url!, prNumber: child.pr_number, cwd: child.repository_path ?? c.project.path }))
      : row.pr_url ? [{ repository: '', prUrl: row.pr_url, prNumber: row.pr_number, cwd: c.project.path }] : []
    const prs = await Promise.all(watched.map(async pr => ({ repository: pr.repository, prUrl: pr.prUrl, prNumber: pr.prNumber, ...(await cache!(pr.cwd, pr.prUrl)) })))
    res.json({ deliveryId: id, prs })
  })

  router.get('/pr-ci-availability', async (_req: Request, res: Response) => {
    res.json({ available: isLoopsEnabled() && isRailPrDeliveryEnabled() && await prCiCapable() })
  })

  // Mission-origin CI repair: the PR has no delivery, so the offer is keyed by
  // its host admission (project + repository + PR), never by a delivery or rail.
  const prCiAdmissionRuntimes = new WeakMap<object, PrCiAdmissionRuntime>()
  const admissionRuntime = (req: Request): PrCiAdmissionRuntime => {
    const c = ctx(req)
    let runtime = prCiAdmissionRuntimes.get(c)
    if (!runtime) { runtime = createPrCiAdmissionRuntime(c); prCiAdmissionRuntimes.set(c, runtime) }
    return runtime
  }
  const validAdmissionId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(value)
  router.post('/pr-ci/admissions', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    if (typeof body.prUrl !== 'string' || !body.prUrl.trim() || body.prUrl.length > 512) { res.status(400).json({ error: 'pr_url_invalid', detail: 'Provide the full pull request URL.' }); return }
    const origin = typeof body.originConversationId === 'string' && body.originConversationId ? body.originConversationId : null
    const result = await admissionRuntime(req).prepare(body.prUrl, origin)
    if (!result.ok) { res.status(result.status).json({ error: result.error, detail: result.detail }); return }
    const { admission } = result
    res.json({ admissionId: admission.id, state: admission.state, repositoryId: admission.repository_id, prNumber: admission.pr_number, prUrl: admission.pr_url, headBranch: admission.head_branch, baseBranch: admission.base_branch })
  })
  router.post('/pr-ci/admissions/:admissionId/start', async (req: Request, res: Response) => {
    const admissionId = req.params.admissionId
    if (!validAdmissionId(admissionId)) { res.status(400).json({ error: 'invalid_pr_ci_admission_id' }); return }
    const result = await admissionRuntime(req).start(admissionId)
    if (!result.ok) { res.status(result.status).json({ error: result.error, detail: result.detail, ...(result.runId ? { runId: result.runId } : {}) }); return }
    res.status(202).json({ admissionId, runId: result.runId, loopRunIds: [result.runId], state: result.admission.state })
  })
  router.post('/pr-ci/admissions/:admissionId/dismiss', (req: Request, res: Response) => {
    const admissionId = req.params.admissionId
    if (!validAdmissionId(admissionId)) { res.status(400).json({ error: 'invalid_pr_ci_admission_id' }); return }
    const result = admissionRuntime(req).dismiss(admissionId)
    if (!result.ok) { res.status(result.status).json({ error: result.error, detail: result.detail }); return }
    res.json({ admissionId, state: result.admission.state })
  })

  // "Not now" on the offer: persisted for this delivery generation only.
  router.post('/pr-ci-offer/dismiss', (req: Request, res: Response) => {
    const id = (req.body ?? {}).prDeliveryId
    if (typeof id !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(id)) { res.status(400).json({ error: 'invalid_pr_delivery_id' }); return }
    const c = ctx(req)
    if (!getPrDelivery(c.db, id)) { res.status(404).json({ error: 'pr_delivery_not_found' }); return }
    const dismissed = dismissPrCiOffer(c.db, getAgentChatManager(), id)
    res.status(dismissed ? 200 : 409).json(dismissed ? { prDeliveryId: id, key: prCiOfferKey(id), state: 'dismissed' } : { error: 'pr_ci_offer_not_pending' })
  })
}
