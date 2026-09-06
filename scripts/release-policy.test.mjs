import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stableVersion, releaseTag, desktopReleaseMode, assertPromotion, latestTrustedCiRun, requireSuccessfulCi, verifyLatestChannel, githubJson } from './release-policy.mjs'
const repository = 'fjpulidop/specrails-desktop'
const sha = 'a'.repeat(40)
const run = (extra = {}) => ({ id: 12, head_sha: sha, event: 'push', head_branch: 'main', head_repository: { full_name: repository }, repository: { full_name: repository }, status: 'completed', conclusion: 'success', ...extra })
test('release tag must match the exact stable package version', () => {
  assert.deepEqual(releaseTag('refs/tags/v2.40.0', '2.40.0'), { tag: 'v2.40.0', version: '2.40.0' })
  for (const version of ['2.40.0-beta.1', '2.40.0+build', '02.40.0', 'v2.40.0', '2.40.0\n', '2.40.0;echo hi']) assert.throws(() => stableVersion(version))
  for (const ref of ['refs/heads/v2.40.0', 'refs/heads/main', 'refs/tags/v2.40.1', 'refs/tags/v2.40.0-beta.1']) assert.throws(() => releaseTag(ref, '2.40.0'))
})
test('publication never downgrades the stable channel, including double-digit versions', () => {
  assertPromotion('2.10.0', '2.9.99'); assertPromotion('3.0.0', '2.99.99'); assertPromotion('2.40.0', '2.40.0')
  assert.throws(() => assertPromotion('2.9.99', '2.10.0')); assert.throws(() => assertPromotion('2.40.0', 'bad'))
})
test('only the latest main push CI from the same repository and exact SHA authorizes a release', () => {
  const untrusted = [run({ head_sha: 'b'.repeat(40) }), run({ event: 'pull_request' }), run({ head_branch: 'feature' }), run({ head_repository: { full_name: 'other/fork' } }), run({ repository: { full_name: 'other/repo' } })]
  assert.equal(latestTrustedCiRun(untrusted, { repository, sha }), null)
  assert.equal(latestTrustedCiRun([run({ id: 10 }), run({ id: 13, conclusion: 'failure' })], { repository, sha }).conclusion, 'failure')
})
test('CI admission waits for the exact run, then confirms its current successful attempt', async () => {
  const results = [[], [run({ status: 'in_progress', conclusion: null })], [run({ run_attempt: 2 })]]
  let time = 0; const routes = []
  const result = await requireSuccessfulCi({ repository, sha, request: async route => { routes.push(route); return { workflow_runs: results.shift() } }, now: () => time, sleep: async ms => { time += ms }, timeoutMs: 40_000, log() {} })
  assert.equal(result.run_attempt, 2); assert.equal(routes.length, 3); assert(routes.every(route => route.includes(`head_sha=${sha}`) && route.includes('ci.yml')))
})
test('failed, cancelled, missing, malformed or unavailable CI cannot authorize publication', async () => {
  for (const conclusion of ['failure', 'cancelled', 'skipped', 'neutral', null]) await assert.rejects(requireSuccessfulCi({ repository, sha, request: async () => ({ workflow_runs: [run({ conclusion })] }), log() {} }))
  await assert.rejects(requireSuccessfulCi({ repository, sha, request: async () => ({ workflow_runs: [] }), timeoutMs: 0, log() {} }), /deadline/)
  await assert.rejects(requireSuccessfulCi({ repository, sha, request: async () => ({}), log() {} }), /invalid CI/)
  await assert.rejects(githubJson('/test', { token: 'test-token', fetchImpl: async () => ({ ok: false, status: 403 }) }), /403/)
})
test('latest channel reads fail closed, permit first publication, and reject stale releases', async () => {
  await verifyLatestChannel('2.40.0', { fetchImpl: async () => ({ status: 404 }) })
  await assert.rejects(verifyLatestChannel('2.40.0', { fetchImpl: async () => ({ ok: false, status: 503 }) }), /503/)
  await assert.rejects(verifyLatestChannel('2.40.0', { fetchImpl: async () => ({ ok: true, json: async () => ({ version: '2.41.0' }) }) }), /older release/)
  await verifyLatestChannel('2.41.0', { fetchImpl: async () => ({ ok: true, json: async () => ({ version: '2.40.0' }) }) })
})

test('npm retries are idempotent only for identical artifacts and never lower latest', async () => {
  const { npmPackageStatus } = await import('./release-policy.mjs')
  const receipt = { name: 'specrails-desktop', version: '2.40.0', integrity: 'sha512-tested' }
  assert.equal(await npmPackageStatus(receipt, { fetchImpl: async () => ({ ok: true, json: async () => ({ dist: { integrity: receipt.integrity } }) }) }), true)
  await assert.rejects(npmPackageStatus(receipt, { fetchImpl: async () => ({ ok: true, json: async () => ({ dist: { integrity: 'different' } }) }) }), /different package/)
  const missingThenLatest = version => async url => url.endsWith('/latest') ? { ok: true, json: async () => ({ version }) } : { status: 404 }
  await assert.rejects(npmPackageStatus(receipt, { fetchImpl: missingThenLatest('2.41.0') }), /older release/)
  assert.equal(await npmPackageStatus(receipt, { fetchImpl: missingThenLatest('2.39.0') }), false)
  await assert.rejects(npmPackageStatus(receipt, { fetchImpl: async () => ({ ok: false, status: 503 }) }), /503/)
})

