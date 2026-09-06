import { test } from 'node:test'
import assert from 'node:assert/strict'
import { patchNodePtySource } from './patch-node-pty.mjs'

const original = 'int flags = POSIX_SPAWN_CLOEXEC_DEFAULT |'
const patched = 'int flags = 0 | /* pkg-patch: removed POSIX_SPAWN_CLOEXEC_DEFAULT — see scripts/patch-node-pty.mjs */'
const fixture = statement => `#ifdef __APPLE__\n  ${statement}\n    POSIX_SPAWN_SETSIGDEF | POSIX_SPAWN_SETSIGMASK;\n#endif\n`

test('patches the known statement while preserving other flags and surrounding source', () => {
  assert.deepEqual(patchNodePtySource(fixture(original)), { source: fixture(patched), changed: true })
})

test('recognizes its exact patch despite the flag name in the comment', () => {
  const once = patchNodePtySource(fixture(original))
  assert.match(once.source, /POSIX_SPAWN_CLOEXEC_DEFAULT/)
  assert.deepEqual(patchNodePtySource(once.source), { source: once.source, changed: false })
})

test('preserves CRLF bytes on first and repeated applications', () => {
  const input = fixture(original).replaceAll('\n', '\r\n')
  const result = patchNodePtySource(input)
  assert.equal(result.source, fixture(patched).replaceAll('\n', '\r\n'))
  assert.equal(patchNodePtySource(result.source).changed, false)
})

test('rejects an unknown flags layout rather than treating its marker as patched', () => {
  assert.throws(() => patchNodePtySource(fixture('auto flags = POSIX_SPAWN_CLOEXEC_DEFAULT |')), /Unexpected node-pty source layout/)
  assert.throws(() => patchNodePtySource(fixture('int flags = 0 | /* another patch */')), /Unexpected node-pty source layout/)
})

test('rejects duplicate or partially patched statements rather than applying an incomplete patch', () => {
  assert.throws(() => patchNodePtySource(fixture(original) + fixture(original)), /exactly one/)
  assert.throws(() => patchNodePtySource(fixture(patched) + fixture(original)), /exactly one/)
  assert.throws(() => patchNodePtySource(fixture(patched) + fixture(patched)), /exactly one/)
})
