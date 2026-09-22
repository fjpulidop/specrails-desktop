import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { recoveryManifest, requireNativeBuilds, verifyInstaller } from './recover-desktop-channel.mjs'

const repo = 'fjpulidop/specrails-desktop'
const version = '2.54.0'
const bytes = Buffer.from('signed installer fixture')
const digest = createHash('sha256').update(bytes).digest('hex')
function release() {
  return {
    tag_name: `v${version}`, draft: false, prerelease: false,
    html_url: `https://github.com/${repo}/releases/tag/v${version}`,
    published_at: '2026-09-22T18:06:42Z',
    assets: ['aarch64.dmg', 'x64-setup.exe', 'arm64-setup.exe'].map(suffix => {
      const name = `specrails-desktop-${version}-${suffix}`
      return { name, state: 'uploaded', size: bytes.length, digest: `sha256:${digest}`,
        browser_download_url: `https://github.com/${repo}/releases/download/v${version}/${name}` }
    }),
  }
}

test('recovery preserves the download contract using immutable release asset URLs', () => {
  const result = recoveryManifest(release(), version)
  assert.equal(result.version, version)
  assert.equal(result.schemaVersion, 1)
  assert.deepEqual(Object.keys(result.platforms), ['darwin-arm64', 'windows-x64', 'windows-arm64'])
  assert.equal(result.platforms['darwin-arm64'].sha256, digest)
  assert.ok(result.platforms['windows-x64'].url.endsWith('/specrails-desktop-2.54.0-x64-setup.exe'))
})

test('recovery rejects unpublished releases, missing assets, untrusted URLs and digests', () => {
  for (const mutate of [
    r => { r.draft = true }, r => { r.prerelease = true }, r => { r.tag_name = 'v2.53.0' },
    r => { r.assets.pop() }, r => { r.assets.push(r.assets[0]) },
    r => { r.assets[0].browser_download_url = 'https://example.com/installer' },
    r => { r.assets[0].digest = null }, r => { r.assets[0].size = 0 },
  ]) {
    const fixture = release(); mutate(fixture)
    assert.throws(() => recoveryManifest(fixture, version))
  }
  assert.throws(() => recoveryManifest(release(), '../../main'))
})

test('every streamed byte must match the published installer size and SHA-256', async () => {
  const asset = recoveryManifest(release(), version).platforms['darwin-arm64']
  await verifyInstaller(asset, async () => new Response(bytes))
  for (const payload of [bytes.subarray(1), Buffer.concat([bytes, bytes]), Buffer.alloc(bytes.length)]) {
    await assert.rejects(verifyInstaller(asset, async () => new Response(payload)), /mismatch/)
  }
  await assert.rejects(verifyInstaller(asset, async () => new Response('<html>SPA fallback</html>')), /mismatch/)
  await assert.rejects(verifyInstaller(asset, async () => new Response('', { status: 404 })), /failed/)
})

test('recovery requires successful native builds for the exact trusted tag and commit', () => {
  const sha = 'a'.repeat(40)
  const run = { id: 12, head_sha: sha, event: 'push', head_branch: 'v2.54.0', head_repository: { full_name: repo } }
  const jobs = ['admission', 'build-macos', 'build-windows', 'build-windows-arm64'].map((name, id) => ({ id, run_id: 12, name, conclusion: 'success' }))
  requireNativeBuilds([run], jobs, sha, 'v2.54.0')
  assert.throws(() => requireNativeBuilds([run], jobs, 'b'.repeat(40), 'v2.54.0'))
  assert.throws(() => requireNativeBuilds([{ ...run, event: 'pull_request' }], jobs, sha, 'v2.54.0'))
  assert.throws(() => requireNativeBuilds([run], jobs.slice(0, 3), sha, 'v2.54.0'))
  assert.throws(() => requireNativeBuilds([run], [...jobs, { ...jobs[1], id: 99, conclusion: 'failure' }], sha, 'v2.54.0'))
})
