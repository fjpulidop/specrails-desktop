import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
test('client capability public subpaths and dependencies match the reviewed manifest', () => {
  const result = spawnSync(process.execPath, ['scripts/audit-client-features.mjs', '--check'], { cwd: root, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr || result.stdout)
})
