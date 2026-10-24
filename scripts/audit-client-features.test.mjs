import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { README_BLOCK_BEGIN, README_BLOCK_END, readmeBlock, readmeIsCurrent, updateReadme } from './client-feature-readme.mjs'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
test('client capability public subpaths and dependencies match the reviewed manifest', () => {
  const result = spawnSync(process.execPath, ['scripts/audit-client-features.mjs', '--check'], { cwd: root, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr || result.stdout)
})

const entry = { publicEntries: ['components/Bridge.tsx'], dependencies: ['missions'] }
const manual = '## Mission extension slots\n\nHand-written guide that --write must keep.\n'

test('--write rewrites only the marked block and keeps hand-written sections byte for byte', () => {
  const before = `# flow\n\nIntro.\n\n${readmeBlock({ publicEntries: ['old.ts'], dependencies: [] })}\n\n${manual}\nRun the adjacent tests.\n`
  const after = updateReadme(before, 'flow', entry)
  assert.ok(after.includes('- [components/Bridge.tsx](components/Bridge.tsx)'))
  assert.ok(after.includes('- [missions](../missions/README.md)'))
  assert.ok(!after.includes('old.ts'))
  assert.ok(after.startsWith('# flow\n\nIntro.\n\n'))
  assert.ok(after.endsWith(`\n\n${manual}\nRun the adjacent tests.\n`))
  // Idempotent and reported current.
  assert.equal(updateReadme(after, 'flow', entry), after)
  assert.equal(readmeIsCurrent(after, 'flow', entry), true)
  assert.equal(readmeIsCurrent(before, 'flow', entry), false)
})

test('a legacy README without markers is converted once, keeping its manual sections', () => {
  const legacy = [
    '# flow', '', 'Intro.', '', '## Public subpaths', '', 'text', '', '- [old.ts](old.ts)', '', '## Feature dependencies', '',
    'No direct feature dependencies.', '', 'Dependencies record existing collaboration; they do not claim every feature is',
    'independent or that this is a hexagonal frontend. Pure models should not gain',
    'React, network or native-shell dependencies. Bind effects in hooks and adapters.', '', manual,
  ].join('\n')
  const after = updateReadme(legacy, 'flow', entry)
  assert.equal(after.split(README_BLOCK_BEGIN).length, 2)
  assert.equal(after.split(README_BLOCK_END).length, 2)
  assert.ok(after.includes(manual))
  assert.ok(!after.includes('old.ts'))
  assert.equal(readmeIsCurrent(legacy, 'flow', entry), false)
  assert.equal(readmeIsCurrent(after, 'flow', entry), true)
})

test('a missing README is created with the block; an unbalanced block is refused', () => {
  const created = updateReadme(null, 'newcap', entry)
  assert.ok(created.startsWith('# newcap\n'))
  assert.ok(created.includes(README_BLOCK_BEGIN) && created.includes(README_BLOCK_END))
  assert.throws(() => updateReadme(`# x\n\n${README_BLOCK_BEGIN}\nhalf\n`, 'x', entry), /unbalanced/)
  assert.equal(readmeIsCurrent(`# x\n\n${README_BLOCK_BEGIN}\n`, 'x', entry), false)
})
