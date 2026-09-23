import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
test('source navigation index matches the current source tree', () => {
  const result = spawnSync(process.execPath, ['scripts/generate-source-map.mjs', '--check'], { cwd: root, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr || result.stdout)
})
test('shared agent guides and modular architecture references resolve', () => {
  for (const file of ['AGENTS.md', 'CLAUDE.md', 'docs/internals/source-map.md',
    'docs/internals/modular-architecture.md', 'docs/internals/source-architecture.md',
    'server/modules/project-settings/README.md']) {
    const absolute = path.join(root, file)
    const content = fs.readFileSync(absolute, 'utf8')
    for (const [, target] of content.matchAll(/\]\(([^)]+)\)/g)) {
      if (target.includes('://') || target.startsWith('#')) continue
      const local = target.split('#')[0]
      assert.ok(fs.existsSync(path.resolve(path.dirname(absolute), local)), `${file}: broken reference ${target}`)
    }
  }
})
