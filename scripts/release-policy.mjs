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
  const response = await fetchImpl(`https://specrails.dev/downloads/specrails-desktop/latest/manifest.json?release-check=${now()}`, { signal: AbortSignal.timeout(15_000), headers: { 'Cache-Control': 'no-cache' } })
  if (response.status === 404) return
  if (!response.ok) throw new Error(`Cannot verify the current latest channel (HTTP ${response.status}); refusing to overwrite it.`)
  const current = await response.json()
  assertPromotion(version, current.version)
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
    await requireSuccessfulCi({ repository, sha, branch: mode.ciBranch })
    output('publish', String(mode.publish))
    output('version', mode.version)
    if (mode.tag) output('tag', mode.tag)
  } else if (command === 'main-current') {
    validIdentity(repository, sha)
    const current = await githubJson(`/repos/${repository}/git/ref/heads/main`)
    output('current', current.object?.sha === sha ? 'true' : 'false')
  } else if (command === 'latest') {
    await verifyLatestChannel(process.env.RELEASE_VERSION)
  } else if (command === 'npm-status') {
    const expected = JSON.parse(fs.readFileSync('package.json', 'utf8'))
    const receipt = verifiedNpmPackage('artifacts/npm', expected)
    output('published', await npmPackageStatus(receipt) ? 'true' : 'false')
  } else if (command === 'core-version') {
    output('version', stableVersion(process.env.CORE_VERSION))
  } else throw new Error('Usage: release-policy.mjs tag|ci|desktop-admission|main-current|latest|npm-status|core-version')
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv[2]).catch(error => { console.error(error.message); process.exitCode = 1 })
