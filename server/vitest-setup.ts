import { mkdtempSync } from 'fs'
import os from 'os'
import path from 'path'
import type { Server } from 'node:http'
import request from 'supertest'

// Supertest starts fixtures on the default (usually IPv6) wildcard socket but
// builds an IPv4 URL. On hosts with separate port namespaces that URL can reach
// an unrelated local service. Connect to the family actually owned by the fixture.
// Keep Supertest responsible for starting and closing its ephemeral servers.
const transportMarker = Symbol.for('specrails.supertest.address-family')
const testPrototype = request.Test.prototype as unknown as {
  serverAddress(server: Server, path: string): string
  [transportMarker]?: boolean
}
if (!testPrototype[transportMarker]) {
  const serverAddress = testPrototype.serverAddress
  testPrototype.serverAddress = function (server, requestPath) {
    const original = serverAddress.call(this, server, requestPath)
    const address = server.address()
    if (address && typeof address !== 'string' && address.family === 'IPv6'
      && (address.address === '::' || address.address === '::1')) {
      const url = new URL(original)
      url.hostname = '[::1]'
      return url.toString()
    }
    return original
  }
  testPrototype[transportMarker] = true
}

/**
 * Hermetic env: a test run must NEVER inherit Specrails host configuration.
 *
 * When the suite runs as a rail's host verification, the command inherits the
 * running Desktop's environment: `SPECRAILS_CORE_RUNTIME_PATH`, `SPECRAILS_PORT`,
 * `SPECRAILS_HOST_CONTROL_TOKEN`, `SPECRAILS_REGISTRY_HOME=$HOME` and others.
 * Core keeps `SPECRAILS_*` in verification on purpose (a checked application may
 * read them), so this suite strips them itself. An allowlist of variables to
 * delete went stale whenever the host added one (40 failures in core-compat,
 * setup-manager, desktop-router and agent-runtime-bridge while the same suite
 * passed in a plain shell), so every `SPECRAILS_*` is removed except the
 * paired-Core source paths CI passes deliberately. `SPECRAILS_CORE_BIN` is
 * removed too: CI's copy serves `scripts/check-core-compat.ts` outside vitest,
 * and paired tests derive their own from `SPECRAILS_CORE_SOURCE_DIR`. Tests that
 * need a variable set it per-case in `beforeEach`, which runs after this file.
 */
const TEST_INPUTS = new Set(['SPECRAILS_CORE_SOURCE_DIR', 'SPECRAILS_EFFICIENCY_CORE_ROOT'])
for (const key of Object.keys(process.env)) {
  if (key.startsWith('SPECRAILS_') && !TEST_INPUTS.has(key)) delete process.env[key]
}

/**
 * Test safety net: NEVER let a test write the relocation registry into the
 * developer's real `$HOME/.specrails/registry.json`. `ProjectRegistry` resolves
 * the registry from `SPECRAILS_REGISTRY_HOME`, falling back to `os.homedir()`,
 * so it always points at a throwaway tmp dir here (an inherited value is the
 * host's real home). Tests that need a specific home override it per-test.
 */
process.env.SPECRAILS_REGISTRY_HOME = mkdtempSync(path.join(os.tmpdir(), 'specrails-desktop-test-home-'))
