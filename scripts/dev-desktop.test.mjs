import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEV_CLIENT_PORT, DEV_SERVER_PORT, devDesktopConfig, devDesktopPorts } from './dev-desktop.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const baseConfig = JSON.parse(fs.readFileSync(path.join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'))

test('development ports default away from the installed app and honour overrides', () => {
  assert.deepEqual(devDesktopPorts({}), { server: DEV_SERVER_PORT, client: DEV_CLIENT_PORT })
  assert.deepEqual(devDesktopPorts({ SPECRAILS_DEV_SERVER_PORT: '4400', SPECRAILS_DEV_CLIENT_PORT: '4401' }), { server: 4400, client: 4401 })
  assert.throws(() => devDesktopPorts({ SPECRAILS_DEV_SERVER_PORT: '4200' }), /installed Specrails/)
  assert.throws(() => devDesktopPorts({ SPECRAILS_DEV_SERVER_PORT: '4401', SPECRAILS_DEV_CLIENT_PORT: '4401' }), /must differ/)
  assert.throws(() => devDesktopPorts({ SPECRAILS_DEV_CLIENT_PORT: 'abc' }), /TCP port/)
})

test('the overlay is a separate app whose CSP allows only the development server port', () => {
  const overlay = devDesktopConfig(baseConfig, { server: 4300, client: 4301 })
  assert.equal(overlay.identifier, `${baseConfig.identifier}.dev`)
  assert.notEqual(overlay.identifier, baseConfig.identifier)
  assert.equal(overlay.productName, 'Specrails Dev')
  assert.equal(overlay.build.devUrl, 'http://localhost:4301')
  assert.match(overlay.app.security.csp, /http:\/\/127\.0\.0\.1:4300/)
  assert.match(overlay.app.security.csp, /ws:\/\/127\.0\.0\.1:4300/)
  assert.doesNotMatch(overlay.app.security.csp, /:4200/)
})

test('the overlay swaps every app icon for its DEV-marked counterpart, and each exists', () => {
  const overlay = devDesktopConfig(baseConfig, { server: 4300, client: 4301 })
  assert.equal(overlay.bundle.icon.length, baseConfig.bundle.icon.length)
  for (const icon of overlay.bundle.icon) {
    assert.match(icon, /^icons\/dev\//)
    assert.ok(fs.existsSync(path.join(root, 'src-tauri', icon)), `${icon} is missing; run npm run generate-icons`)
  }
})

// The Rust debug profile (src-tauri/src/host_profile.rs) falls back to the same
// server port when `tauri dev` runs without this launcher.
test('the launcher and the debug host profile agree on the default server port', () => {
  const rust = fs.readFileSync(path.join(root, 'src-tauri', 'src', 'host_profile.rs'), 'utf8')
  assert.match(rust, new RegExp(`pub const DEV_SERVER_PORT: u16 = ${DEV_SERVER_PORT};`))
})
