import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { retainedClientArtifact } from './release-policy.mjs'

const identity = { repository: 'owner/desktop', sha: 'a'.repeat(40), runId: 7 }
const run = { id: 7, head_sha: identity.sha, event: 'push', status: 'completed', conclusion: 'success', repository: { full_name: identity.repository }, head_repository: { full_name: identity.repository } }
const artifact = { id: 99, name: 'verified-desktop-client', expired: false }
const requestFor = (artifacts, source = run) => async route => route.includes('/artifacts?') ? { artifacts } : source

test('a retained frontend is selected only from successful exact-source CI', async () => {
  assert.equal(await retainedClientArtifact({ ...identity, request: requestFor([artifact]) }), 99)
  for (const source of [{ ...run, head_sha: 'b'.repeat(40) }, { ...run, event: 'pull_request' }, { ...run, conclusion: 'failure' }, { ...run, head_repository: { full_name: 'fork/desktop' } }]) {
    await assert.rejects(retainedClientArtifact({ ...identity, request: requestFor([artifact], source) }), /admitted successful/)
  }
})
test('only genuine absence or expiry permits the single source rebuild', async () => {
  assert.equal(await retainedClientArtifact({ ...identity, request: requestFor([]) }), null)
  assert.equal(await retainedClientArtifact({ ...identity, request: requestFor([{ ...artifact, expired: true }]) }), null)
  await assert.rejects(retainedClientArtifact({ ...identity, request: async () => { throw new Error('GitHub unavailable') } }), /unavailable/)
  await assert.rejects(retainedClientArtifact({ ...identity, request: requestFor([artifact, { ...artifact, id: 100 }]) }), /Ambiguous/)
})
test('all native platforms require the shared frontend and integrity errors cannot fall back', () => {
  const workflow = fs.readFileSync(new URL('../.github/workflows/desktop-release.yml', import.meta.url), 'utf8')
  for (const name of ['build-macos', 'build-windows', 'build-windows-arm64']) assert.match(workflow, new RegExp(`  ${name}:\\n    needs: \\[admission, frontend\\]`))
  const frontend = workflow.slice(workflow.indexOf('  frontend:'), workflow.indexOf('  build-macos:'))
  assert.match(frontend, /if: steps\.retained\.outputs\.available == 'false'\n        run: \|\n          npm ci --prefix client\n          npm run build --prefix client/)
  assert.doesNotMatch(frontend, /continue-on-error|if: failure/)
  assert.equal((workflow.match(/name: release-verified-desktop-client/g) ?? []).length, 4)
})
