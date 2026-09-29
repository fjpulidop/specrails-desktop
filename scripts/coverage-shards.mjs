import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repository = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'))
const portable = value => value.split(path.sep).join('/')
const sorted = values => [...values].sort()

function invoke(root, args) {
  const result = spawnSync(process.execPath, [path.join(root, 'node_modules/vitest/vitest.mjs'), ...args], {
    cwd: root, stdio: 'inherit', windowsHide: true,
  })
  if (result.error) throw result.error
  assert.equal(result.status, 0, `Vitest failed (${result.signal ?? result.status})`)
}

function configuration(suite, repositoryRoot = repository) {
  assert.ok(['server', 'client'].includes(suite), 'Unknown coverage suite')
  const root = suite === 'client' ? path.join(repositoryRoot, 'client') : repositoryRoot
  const files = ['package-lock.json', 'vitest.config.ts', 'vitest.shard.config.ts']
  const configHash = digest(Buffer.concat([
    ...files.map(file => fs.readFileSync(path.join(root, file))),
    fs.readFileSync(fileURLToPath(import.meta.url)),
  ]))
  const sha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8', windowsHide: true })
  assert.equal(sha.status, 0, 'Cannot identify coverage commit')
  return { suite, root, configHash, commit: sha.stdout.trim(), version: json(path.join(root, 'node_modules/vitest/package.json')).version }
}

function inventory(root, output) {
  invoke(root, ['list', '--filesOnly', '--json', output])
  const files = json(output).map(item => portable(path.relative(root, item.file)))
  assert.ok(files.length > 0 && files.every(file => !file.startsWith('../') && !path.isAbsolute(file)), 'Invalid test inventory')
  assert.equal(new Set(files).size, files.length, 'Duplicate test file')
  return sorted(files)
}

/** Reject missing, duplicated, stale or mixed reports before coverage merging. */
export function validateShardManifests(manifests, expected) {
  assert.equal(manifests.length, expected.count, 'Missing coverage shard')
  const seen = new Set(), files = []
  for (const item of manifests) {
    for (const key of ['suite', 'commit', 'version', 'configHash', 'count']) assert.equal(item[key], expected[key], `Coverage ${key} mismatch`)
    assert.ok(Number.isInteger(item.part) && item.part >= 1 && item.part <= expected.count && !seen.has(item.part), 'Duplicate/invalid coverage shard')
    seen.add(item.part)
    assert.equal(item.schemaVersion, 1)
    assert.equal(item.success, true, 'A failed shard cannot authorize coverage')
    assert.deepEqual(item.inventory, sorted(expected.inventory), 'Shard collected a different test inventory')
    assert.ok(Array.isArray(item.files) && item.files.length > 0, 'Empty coverage shard')
    assert.match(item.reportHash, /^[a-f0-9]{64}$/)
    assert.match(item.report, /^shard-\d+\.blob\.json$/)
    files.push(...item.files)
  }
  assert.deepEqual(sorted(files), sorted(expected.inventory), 'Shard assignments must be disjoint and exhaustive')
}

export function runCoverageShard(suite, part, count, output, repositoryRoot = repository) {
  assert.ok(Number.isInteger(part) && Number.isInteger(count) && part >= 1 && count >= part && count <= 32, 'Invalid shard position')
  const context = configuration(suite, repositoryRoot), directory = path.resolve(output)
  fs.mkdirSync(directory, { recursive: true })
  const manifestFile = path.join(directory, `shard-${part}.manifest.json`)
  // A previous success cannot survive a failed rerun in the same directory.
  fs.rmSync(manifestFile, { force: true })
  const all = inventory(context.root, path.join(directory, `shard-${part}.inventory.json`))
  const report = `shard-${part}.blob.json`, results = path.join(directory, `shard-${part}.results.json`)
  invoke(context.root, ['run', '--config', 'vitest.shard.config.ts', `--shard=${part}/${count}`, '--coverage',
    ...(suite === 'server' ? ['--maxWorkers=1'] : []),
    '--reporter=dot', '--reporter=blob', '--reporter=json',
    `--outputFile.blob=${path.join(directory, report)}`, `--outputFile.json=${results}`])
  const actual = json(results)
  assert.equal(actual.success, true, 'Vitest JSON report is unsuccessful')
  // `vitest list --filesOnly` deliberately lists the whole corpus even with
  // --shard. Record actual execution, then prove disjoint/exhaustive coverage
  // across all reports at the merge boundary; do not copy private sharding code.
  const assigned = sorted(actual.testResults.map(item => portable(path.relative(context.root, item.name))))
  assert.ok(assigned.length > 0 && assigned.every(file => all.includes(file)), 'Shard executed an unknown or empty inventory')
  assert.equal(new Set(assigned).size, assigned.length, 'Shard executed a duplicate test file')
  const { root: _root, ...identity } = context
  fs.writeFileSync(manifestFile, JSON.stringify({ schemaVersion: 1, ...identity, part, count, success: true,
    files: assigned, inventory: all, report, reportHash: digest(fs.readFileSync(path.join(directory, report))),
    tests: actual.numTotalTests, skipped: actual.numPendingTests, startedAt: actual.startTime, completedAt: Date.now(),
  }, null, 2) + '\n')
}

export function mergeCoverageShards(suite, count, input, repositoryRoot = repository) {
  assert.ok(Number.isInteger(count) && count > 0 && count <= 32, 'Invalid shard count')
  const context = configuration(suite, repositoryRoot), directory = path.resolve(input)
  const manifests = fs.readdirSync(directory).filter(file => file.endsWith('.manifest.json')).map(file => json(path.join(directory, file)))
  const all = inventory(context.root, path.join(directory, 'merge-inventory.json'))
  validateShardManifests(manifests, { ...context, count, inventory: all })
  const reports = path.join(directory, 'verified-blobs')
  fs.rmSync(reports, { recursive: true, force: true })
  fs.mkdirSync(reports)
  for (const manifest of manifests) {
    const bytes = fs.readFileSync(path.join(directory, manifest.report))
    assert.equal(digest(bytes), manifest.reportHash, 'Coverage blob integrity mismatch')
    fs.writeFileSync(path.join(reports, manifest.report), bytes)
  }
  // No shard config or threshold overrides here: enforce the repository policy.
  invoke(context.root, [`--merge-reports=${reports}`, '--coverage', '--config', 'vitest.config.ts'])
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [mode, suite, position, output] = process.argv.slice(2)
    assert.ok(output, 'Usage: coverage-shards.mjs run|merge server|client position output')
    if (mode === 'run') {
      assert.match(position, /^\d+\/\d+$/)
      runCoverageShard(suite, ...position.split('/').map(Number), output)
    } else {
      assert.equal(mode, 'merge', 'Unknown coverage operation')
      mergeCoverageShards(suite, Number(position), output)
    }
  } catch (error) { console.error(error); process.exitCode = 1 }
}
