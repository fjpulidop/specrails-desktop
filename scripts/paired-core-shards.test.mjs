import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PAIRED_COMPANIONS, WEIGHTS, assignShards, discoverPairedSuites } from './paired-core-shards.mjs'

const repository = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

test('every discovered paired suite runs in exactly one shard for every CI shard count', () => {
  const files = discoverPairedSuites()
  assert.ok(files.length >= PAIRED_COMPANIONS.length + 1)
  for (const count of [1, 2, 3, 4, 5]) {
    const assigned = assignShards(files, count).flat()
    assert.deepEqual([...assigned].sort(), files)
    assert.equal(new Set(assigned).size, assigned.length)
  }
})

test('timing weights only name suites that still exist', () => {
  for (const file of Object.keys(WEIGHTS)) assert.ok(fs.existsSync(path.join(repository, file)), `Stale weight: ${file}`)
})

test('unknown suites are still assigned and shards stay deterministic and balanced', () => {
  const files = ['a.test.ts', 'b.test.ts', 'c.test.ts', 'd.test.ts']
  const weights = { 'a.test.ts': 10, 'b.test.ts': 6, 'c.test.ts': 4 }
  // The unknown suite gets the conservative default weight and a runner of its own.
  assert.deepEqual(assignShards(files, 2, weights), [['d.test.ts'], ['a.test.ts', 'b.test.ts', 'c.test.ts']])
  assert.deepEqual(assignShards(files, 2, weights), assignShards([...files].reverse(), 2, weights))
  assert.throws(() => assignShards(files, 0))
  assert.throws(() => assignShards(files, 5))
})
