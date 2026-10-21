#!/usr/bin/env node
/** Read-only admission rules shared by npm and desktop publication workflows. */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

export function stableVersion(value) {
  if (typeof value !== 'string' || value.length > 100 || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) throw new Error('A stable X.Y.Z version is required; prereleases cannot publish to latest.')
  return value
}
export function releaseTag(ref, version) {
  stableVersion(version)
  if (ref !== `refs/tags/v${version}`) throw new Error('The release must run on the exact vX.Y.Z tag matching package.json.')
  return { tag: `v${version}`, version }
}
export function assertPromotion(candidate, current) {
  const left = stableVersion(candidate).split('.').map(BigInt)
  const right = stableVersion(current).split('.').map(BigInt)
  for (let i = 0; i < left.length; i++) {
    if (left[i] > right[i]) return
    if (left[i] < right[i]) throw new Error(`Refusing to replace latest ${current} with older release ${candidate}.`)
  }
}
function validIdentity(repository, sha) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? '') || !/^[a-f0-9]{40}$/.test(sha ?? '')) throw new Error('Invalid release repository or commit identity.')
}
function validBranch(branch) {
  if (typeof branch !== 'string' || !branch || /[\s~^:?*\[\\\x00-\x1f\x7f]/.test(branch)
    || branch.includes('..') || branch.includes('@{') || branch.includes('//')
    || branch.startsWith('/') || branch.endsWith('/') || branch.endsWith('.')
    || branch.split('/').some(part => part.startsWith('.') || part.endsWith('.lock'))) throw new Error('Invalid CI branch identity.')
  return branch
}
/** Validation is a distinct non-publishing mode; never infer it from a branch name. */
export function desktopReleaseMode({ eventName, validationOnly, ref, version, repository, sha, checkoutSha }) {
  validIdentity(repository, sha)
  stableVersion(version)
  if (checkoutSha !== sha) throw new Error('The checked-out commit differs from the release event; refusing to build.')
  if (!['push', 'workflow_dispatch'].includes(eventName)) throw new Error('Only tag pushes and explicit workflow dispatches may build native releases.')
  if (eventName === 'workflow_dispatch' && !['true', 'false'].includes(String(validationOnly))) throw new Error('A workflow dispatch must explicitly identify validation_only.')
  if (eventName === 'push' && ![undefined, '', false, 'false'].includes(validationOnly)) throw new Error('Tag pushes cannot change publication mode.')
  const validation = eventName === 'workflow_dispatch' && String(validationOnly) === 'true'
  if (validation && typeof ref === 'string' && ref.startsWith('refs/heads/')) {
    return { publish: false, ciBranch: validBranch(ref.slice('refs/heads/'.length)), version }
  }
  const tag = releaseTag(ref, version)
  return { publish: !validation, ciBranch: 'main', ...tag }
}
export function latestTrustedCiRun(runs, { repository, sha, branch = 'main' }) {
  validIdentity(repository, sha)
  validBranch(branch)
  return runs.filter(run => run.head_sha === sha && run.event === 'push' && run.head_branch === branch
    && run.head_repository?.full_name === repository && run.repository?.full_name === repository)
    .sort((a, b) => b.id - a.id || (b.run_attempt ?? 1) - (a.run_attempt ?? 1))[0] ?? null
}
export async function githubJson(route, { token = process.env.GH_TOKEN, fetchImpl = fetch } = {}) {
  if (!token) throw new Error('A read-only GitHub token is required to verify release admission.')
  const response = await fetchImpl(`https://api.github.com${route}`, {
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' },
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`GitHub admission check failed with HTTP ${response.status}. Publication remains blocked.`)
  return response.json()
}
export async function requireSuccessfulCi({ repository, sha, branch = 'main', request = githubJson, timeoutMs = 90 * 60_000, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), log = console.log }) {
  validIdentity(repository, sha)
  validBranch(branch)
  const deadline = now() + timeoutMs
  let previous = ''
  do {
    const result = await request(`/repos/${repository}/actions/workflows/ci.yml/runs?head_sha=${sha}&event=push&branch=${encodeURIComponent(branch)}&per_page=100`)
    if (!Array.isArray(result.workflow_runs)) throw new Error('GitHub returned an invalid CI history. Publication remains blocked.')
    const run = latestTrustedCiRun(result.workflow_runs, { repository, sha, branch })
    if (run?.status === 'completed') {
      if (run.conclusion !== 'success') throw new Error(`CI for this exact commit ended with ${run.conclusion ?? 'no conclusion'}; publication is blocked.`)
      log(`Verified CI run ${run.id}, attempt ${run.run_attempt ?? 1}, for ${sha}.`)
      return run
    }
    const state = run ? `${run.id}:${run.status}` : 'not-created'
    if (state !== previous) { log(`Waiting for the ${branch} push CI of ${sha}: ${state}.`); previous = state }
    if (now() >= deadline) break
    await sleep(Math.min(15_000, deadline - now()))
  } while (now() <= deadline)
  throw new Error(`No successful ${branch} push CI was verified for this exact commit before the deadline. Rerun after CI succeeds.`)
}
export async function verifyLatestChannel(version, { fetchImpl = fetch, now = Date.now } = {}) {
  stableVersion(version)
  const response = await fetchImpl(`https://github.com/fjpulidop/specrails-desktop/releases/latest/download/manifest.json?release-check=${now()}`, { signal: AbortSignal.timeout(15_000), headers: { 'Cache-Control': 'no-cache' } })
  if (response.status === 404) return
  if (!response.ok) throw new Error(`Cannot verify the current latest channel (HTTP ${response.status}); refusing to overwrite it.`)
  const current = await response.json()
  assertPromotion(version, current.version)
}
export const STABLE_SOAK_DAYS = 7
const STABLE_POINTER = 'https://github.com/fjpulidop/specrails-desktop/releases/download/stable/latest.json'
/**
 * Pure stable-channel admission: a published (non-draft, non-prerelease) vX.Y.Z
 * release that soaked on latest for STABLE_SOAK_DAYS, whose exact commit has a
 * green main push CI, which ships an updater latest.json, and which does not move
 * stable backwards unless a rollback is explicitly requested.
 */
export function assertStablePromotion({ version, release, ciRun, currentStable = null, now = Date.now(), allowRollback = false, repository, sha }) {
  stableVersion(version)
  validIdentity(repository, sha)
  const tag = `v${version}`
  if (!release || release.tag_name !== tag) throw new Error(`Release ${tag} was not found; only published releases can be promoted.`)
  if (release.draft || release.prerelease) throw new Error(`Release ${tag} is a draft or prerelease; only published releases can be promoted.`)
  const published = Date.parse(release.published_at ?? '')
  if (!Number.isFinite(published)) throw new Error(`Release ${tag} has no publication date.`)
  const soakedDays = (now - published) / 86_400_000
  if (soakedDays < STABLE_SOAK_DAYS) throw new Error(`Release ${tag} has been on latest for ${soakedDays.toFixed(1)} days; stable requires ${STABLE_SOAK_DAYS}.`)
  if (!Array.isArray(release.assets) || !release.assets.some(asset => asset?.name === 'latest.json')) throw new Error(`Release ${tag} has no updater latest.json asset.`)
  if (!ciRun || ciRun.status !== 'completed' || ciRun.conclusion !== 'success') throw new Error(`No successful main push CI was found for ${tag} (${sha}); stable promotion is blocked.`)
  if (currentStable !== null) {
    stableVersion(currentStable)
    if (!allowRollback) assertPromotion(version, currentStable)
  }
  return { tag, version, sha }
}
/** Current stable pointer version, or null before the first promotion (404). */
export async function currentStableVersion({ fetchImpl = fetch, now = Date.now } = {}) {
  const response = await fetchImpl(`${STABLE_POINTER}?release-check=${now()}`, { signal: AbortSignal.timeout(15_000), headers: { 'Cache-Control': 'no-cache' } })
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`Cannot read the current stable channel (HTTP ${response.status}); refusing to overwrite it.`)
  return stableVersion((await response.json()).version)
}
export async function stablePromotion({ repository, version, allowRollback = false, request = githubJson, fetchImpl = fetch, now = Date.now }) {
  stableVersion(version)
  const tag = `v${version}`
  const release = await request(`/repos/${repository}/releases/tags/${tag}`)
  const commit = await request(`/repos/${repository}/commits/${tag}`)
  const sha = commit?.sha
  validIdentity(repository, sha)
  const runs = await request(`/repos/${repository}/actions/workflows/ci.yml/runs?head_sha=${sha}&event=push&branch=main&per_page=100`)
  if (!Array.isArray(runs.workflow_runs)) throw new Error('GitHub returned an invalid CI history. Promotion remains blocked.')
  const ciRun = latestTrustedCiRun(runs.workflow_runs, { repository, sha })
  const currentStable = await currentStableVersion({ fetchImpl, now })
  return assertStablePromotion({ version, release, ciRun, currentStable, now: now(), allowRollback, repository, sha })
}
/** Retention expiry permits one source rebuild; API errors or conflicting evidence never do. */
export async function retainedClientArtifact({ repository, sha, runId, request = githubJson }) {
  validIdentity(repository, sha)
  if (!Number.isSafeInteger(runId) || runId < 1) throw new Error('Invalid admitted CI run ID.')
  const run = await request(`/repos/${repository}/actions/runs/${runId}`)
  if (run.id !== runId || run.head_sha !== sha || run.event !== 'push' || run.conclusion !== 'success' || run.status !== 'completed'
    || run.repository?.full_name !== repository || run.head_repository?.full_name !== repository) throw new Error('Frontend evidence must belong to the admitted successful source CI.')
  const matches = []
  for (let page = 1; page <= 100; page++) {
    const response = await request(`/repos/${repository}/actions/runs/${runId}/artifacts?per_page=100&page=${page}`)
    if (!Array.isArray(response.artifacts)) throw new Error('GitHub returned an invalid artifact inventory.')
    matches.push(...response.artifacts.filter(artifact => artifact.name === 'verified-desktop-client' && artifact.expired === false))
    if (response.artifacts.length < 100) {
      if (matches.length > 1) throw new Error('Ambiguous frontend evidence for this CI run.')
      if (matches.length && (!Number.isSafeInteger(matches[0].id) || matches[0].id < 1)) throw new Error('Invalid frontend artifact identity.')
      return matches[0]?.id ?? null
    }
  }
  throw new Error('Artifact inventory exceeds its bounded pagination limit.')
}
export function verifiedNpmPackage(directory, expected) {
  const receipt = JSON.parse(fs.readFileSync(path.join(directory, 'package-verification.json'), 'utf8'))
  if (receipt.name !== expected.name || receipt.version !== expected.version) throw new Error('The package receipt does not match this release source.')
  stableVersion(receipt.version)
  if (typeof receipt.filename !== 'string' || path.basename(receipt.filename) !== receipt.filename || !receipt.filename.endsWith('.tgz')) throw new Error('Invalid verified package filename.')
  const tarballs = fs.readdirSync(directory).filter(name => name.endsWith('.tgz'))
  if (tarballs.length !== 1 || tarballs[0] !== receipt.filename) throw new Error('Publication requires exactly one verified tarball.')
  const filename = path.join(directory, receipt.filename)
  if (!fs.lstatSync(filename).isFile()) throw new Error('The package tarball must be a regular file.')
  const bytes = fs.readFileSync(filename)
  const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`
  if (integrity !== receipt.integrity || createHash('sha256').update(bytes).digest('hex') !== receipt.sha256) throw new Error('The downloaded tarball differs from the verified package.')
  return receipt
}
export async function npmPackageStatus(receipt, { fetchImpl = fetch } = {}) {
  if (!/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/.test(receipt.name ?? '')) throw new Error('Invalid package identity.')
  stableVersion(receipt.version)
  const response = await fetchImpl(`https://registry.npmjs.org/${encodeURIComponent(receipt.name)}/${receipt.version}`, { signal: AbortSignal.timeout(15_000) })
  if (response.status === 404) {
    const latest = await fetchImpl(`https://registry.npmjs.org/${encodeURIComponent(receipt.name)}/latest`, { signal: AbortSignal.timeout(15_000) })
    if (latest.status !== 404) {
      if (!latest.ok) throw new Error(`Cannot verify npm latest (HTTP ${latest.status}); refusing to move the dist-tag.`)
      assertPromotion(receipt.version, (await latest.json()).version)
    }
    return false
  }
  if (!response.ok) throw new Error(`Cannot determine whether this package was already published (HTTP ${response.status}).`)
  const existing = await response.json()
  if (existing.dist?.integrity !== receipt.integrity) throw new Error('This npm version already exists with different package contents. Do not overwrite or silently accept it.')
  return true
}
function output(name, value) {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`)
  else console.log(`${name}=${value}`)
}
async function main(command) {
  const repository = process.env.GITHUB_REPOSITORY
  const sha = process.env.RELEASE_SHA || process.env.GITHUB_SHA
  if (command === 'tag') {
    const { version } = JSON.parse(fs.readFileSync('package.json', 'utf8'))
    const identity = releaseTag(process.env.GITHUB_REF, version)
    const actual = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    if (actual !== sha) throw new Error('The checked-out commit differs from the release event; refusing to publish.')
    output('tag', identity.tag); output('version', identity.version)
  } else if (command === 'ci') {
    await requireSuccessfulCi({ repository, sha })
  } else if (command === 'desktop-admission') {
    const { version } = JSON.parse(fs.readFileSync('package.json', 'utf8'))
    const checkoutSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    const mode = desktopReleaseMode({ eventName: process.env.GITHUB_EVENT_NAME, validationOnly: process.env.VALIDATION_ONLY,
      ref: process.env.GITHUB_REF, repository, sha, checkoutSha, version })
    const ciRun = await requireSuccessfulCi({ repository, sha, branch: mode.ciBranch })
    output('ci_run_id', ciRun.id)
    output('publish', String(mode.publish))
    output('version', mode.version)
    if (mode.tag) output('tag', mode.tag)
  } else if (command === 'main-current') {
    validIdentity(repository, sha)
    const current = await githubJson(`/repos/${repository}/git/ref/heads/main`)
    output('current', current.object?.sha === sha ? 'true' : 'false')
  } else if (command === 'client-artifact') {
    const artifact = await retainedClientArtifact({ repository, sha, runId: Number(process.env.CI_RUN_ID) })
    output('available', artifact === null ? 'false' : 'true')
    if (artifact !== null) output('artifact_id', artifact)
  } else if (command === 'latest') {
    await verifyLatestChannel(process.env.RELEASE_VERSION)
  } else if (command === 'npm-status') {
    const expected = JSON.parse(fs.readFileSync('package.json', 'utf8'))
    const receipt = verifiedNpmPackage('artifacts/npm', expected)
    output('published', await npmPackageStatus(receipt) ? 'true' : 'false')
  } else if (command === 'core-version') {
    output('version', stableVersion(process.env.CORE_VERSION))
  } else if (command === 'stable-promotion') {
    const allowRollback = process.env.ALLOW_STABLE_ROLLBACK === 'true'
    const result = await stablePromotion({ repository, version: process.env.PROMOTE_VERSION, allowRollback })
    output('tag', result.tag); output('version', result.version); output('sha', result.sha)
  } else throw new Error('Usage: release-policy.mjs tag|ci|desktop-admission|client-artifact|main-current|latest|npm-status|core-version|stable-promotion')
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv[2]).catch(error => { console.error(error.message); process.exitCode = 1 })
