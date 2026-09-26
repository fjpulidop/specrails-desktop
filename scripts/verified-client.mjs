import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
function inventory(directory, relative = '') {
  return fs.readdirSync(path.join(directory, relative)).sort().flatMap(name => {
    assert.ok(!name.includes('\\') && !name.includes(':') && !/[\x00-\x1f]/.test(name), 'Unsafe frontend asset name')
    const file = path.posix.join(relative, name), absolute = path.join(directory, file), stat = fs.lstatSync(absolute)
    assert.ok(!stat.isSymbolicLink(), 'Frontend artifacts cannot contain symlinks')
    if (stat.isDirectory()) return inventory(directory, file)
    assert.ok(stat.isFile(), 'Frontend artifact contains a special file')
    return [{ path: file, bytes: stat.size, sha256: hash(fs.readFileSync(absolute)) }]
  })
}

function identity(root) {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim()
  assert.match(commit, /^[a-f0-9]{40}$/)
  if (process.env.GITHUB_SHA) assert.equal(commit, process.env.GITHUB_SHA, 'Frontend checkout differs from workflow commit')
  return { commit, lockHash: hash(fs.readFileSync(path.join(root, 'client/package-lock.json'))) }
}

export function verifyClientArtifact(artifact, expected) {
  const receipt = JSON.parse(fs.readFileSync(path.join(artifact, 'receipt.json'), 'utf8'))
  assert.equal(receipt.schemaVersion, 1)
  assert.equal(receipt.commit, expected.commit, 'Frontend artifact belongs to another commit')
  assert.equal(receipt.lockHash, expected.lockHash, 'Frontend dependency lock differs')
  const files = inventory(path.join(artifact, 'dist'))
  assert.ok(files.some(file => file.path === 'index.html') && files.some(file => /^assets\/.+\.js$/.test(file.path)), 'Frontend entry or JavaScript assets are missing')
  assert.deepEqual(files, receipt.files, 'Frontend artifact inventory or checksum differs')
  return receipt
}

export function stageClientArtifact(root, output) {
  const artifact = path.resolve(output), dist = path.join(root, 'client/dist'), files = inventory(dist)
  assert.ok(!artifact.startsWith(dist + path.sep) && artifact !== dist, 'Artifact cannot be inside the frontend distribution')
  fs.mkdirSync(artifact, { recursive: true })
  assert.equal(fs.readdirSync(artifact).length, 0, 'Artifact output must be empty')
  const expected = identity(root)
  fs.cpSync(dist, path.join(artifact, 'dist'), { recursive: true, errorOnExist: true })
  fs.writeFileSync(path.join(artifact, 'receipt.json'), JSON.stringify({ schemaVersion: 1, ...expected, node: process.versions.node, files }, null, 2) + '\n')
  return verifyClientArtifact(artifact, expected)
}

export function restoreClientArtifact(root, artifact) {
  const expected = identity(root), receipt = verifyClientArtifact(artifact, expected)
  // Validate all bytes before replacing a local build. CI downloads artifacts
  // only from the trusted, successful exact-source run selected by admission.
  const dist = path.join(root, 'client/dist')
  assert.ok(path.resolve(artifact) !== dist && !path.resolve(artifact).startsWith(dist + path.sep), 'Artifact cannot be the restore destination')
  fs.rmSync(dist, { recursive: true, force: true })
  fs.cpSync(path.join(artifact, 'dist'), dist, { recursive: true })
  assert.deepEqual(inventory(dist), receipt.files, 'Restored frontend differs from verified bytes')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [mode, artifact] = process.argv.slice(2)
    assert.ok(artifact, 'Usage: verified-client.mjs stage|restore artifact-directory')
    const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
    if (mode === 'stage') stageClientArtifact(root, artifact)
    else { assert.equal(mode, 'restore'); restoreClientArtifact(root, artifact) }
  } catch (error) { console.error(error); process.exitCode = 1 }
}
