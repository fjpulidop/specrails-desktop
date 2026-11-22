// Fixture projects and states, created through the isolated app's HTTP API
// (repositories are throwaway, with local bare remotes under the work dir).
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createRepo } from '../../../scripts/benchmark/lib/repos.mjs'
import { registerProject } from '../../../scripts/benchmark/lib/driver.mjs'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** The engine marker that scripts a run's behaviour (see engine/claude). */
export const engineMarker = mode => `[eval-engine:${mode}]`

/** A registered project `{ id, slug, name, path }` for `name` (idempotent). */
export async function seedProject(api, workDir, name, { template = 'node-lib', files } = {}) {
  const repo = createRepo({ template, name, ...(files ? { files } : {}) }, workDir)
  const id = await registerProject(api, repo, ['claude'])
  for (let i = 0; i < 120; i++) {
    const rails = await api.get(`/projects/${id}/rails`)
    if (rails.status === 200) break
    await sleep(500)
  }
  // Registering installs Specrails' agent files into the repository; a real project commits them (otherwise every
  // local integration has to stash and restore them around the merge).
  commitInstalled(repo)
  const projects = await api.get('/projects')
  const row = (projects.data?.projects ?? projects.data ?? []).find(p => p.id === id)
  return { id, slug: row?.slug ?? name, name: row?.name ?? name, path: repo }
}

/** Commit whatever setup left uncommitted in a seeded repository (no-op when clean). */
export function commitInstalled(repo) {
  const git = (...args) => spawnSync('git', ['-c', 'user.name=Specrails eval', '-c', 'user.email=eval@specrails.invalid', ...args], { cwd: repo, encoding: 'utf8' })
  if (!git('status', '--porcelain').stdout.trim()) return false
  git('add', '-A')
  if (git('commit', '-q', '-m', 'chore: add the Specrails setup').status !== 0) return false
  // The throwaway local bare remote (createRepo), so runs branch from the same base.
  git('push', '-q', 'origin', 'HEAD')
  return true
}

export async function seedSpec(api, project, { title, description = '', priority }) {
  const res = await api.post(`/projects/${project.id}/tickets`, { title, description, ...(priority ? { priority } : {}) })
  if (res.status >= 300) throw new Error(`seed spec: ${res.status} ${JSON.stringify(res.data).slice(0, 200)}`)
  return (res.data.ticket ?? res.data).id
}

/** Put specs on a rail and launch the built-in Implement loop on the scripted engine. Returns the run id. */
export async function launchOnRail(api, project, ticketIds, { rail = 0, provider = 'claude', model = 'haiku' } = {}) {
  const slot = await api.put(`/projects/${project.id}/rails/${rail}/tickets`, { ticketIds, mode: 'implement', aiEngine: provider })
  if (slot.status >= 300) throw new Error(`rail slot: ${slot.status} ${JSON.stringify(slot.data).slice(0, 200)}`)
  const res = await api.post(`/projects/${project.id}/rails/${rail}/launch`, { loopId: 'factory:implement', aiEngine: provider, model })
  if (res.status !== 202) throw new Error(`launch: ${res.status} ${JSON.stringify(res.data).slice(0, 300)}`)
  return { runId: res.data.loopRunIds?.[0] ?? res.data.jobId, deliveryId: res.data.prDeliveryId ?? null, rail }
}

export async function loopRun(api, project, runId) {
  const res = await api.get(`/projects/${project.id}/loop-runs/${runId}`)
  return res.status === 200 ? res.data.loopRun ?? res.data : null
}

export async function packet(api, project, deliveryId) {
  const res = await api.get(`/projects/${project.id}/rails/pr-deliveries/${deliveryId}/packet`)
  return res.status === 200 ? res.data.packet ?? null : null
}

export async function tickets(api, project) {
  const res = await api.get(`/projects/${project.id}/tickets`)
  return res.status === 200 ? res.data.tickets ?? [] : []
}

export async function trashedTickets(api, project) {
  const res = await api.get(`/projects/${project.id}/tickets/trash`)
  return res.status === 200 ? res.data.tickets ?? res.data.items ?? [] : []
}

