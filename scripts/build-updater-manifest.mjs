/** Build a complete, installer-aware Tauri update release. No fallback across installer families. */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

function filesIn(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const name = path.join(dir, entry.name)
    return entry.isDirectory() ? filesIn(name) : entry.isFile() ? [name] : []
  })
}

export function buildUpdaterManifest({ artifacts, output, version, releaseUrl, publishedAt = new Date().toISOString() }) {
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) throw new Error('Invalid release version')
  if (new URL(releaseUrl).protocol !== 'https:') throw new Error('Release URL must use HTTPS')
  const platforms = {}
  const copies = []
  function add(platform, directory, suffix, filename) {
    const matches = filesIn(path.join(artifacts, directory)).filter(file => file.endsWith(`${suffix}.sig`))
    if (matches.length !== 1) throw new Error(`${platform}: expected exactly one ${suffix}.sig, found ${matches.length}`)
    const sig = matches[0]
    const pkg = sig.slice(0, -4)
    if (!fs.statSync(pkg).isFile() || fs.statSync(pkg).size === 0) throw new Error(`${platform}: empty or missing installer`)
    const signature = fs.readFileSync(sig, 'utf8').trim()
    if (!signature || /\s/.test(signature) || !/^[A-Za-z0-9+/]+={0,2}$/.test(signature)) {
      throw new Error(`${platform}: empty or malformed Tauri signature`)
    }
    platforms[platform] = { signature, url: `${releaseUrl.replace(/\/$/, '')}/${filename}` }
    copies.push([pkg, filename], [sig, `${filename}.sig`])
  }
  add('darwin-aarch64', 'dmg-aarch64', '.app.tar.gz', `specrails-desktop-${version}-darwin-aarch64.app.tar.gz`)
  for (const [arch, directory] of [['x86_64', 'windows-x64'], ['aarch64', 'windows-arm64']]) {
    const base = `windows-${arch}`
    add(`${base}-nsis`, directory, '-setup.exe', `specrails-desktop-${version}-${base}-setup.exe`)
    add(`${base}-msi`, directory, '.msi', `specrails-desktop-${version}-${base}.msi`)
    // Compatibility for earlier clients that only understand OS-ARCH keys.
    platforms[base] = platforms[`${base}-nsis`]
  }
  // Validate all inputs before touching the publish directory.
  fs.mkdirSync(output, { recursive: true })
  for (const [source, filename] of copies) fs.copyFileSync(source, path.join(output, filename))
  const manifest = { version, notes: `Specrails ${version}`, pub_date: publishedAt, platforms }
  fs.writeFileSync(path.join(output, 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [artifacts, output, version, releaseUrl] = process.argv.slice(2)
  if (!artifacts || !output || !version || !releaseUrl) throw new Error('Usage: build-updater-manifest.mjs <artifacts> <output> <version> <release-url>')
  console.log(JSON.stringify(buildUpdaterManifest({ artifacts, output, version, releaseUrl }), null, 2))
}
