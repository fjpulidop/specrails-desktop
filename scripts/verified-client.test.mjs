import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { verifyClientArtifact } from './verified-client.mjs'

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'verified-client-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'dist/assets'), { recursive: true })
  const files = [['assets/app.js', 'console.log(1)'], ['index.html', '<div>App</div>']].map(([name, value]) => {
    fs.writeFileSync(path.join(root, 'dist', name), value)
    return { path: name, bytes: Buffer.byteLength(value), sha256: createHash('sha256').update(value).digest('hex') }
  })
  const expected = { commit: 'a'.repeat(40), lockHash: 'b'.repeat(64) }, receipt = { schemaVersion: 1, ...expected, files }
  fs.writeFileSync(path.join(root, 'receipt.json'), JSON.stringify(receipt))
  return { root, expected, receipt }
}
test('portable frontend reuse accepts exact source, dependency lock and complete bytes', t => {
  const { root, expected, receipt } = fixture(t)
  assert.deepEqual(verifyClientArtifact(root, expected), receipt)
})
test('tampered, stale, missing and extra frontend assets fail before restore', t => {
  for (const mutate of [
    ({ expected }) => { expected.commit = 'c'.repeat(40) },
    ({ expected }) => { expected.lockHash = 'c'.repeat(64) },
    ({ root }) => fs.writeFileSync(path.join(root, 'dist/assets/app.js'), 'different'),
    ({ root }) => fs.rmSync(path.join(root, 'dist/index.html')),
    ({ root }) => fs.writeFileSync(path.join(root, 'dist/extra'), 'unexpected'),
    ({ root, receipt }) => { receipt.schemaVersion = 2; fs.writeFileSync(path.join(root, 'receipt.json'), JSON.stringify(receipt)) },
  ]) {
    const data = fixture(t); mutate(data)
    assert.throws(() => verifyClientArtifact(data.root, data.expected))
  }
})
