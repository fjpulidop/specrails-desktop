#!/usr/bin/env tsx
/**
 * scripts/check-core-compat.ts
 *
 * Validates that the integration contract from specrails-core matches the
 * hardcoded constants in specrails-desktop (CHECKPOINTS + KNOWN_VERBS).
 *
 * Exit 0 — compatible, or contract not found (treated as a no-op)
 * Exit 1 — contract found but mismatch detected
 *
 * Usage:
 *   npx tsx scripts/check-core-compat.ts
 *   npm run check-core-compat
 */

import { checkCoreCompat } from '../server/core-compat'

async function main(): Promise<void> {
  const result = await checkCoreCompat()

  if (!result.contractFound) {
    console.log('[check-core-compat] specrails-core not installed — skipping compat check')
    process.exit(0)
  }

  console.log(
    `[check-core-compat] specrails-core@${result.coreVersion} vs specrails-desktop@${result.desktopVersion}`
  )

  let hasErrors = false

  if (result.missingCheckpoints.length > 0) {
    console.error(
      `  ✗ Checkpoints in Core but missing in Desktop: ${result.missingCheckpoints.join(', ')}`
    )
    hasErrors = true
  }
  if (result.extraCheckpoints.length > 0) {
    console.error(
      `  ✗ Checkpoints in Desktop but not in Core: ${result.extraCheckpoints.join(', ')}`
    )
    hasErrors = true
  }
  if (result.missingCommands.length > 0) {
    console.error(
      `  ✗ Commands in Core but missing in Desktop (KNOWN_VERBS): ${result.missingCommands.join(', ')}`
    )
    hasErrors = true
  }
  if (result.extraCommands.length > 0) {
    console.error(
      `  ✗ Commands in Desktop (KNOWN_VERBS) but not in Core: ${result.extraCommands.join(', ')}`
    )
    hasErrors = true
  }

  if (hasErrors) {
    // Keep the historical schema-3 checkpoint rename tolerance for older Core.
    // Schema 4 describes the supported deterministic lifecycle and must match;
    // a mismatch there is a real integration regression, not a warning.
    const schemaMajor = Number.parseInt(String(result.contractSchemaVersion ?? '0').split('.')[0], 10)
    if (schemaMajor === 3) {
      console.warn(
        '[check-core-compat] ⚠ Contract mismatch on schemaVersion '
          + `${result.contractSchemaVersion ?? '?'} — treated as a warning. Update desktop constants to match specrails-core.`
      )
      process.exit(0)
    }
    console.error(
      '[check-core-compat] ✗ Contract mismatch — update desktop constants to match specrails-core'
    )
    process.exit(1)
  }

  console.log('[check-core-compat] ✓ Compatible')
  process.exit(0)
}

main().catch((err: unknown) => {
  console.error('[check-core-compat] fatal error:', (err as Error).message ?? String(err))
  process.exit(1)
})