test('publication validates the downloaded tarball against the verified receipt and source', async () => {
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path'); const { createHash } = await import('node:crypto')
  const { verifiedNpmPackage } = await import('./release-policy.mjs')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'specrails-release-receipt-'))
  try {
    const bytes = Buffer.from('fixture tarball bytes')
    const receipt = { name: 'specrails-desktop', version: '2.40.0', filename: 'specrails-desktop-2.40.0.tgz', sha256: createHash('sha256').update(bytes).digest('hex'), integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}` }
    fs.writeFileSync(path.join(root, receipt.filename), bytes)
    fs.writeFileSync(path.join(root, 'package-verification.json'), JSON.stringify(receipt))
    assert.equal(verifiedNpmPackage(root, receipt).filename, receipt.filename)
    assert.throws(() => verifiedNpmPackage(root, { ...receipt, version: '2.41.0' }), /does not match/)
    fs.writeFileSync(path.join(root, 'extra.tgz'), 'extra')
    assert.throws(() => verifiedNpmPackage(root, receipt), /exactly one/)
    fs.unlinkSync(path.join(root, 'extra.tgz'))
    fs.writeFileSync(path.join(root, receipt.filename), 'tampered')
    assert.throws(() => verifiedNpmPackage(root, receipt), /differs/)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('native validation selects exact branch CI without granting publication; normal releases retain main/tag admission', () => {
  const source = { repository, sha, checkoutSha: sha, version: '2.40.0' }
  const validation = desktopReleaseMode({ ...source, eventName: 'workflow_dispatch', validationOnly: 'true', ref: 'refs/heads/codex/chromium-signing' })
  assert.deepEqual(validation, { publish: false, ciBranch: 'codex/chromium-signing', version: '2.40.0' })
  const taggedValidation = desktopReleaseMode({ ...source, eventName: 'workflow_dispatch', validationOnly: true, ref: 'refs/tags/v2.40.0' })
  assert.equal(taggedValidation.publish, false)
  assert.equal(taggedValidation.ciBranch, 'main')
  for (const input of [{ eventName: 'push' }, { eventName: 'workflow_dispatch', validationOnly: false }]) {
    const release = desktopReleaseMode({ ...source, ...input, ref: 'refs/tags/v2.40.0' })
    assert.equal(release.publish, true)
    assert.equal(release.ciBranch, 'main')
    assert.throws(() => desktopReleaseMode({ ...source, ...input, ref: 'refs/heads/main' }))
  }
  for (const input of [
    { eventName: 'pull_request', validationOnly: true, ref: 'refs/heads/main' },
    { eventName: 'push', validationOnly: true, ref: 'refs/tags/v2.40.0' },
    { eventName: 'workflow_dispatch', ref: 'refs/heads/main' },
    { eventName: 'workflow_dispatch', validationOnly: 'TRUE', ref: 'refs/heads/main' },
    { eventName: 'workflow_dispatch', validationOnly: true, ref: 'refs/pull/1/head' },
    { eventName: 'workflow_dispatch', validationOnly: true, ref: 'refs/heads/fix?branch=main' },
    { eventName: 'workflow_dispatch', validationOnly: true, ref: 'refs/heads/a\nb' },
    { eventName: 'workflow_dispatch', validationOnly: false, ref: 'refs/tags/v2.41.0' },
    { eventName: 'workflow_dispatch', validationOnly: true, ref: 'refs/heads/main', checkoutSha: 'b'.repeat(40) },
  ]) assert.throws(() => desktopReleaseMode({ ...source, ...input }))
})

test('validation CI cannot borrow another branch, another repository or a PR result for the same SHA', async () => {
  const branch = 'codex/chromium-signing'
  const history = [run(), run({ head_branch: branch, event: 'pull_request' }), run({ head_branch: branch, head_repository: { full_name: 'other/fork' } })]
  await assert.rejects(requireSuccessfulCi({ repository, sha, branch, request: async () => ({ workflow_runs: history }), timeoutMs: 0, log() {} }), /deadline/)
  let route
  const verified = await requireSuccessfulCi({ repository, sha, branch, request: async value => { route = value; return { workflow_runs: [...history, run({ id: 99, head_branch: branch })] } }, log() {} })
  assert.equal(verified.id, 99)
  assert.match(route, /branch=codex%2Fchromium-signing&/)
  // npm/release calls which omit the validation branch remain main-only.
  assert.equal(latestTrustedCiRun([verified], { repository, sha }), null)
})

test('the actual workflow has no public publication path from validation, even with a forged publish output', async () => {
  const fs = await import('node:fs')
  const { load } = await import('js-yaml')
  const { runInNewContext } = await import('node:vm')
  const workflow = load(fs.readFileSync(new URL('../.github/workflows/desktop-release.yml', import.meta.url), 'utf8'))
  assert.equal(workflow.on.workflow_dispatch.inputs.validation_only.default, true)
  const publicationJobs = Object.entries(workflow.jobs).filter(([, job]) => job.steps?.some(step => /gh release (?:upload|create)|SamKirkland\/FTP-Deploy-Action/.test(`${step.run ?? ''} ${step.uses ?? ''}`)))
  assert.equal(publicationJobs.length, 1)
  for (const [, job] of publicationJobs) {
    assert(job.needs.includes('admission'))
    for (const publish of ['false', 'true']) {
      const accepted = runInNewContext(job.if, { needs: { admission: { outputs: { publish } } }, github: { event_name: 'workflow_dispatch' }, inputs: { validation_only: true } }, { timeout: 100 })
      assert.equal(accepted, false, 'Validation must not execute a job containing GitHub release or FTP publication')
    }
    const context = { needs: { admission: { outputs: { publish: 'true' } } }, github: { event_name: 'workflow_dispatch' }, inputs: { validation_only: false } }
    assert.equal(runInNewContext(job.if, context, { timeout: 100 }), true)
    context.needs.admission.outputs.publish = 'false'
    assert.equal(runInNewContext(job.if, context, { timeout: 100 }), false)
  }
})