/** Poll `probe()` until `done(value)`; returns the last value. */
export async function until(probe, done, { timeoutMs = 240_000, everyMs = 1500 } = {}) {
  const t0 = Date.now()
  let value
  while (Date.now() - t0 < timeoutMs) {
    value = await probe()
    if (done(value)) return value
    await sleep(everyMs)
  }
  throw new Error(`timed out after ${Math.round(timeoutMs / 1000)}s (last: ${JSON.stringify(value)?.slice(0, 200)})`)
}

/** Live-board card of a run, if any. */
export async function boardCard(api, runId) {
  const res = await api.get('/live-board')
  return (res.data?.cards ?? []).find(c => [c.id, c.runId, c.loopRunId, c.jobId].includes(runId)) ?? null
}

/** The scripted engine's invocation log (JSONL). */
export function engineCalls(file) {
  try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) } catch { return [] }
}

/** A run that keeps running (stall engine). */
export async function seedRunningRun(api, workDir, name, { engineLog } = {}) {
  const project = await seedProject(api, workDir, name)
  const spec = await seedSpec(api, project, { title: 'Long-running import job', description: `Import the catalogue. ${engineMarker('stall')}` })
  const run = await launchOnRail(api, project, [spec])
  await until(() => loopRun(api, project, run.runId), r => r?.status === 'running', { timeoutMs: 120_000 })
  // Pausable once its first Core step runs: the stall engine logs that role's invocation in the run's worktree.
  if (engineLog) await until(() => engineCalls(engineLog), rows => rows.some(r => String(r.cwd).includes(run.runId) && r.role === 'architect'), { timeoutMs: 120_000 })
  return { project, spec, ...run }
}

/** A delivery waiting for review (complete engine). */
export async function seedDelivery(api, workDir, name, title = 'Add the discount badge') {
  const project = await seedProject(api, workDir, name)
  const spec = await seedSpec(api, project, { title, description: 'Add src/eval-change.js exporting the badge value.' })
  const run = await launchOnRail(api, project, [spec])
  await until(() => packet(api, project, run.deliveryId), p => p && ['on_review', 'implementation_failed'].includes(p.decision), { timeoutMs: 300_000, everyMs: 3000 })
  const p = await packet(api, project, run.deliveryId)
  if (p.decision !== 'on_review') throw new Error(`seed delivery ended as ${p.decision}`)
  // The first run installs the agent files into the checkout; the person's project has them committed.
  commitInstalled(project.path)
  return { project, spec, ...run }
}

/** A failed run (fail engine). */
export async function seedFailedRun(api, workDir, name) {
  const project = await seedProject(api, workDir, name)
  const spec = await seedSpec(api, project, { title: 'Export the report as CSV', description: `Add a CSV export. ${engineMarker('fail')}` })
  const run = await launchOnRail(api, project, [spec])
  await until(() => loopRun(api, project, run.runId), r => r && ['completed', 'failed', 'cancelled'].includes(r.status) && r.final_outcome !== 'success', { timeoutMs: 180_000 })
  return { project, spec, ...run }
}

/** A run held on a provider limit (limit engine). */
export async function seedLimitedRun(api, workDir, name) {
  const project = await seedProject(api, workDir, name)
  const spec = await seedSpec(api, project, { title: 'Add the search filter', description: `Filter by tag. ${engineMarker('limit')}` })
  const run = await launchOnRail(api, project, [spec])
  const card = await until(() => boardCard(api, run.runId), c => /limit_paused|usage_limit|provider_limit/i.test(JSON.stringify(c ?? '')), { timeoutMs: 180_000 }).catch(() => null)
  return { project, spec, ...run, card }
}

/**
 * The 100-project seed (S10 and the load probe): `count` plain projects, most
 * with a few specs, registered in batches.
 */
export async function seedManyProjects(api, workDir, count = 100, { prefix = 'fleet', specsEach = 3, batch = 8 } = {}) {
  const projects = []
  for (let i = 0; i < count; i += batch) {
    const slice = Array.from({ length: Math.min(batch, count - i) }, (_, k) => `${prefix}-${String(i + k + 1).padStart(3, '0')}`)
    const made = await Promise.all(slice.map(async name => {
      const project = await seedProject(api, workDir, name)
      for (let s = 0; s < specsEach; s++) await seedSpec(api, project, { title: `${name} task ${s + 1}`, description: 'Routine maintenance.' })
      return project
    }))
    projects.push(...made)
  }
  return projects
}
