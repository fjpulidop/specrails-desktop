import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { runCoverageShard, mergeCoverageShards } from './coverage-shards.mjs'

test('real Vitest shards merge coverage and retain failing aggregate thresholds', { timeout: 60_000 }, t => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'specrails-coverage-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.symlinkSync(fileURLToPath(new URL('../node_modules', import.meta.url)), path.join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module","private":true}')
  fs.writeFileSync(path.join(root, 'package-lock.json'), '{}')
  const git = args => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true })
    assert.equal(result.status, 0, result.stderr)
  }
  git(['init', '-q'])
  git(['-c', 'user.name=Coverage fixture', '-c', 'user.email=coverage@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'fixture'])
  fs.writeFileSync(path.join(root, 'source.js'), 'export function choose(value) { if (value) return 1; return 0 }\n')
  for (const [name, value, expected] of [['positive', true, 1], ['negative', false, 0]]) {
    fs.writeFileSync(path.join(root, `${name}.test.js`), `import { test, expect } from 'vitest'; import { choose } from './source.js'; test('${name}', () => expect(choose(${value})).toBe(${expected}));\n`)
  }
  const config = thresholds => `export default {test:{include:['*.test.js'], maxWorkers:1, coverage:{provider:'v8', include:['source.js'], reporter:['json-summary'], thresholds:${JSON.stringify(thresholds)}}}}\n`
  fs.writeFileSync(path.join(root, 'vitest.config.ts'), config({ lines: 100, branches: 100, functions: 100, statements: 100 }))
  fs.writeFileSync(path.join(root, 'vitest.shard.config.ts'), config(undefined))
  const output = path.join(root, 'reports')
  runCoverageShard('server', 1, 2, output, root)
  runCoverageShard('server', 2, 2, output, root)
  mergeCoverageShards('server', 2, output, root)
  const summary = JSON.parse(fs.readFileSync(path.join(root, 'coverage/coverage-summary.json'), 'utf8'))
  assert.equal(summary.total.branches.pct, 100)
  // Same passing tests, new uncovered production function: only the aggregate
  // has the complete coverage map and must now reject it.
  fs.appendFileSync(path.join(root, 'source.js'), 'export function uncovered() { return 42 }\n')
  runCoverageShard('server', 1, 2, output, root)
  runCoverageShard('server', 2, 2, output, root)
  assert.throws(() => mergeCoverageShards('server', 2, output, root), /Vitest failed/)
  const report = path.join(output, 'shard-1.blob.json')
  fs.appendFileSync(report, ' ')
  assert.throws(() => mergeCoverageShards('server', 2, output, root), /integrity mismatch/)
})
