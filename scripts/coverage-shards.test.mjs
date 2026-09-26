import test from 'node:test'
import assert from 'node:assert/strict'
import { validateShardManifests } from './coverage-shards.mjs'

const expected = { suite: 'server', commit: 'a'.repeat(40), version: '4.1.10', configHash: 'b'.repeat(64), count: 2, inventory: ['a.test.ts', 'b.test.ts'] }
const fixtures = () => [1, 2].map(part => ({ ...expected, schemaVersion: 1, part, success: true,
  files: [expected.inventory[part - 1]], report: `shard-${part}.blob.json`, reportHash: 'c'.repeat(64) }))

test('all same-commit shards cover every test exactly once regardless of download order', () => {
  validateShardManifests(fixtures().reverse(), expected)
})
test('missing, overlapping, stale, failed and foreign shards cannot authorize a release', () => {
  for (const mutate of [
    rows => rows.pop(), rows => rows.push(rows[0]), rows => { rows[1].part = 1 },
    rows => { rows[1].files = rows[0].files }, rows => { rows[1].files = [] },
    rows => { rows[1].inventory = ['a.test.ts'] }, rows => { rows[0].success = false },
    ...['suite', 'commit', 'version', 'configHash', 'count', 'schemaVersion'].map(key => rows => { rows[0][key] = 'wrong' }),
    rows => { rows[0].report = '../outside' }, rows => { rows[0].reportHash = '' },
  ]) {
    const rows = fixtures(); mutate(rows)
    assert.throws(() => validateShardManifests(rows, expected))
  }
})
