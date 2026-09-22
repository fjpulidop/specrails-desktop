import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { githubJson, requireSuccessfulCi, stableVersion, verifyLatestChannel } from './release-policy.mjs'

const repository = 'fjpulidop/specrails-desktop'
const installers = {
  'darwin-arm64': 'aarch64.dmg',
  'windows-x64': 'x64-setup.exe',
  'windows-arm64': 'arm64-setup.exe',
}

export function recoveryManifest(release, version) {
  stableVersion(version)
  const releaseUrl = `https://github.com/${repository}/releases/tag/v${version}`
  if (release.tag_name !== `v${version}` || release.draft || release.prerelease || release.html_url !== releaseUrl
    || !Number.isFinite(Date.parse(release.published_at))) throw new Error('A published stable release is required')
  const platforms = {}
  for (const [platform, suffix] of Object.entries(installers)) {
    const filename = `specrails-desktop-${version}-${suffix}`
    const matches = release.assets.filter(asset => asset.name === filename)
    const asset = matches[0]
    const url = `https://github.com/${repository}/releases/download/v${version}/${filename}`
    if (matches.length !== 1 || asset.browser_download_url !== url || asset.state !== 'uploaded'
      || !Number.isSafeInteger(asset.size) || asset.size <= 0 || !/^sha256:[a-f0-9]{64}$/.test(asset.digest ?? '')) {
      throw new Error(`Missing or unverified installer: ${filename}`)
    }
    platforms[platform] = { filename, url, sha256: asset.digest.slice(7), size: asset.size }
  }
  return { schemaVersion: 1, version, releasedAt: release.published_at, releaseUrl, platforms }
}

export async function verifyInstaller(asset, fetchImpl = fetch) {
  const response = await fetchImpl(asset.url, { signal: AbortSignal.timeout(10 * 60_000) })
  if (!response.ok || !response.body) throw new Error(`Installer download failed: ${asset.filename}`)
  const hash = createHash('sha256')
  let size = 0
  for await (const chunk of response.body) {
    size += chunk.length
    if (size > asset.size) throw new Error(`Installer size mismatch: ${asset.filename}`)
    hash.update(chunk)
  }
  if (size !== asset.size || hash.digest('hex') !== asset.sha256) throw new Error(`Installer integrity mismatch: ${asset.filename}`)
}

export function requireNativeBuilds(runs, jobs, sha, tag) {
  const run = runs.find(candidate => candidate.head_sha === sha && candidate.event === 'push'
    && candidate.head_branch === tag && candidate.head_repository?.full_name === repository)
  if (!run) throw new Error('No trusted native release run exists for this tag')
  for (const name of ['admission', 'build-macos', 'build-windows', 'build-windows-arm64']) {
    const job = jobs.filter(candidate => candidate.run_id === run.id && candidate.name === name)
      .sort((a, b) => b.id - a.id)[0]
    if (job?.conclusion !== 'success') throw new Error(`Native release prerequisite failed: ${name}`)
  }
}

async function main() {
  const version = stableVersion(process.env.RECOVERY_VERSION)
  const tag = `v${version}`
  const commit = await githubJson(`/repos/${repository}/commits/${tag}`)
  await requireSuccessfulCi({ repository, sha: commit.sha, timeoutMs: 0 })
  const history = await githubJson(`/repos/${repository}/actions/workflows/desktop-release.yml/runs?head_sha=${commit.sha}&event=push&per_page=100`)
  const runs = history.workflow_runs.filter(run => run.head_branch === tag).sort((a, b) => b.id - a.id)
  if (!runs.length) throw new Error('No native release run exists')
  const { jobs } = await githubJson(`/repos/${repository}/actions/runs/${runs[0].id}/jobs?filter=all&per_page=100`)
  requireNativeBuilds(runs, jobs, commit.sha, tag)
  const release = await githubJson(`/repos/${repository}/releases/tags/${tag}`)
  const manifest = recoveryManifest(release, version)
  for (const asset of Object.values(manifest.platforms)) {
    await verifyInstaller(asset)
    console.log(`Verified size and SHA-256: ${asset.filename}`)
  }
  await verifyLatestChannel(version)
  fs.mkdirSync('recovery', { recursive: true })
  fs.writeFileSync('recovery/manifest.json', JSON.stringify(manifest, null, 2) + '\n')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
