import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
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
    'server/modules/project-settings/README.md', 'server/modules/execution/README.md',
    'server/modules/delivery/README.md', 'server/modules/conversations/README.md']) {
    const absolute = path.join(root, file)
    const content = fs.readFileSync(absolute, 'utf8')
    for (const [, target] of content.matchAll(/\]\(([^)]+)\)/g)) {
      if (target.includes('://') || target.startsWith('#')) continue
      const local = target.split('#')[0]
      assert.ok(fs.existsSync(path.resolve(path.dirname(absolute), local)), `${file}: broken reference ${target}`)
    }
  }
})

for (const [name, newline] of [['LF', '\n'], ['CRLF', '\r\n']]) {
  test(`source map check accepts ${name} checkouts but rejects changed source`, t => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'source-map-check-'))
    t.after(() => fs.rmSync(fixture, { recursive: true, force: true }))
    for (const dir of ['server', 'client/src', 'cli', 'local-runner/src', 'mcp-bridge/src', 'src-tauri/src', 'scripts', 'docs/internals']) {
      fs.mkdirSync(path.join(fixture, dir), { recursive: true })
    }
    const script = path.join(fixture, 'scripts/generate-source-map.mjs')
    fs.copyFileSync(path.join(root, 'scripts/generate-source-map.mjs'), script)
    fs.writeFileSync(path.join(fixture, 'server/example.ts'), 'export const example = true\n')
    const run = (...args) => spawnSync(process.execPath, [script, ...args], { cwd: fixture, encoding: 'utf8' })
    const generated = run()
    assert.equal(generated.status, 0, generated.stderr)
    const index = path.join(fixture, 'docs/internals/source-map.md')
    fs.writeFileSync(index, fs.readFileSync(index, 'utf8').replace(/\n/g, newline))
    const check = run('--check')
    assert.equal(check.status, 0, check.stderr)
    fs.writeFileSync(path.join(fixture, 'server/added.ts'), 'export const added = true\n')
    const stale = run('--check')
    assert.equal(stale.status, 1)
    assert.match(stale.stderr, /Source map is stale/)
  })
}
