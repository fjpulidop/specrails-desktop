/**
 * Split the paired Core acceptance suites across CI runners.
 *
 * Every `*-paired.test.ts` under server/ is discovered, so a new paired suite
 * can never be silently left out of CI. Groups are balanced by the measured
 * Windows durations below (the slowest runner); unknown files get a default
 * weight and are still assigned. Each shard runs its files serially, exactly
 * like the former single job, and writes its own JUnit evidence.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repository = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const portable = value => value.split(path.sep).join('/')

// Fast Core contract suites that only run meaningfully against the paired checkout.
export const PAIRED_COMPANIONS = [
  'server/modules/loops/runtime/loop-definition-schema.test.ts',
  'server/modules/loops/runtime/loop-core-factory.test.ts',
  'server/modules/loops/runtime/loop-definition-recovery.test.ts',
]

// Seconds on windows-latest, from the per-shard JUnit of CI run 38090035612.
export const WEIGHTS = {
  'server/modules/loops/runtime/loop-factory-corrections-paired.test.ts': 381,
  'server/modules/loops/runtime/loop-compat-paired.test.ts': 333,
  'server/modules/loops/runtime/loop-factory-implement-paired.test.ts': 309,
  'server/modules/loops/runtime/loop-factory-paired.test.ts': 208,
  'server/modules/loops/runtime/loop-definition-crash-paired.test.ts': 172,
  'server/modules/agent-runtime/runtime/agent-runtime-retention-paired.test.ts': 110,
  'server/modules/delivery/runtime/definition-fork-paired.test.ts': 87,
  'server/modules/loops/runtime/loop-definition-recovery.test.ts': 63,
  'server/modules/agent-runtime/runtime/agent-runtime-steering-paired.test.ts': 17,
  'server/modules/loops/runtime/loop-core-factory.test.ts': 11,
  'server/modules/agent-runtime/runtime/agent-studio-paired.test.ts': 9,
  'server/modules/loops/runtime/loop-legacy-engine-paired.test.ts': 1,
  'server/modules/loops/runtime/loop-definition-schema.test.ts': 1,
}
const DEFAULT_WEIGHT = 120

export function discoverPairedSuites(root = repository) {
  const paired = fs.readdirSync(path.join(root, 'server'), { recursive: true })
    .map(file => `server/${portable(String(file))}`)
    .filter(file => file.endsWith('-paired.test.ts'))
  for (const file of PAIRED_COMPANIONS) assert.ok(fs.existsSync(path.join(root, file)), `Missing paired companion ${file}`)
  return [...new Set([...paired, ...PAIRED_COMPANIONS])].sort()
}

/** Longest-processing-time-first: deterministic, every file exactly once. */
export function assignShards(files, count, weights = WEIGHTS) {
  assert.ok(Number.isInteger(count) && count >= 1, 'Invalid shard count')
  assert.ok(files.length >= count, 'More shards than paired suites')
  const weight = file => weights[file] ?? DEFAULT_WEIGHT
  const shards = Array.from({ length: count }, () => ({ files: [], weight: 0 }))
  for (const file of [...files].sort((a, b) => weight(b) - weight(a) || a.localeCompare(b))) {
    const lightest = shards.reduce((best, shard) => (shard.weight < best.weight ? shard : best))
    lightest.files.push(file)
    lightest.weight += weight(file)
  }
  return shards.map(shard => shard.files.sort())
}

function parsePart(value) {
  const match = /^(\d+)\/(\d+)$/.exec(value ?? '')
  assert.ok(match, 'Expected <part>/<count>')
  const [part, count] = [Number(match[1]), Number(match[2])]
  assert.ok(part >= 1 && part <= count, 'Shard part out of range')
  return { part, count }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, spec, junit] = process.argv.slice(2)
  assert.ok(command === 'list' || command === 'run', 'Usage: paired-core-shards.mjs list|run <part>/<count> [junit-output]')
  const { part, count } = parsePart(spec)
  const files = assignShards(discoverPairedSuites(), count)[part - 1]
  if (command === 'list') console.log(files.join('\n'))
  else {
    const reporters = junit ? ['--reporter=default', '--reporter=junit', `--outputFile.junit=${junit}`] : []
    const result = spawnSync(process.execPath, [path.join(repository, 'node_modules/vitest/vitest.mjs'), 'run', '--maxWorkers=1', ...reporters, ...files], {
      cwd: repository, stdio: 'inherit', windowsHide: true,
    })
    if (result.error) throw result.error
    process.exitCode = result.status ?? 1
  }
}
