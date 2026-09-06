import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function candidate(options = {}) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'specrails-core-sync-'))
  try {
    const root = path.join(temporary, 'candidate')
    const marker = path.join(temporary, 'executed')
    const output = path.join(temporary, 'github-output')
    fs.mkdirSync(path.join(root, 'dist', 'installer'), { recursive: true })
    fs.mkdirSync(path.join(root, 'bin'), { recursive: true })
    const version = options.packageVersion ?? '5.0.0'
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'specrails-core', version, bin: { 'specrails-core': 'bin/specrails-core.mjs' } }))
    // Neither package entrypoint is needed to read its contract. These fixtures
    // fail visibly if candidate code is accidentally executed by the checker.
    const code = `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'executed'); throw new Error('Candidate CLI must not execute');`
    fs.writeFileSync(path.join(root, 'bin', 'specrails-core.mjs'), code)
    fs.writeFileSync(path.join(root, 'dist', 'installer', 'cli.js'), code)
    if (!options.missingContract) fs.writeFileSync(path.join(root, 'integration-contract.json'), JSON.stringify({
      schemaVersion: '4.0', coreVersion: version,
      lifecycle: { mode: 'deterministic', requiresEnrich: false },
      checkpoints: options.drift ? { future_phase: 'Unimplemented Desktop phase' } : {},
    }))
    const env = { ...process.env, HOME: temporary, USERPROFILE: temporary,
      SPECRAILS_REGISTRY_HOME: temporary, CORE_VERSION: options.requestedVersion ?? version,
      CORE_PACKAGE_ROOT: root, GITHUB_OUTPUT: output }
    delete env.SPECRAILS_CORE_BIN
    delete env.SPECRAILS_EXECUTION_CONTEXT
    delete env.SPECRAILS_PIPELINE_RUNTIME
    let result
    try { result = { ...(await execute(process.execPath, ['--import', 'tsx', 'scripts/check-core-sync.mjs'], { cwd: workspace, env, timeout: 15_000 })), code: 0 } }
    catch (error) { result = error }
    assert.equal(fs.existsSync(marker), false, 'Contract checking must not execute candidate package code')
    const values = Object.fromEntries(fs.readFileSync(output, 'utf8').trim().split('\n').map(line => line.split('=')))
    return { code: result.code, stdout: result.stdout, stderr: result.stderr, drift: values.drift }
  } finally { fs.rmSync(temporary, { recursive: true, force: true }) }
}

test('Core dispatch compares the explicit package contract without executing its CLI', async () => {
  const result = await candidate()
  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.drift, 'false')
  assert.equal(JSON.parse(result.stdout).coreVersion, '5.0.0')
  assert.equal(JSON.parse(result.stdout).contractFound, true)
})

test('only a measured contract mismatch produces a compatibility issue signal', async () => {
  const result = await candidate({ drift: true })
  assert.equal(result.code, 1)
  assert.equal(result.drift, 'true')
  assert.deepEqual(JSON.parse(result.stdout).missingCheckpoints, ['future_phase'])
  const future = await candidate({ packageVersion: '6.0.0' })
  assert.equal(future.code, 1)
  assert.equal(future.drift, 'true')
  assert.equal(JSON.parse(future.stdout).unsupportedMajor, true)
})

test('missing contracts, wrong installed versions and invalid payloads cannot masquerade as drift or compatibility', async () => {
  for (const options of [{ missingContract: true }, { requestedVersion: '5.0.1' }, { requestedVersion: '5.0.0; echo invalid' }]) {
    const result = await candidate(options)
    assert.equal(result.code, 1)
    assert.equal(result.drift, 'false')
    assert.match(result.stderr, /\[core-sync\]/)
  }
})
