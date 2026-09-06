import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { REQUIRED_FILES, validatePackageInventory } from './check-package.mjs'
import { SERVER_ASSETS, copyServerAssets } from './copy-server-assets.mjs'

const expected = { name: 'specrails-desktop', version: '2.40.0' }
function inventory() { return { ...expected, filename: 'specrails-desktop-2.40.0.tgz', integrity: 'sha512-YWJj', files: [...REQUIRED_FILES, 'client/dist/assets/index.js', 'docs/guide/en/README.md'].map(path => ({ path })) } }

test('requires distribution assets that checkout tests can accidentally obtain from source', () => {
  validatePackageInventory(inventory(), expected)
  for (const file of REQUIRED_FILES) {
    const info = inventory()
    info.files = info.files.filter(entry => entry.path !== file)
    assert.throws(() => validatePackageInventory(info, expected), /missing/)
  }
})
test('rejects a different version, unsafe paths, and accidentally shipped fixtures', () => {
  assert.throws(() => validatePackageInventory({ ...inventory(), version: '2.39.0' }, expected), /version/)
  for (const file of ['../secret', '/secret', 'server/__fixtures__/token.jsonl', '.env', 'server/dist/.env.production', 'docs/.env.local', 'client/dist/.env.secret', 'server/db.test.js']) {
    const info = inventory(); info.files.push({ path: file })
    assert.throws(() => validatePackageInventory(info, expected))
  }
})
test('copies runtime resources beside emitted modules and fails if a source resource is missing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'specrails-asset-test-'))
  try {
    for (const entry of SERVER_ASSETS) {
      const file = entry.endsWith('.json') ? entry : `${entry}/fixture.txt`
      fs.mkdirSync(path.dirname(path.join(root, 'server', file)), { recursive: true })
      fs.writeFileSync(path.join(root, 'server', file), file)
    }
    copyServerAssets(root)
    for (const entry of SERVER_ASSETS) {
      const file = entry.endsWith('.json') ? entry : `${entry}/fixture.txt`
      assert.equal(fs.readFileSync(path.join(root, 'server', 'dist', file), 'utf8'), file)
    }
    fs.rmSync(path.join(root, 'server', SERVER_ASSETS[0]), { recursive: true })
    assert.throws(() => copyServerAssets(root), /resource missing/)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
