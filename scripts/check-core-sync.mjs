#!/usr/bin/env node
/** Compare an explicitly installed dispatch candidate; never fall back to another Core. */
import fs from 'node:fs'
import path from 'node:path'
import { stableVersion } from './release-policy.mjs'
function output(name, value) { if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`) }
output('drift', 'false')
try {
  const expected = stableVersion(process.env.CORE_VERSION)
  const root = fs.realpathSync(process.env.CORE_PACKAGE_ROOT)
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  if (pkg.name !== 'specrails-core' || pkg.version !== expected) throw new Error('The installed Core package does not match the dispatched version.')
  const contract = JSON.parse(fs.readFileSync(path.join(root, 'integration-contract.json'), 'utf8'))
  if (!contract || typeof contract !== 'object' || typeof contract.schemaVersion !== 'string' || !contract.checkpoints || typeof contract.checkpoints !== 'object') throw new Error('The dispatched package has no valid integration contract.')
  const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.['specrails-core']
  if (typeof bin !== 'string') throw new Error('The dispatched package does not expose its expected CLI entry.')
  const entry = fs.realpathSync(path.resolve(root, bin))
  if (!entry.startsWith(`${root}${path.sep}`)) throw new Error('The Core CLI entry escapes its installed package.')
  process.env.SPECRAILS_CORE_BIN = entry
  let result
  if (![4, 5].includes(Number(expected.split('.')[0]))) result = { compatible: false, coreVersion: expected, unsupportedMajor: true }
  else {
    const { checkCoreCompat } = await import('../server/core-compat.ts')
    result = await checkCoreCompat()
    if (!result.contractFound || result.coreVersion !== expected) throw new Error('The requested Core contract was not selected; refusing a false compatibility success.')
  }
  const drift = !result.compatible
  output('drift', String(drift))
  console.log(JSON.stringify(result, null, 2))
  if (drift) { console.error('The dispatched Core contract differs from this Desktop.'); process.exitCode = 1 }
} catch (error) {
  // Invalid input, missing packages, registry errors and broken setup are not
  // evidence of contract drift and must not generate misleading issues.
  console.error(`[core-sync] ${error.message}`)
  process.exitCode = 1
}
