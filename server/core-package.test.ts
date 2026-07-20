import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, it, expect } from 'vitest'
import { CORE_PACKAGE_SPEC } from './core-package'

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
)

interface BundleLock {
  packages?: Record<
    string,
    {
      dependencies?: Record<string, string>
      version?: string
    }
  >
}

function parseVersion(value: string): [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value)
  if (!match) throw new Error(`Expected an exact semantic version, got ${value}`)
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function isAtLeast(
  actual: [number, number, number],
  floor: [number, number, number],
): boolean {
  for (let index = 0; index < actual.length; index += 1) {
    if (actual[index]! > floor[index]!) return true
    if (actual[index]! < floor[index]!) return false
  }
  return true
}

describe('CORE_PACKAGE_SPEC (H5)', () => {
  it('pins specrails-core to a caret major range, never a floating tag', () => {
    // Guard against regressing to `specrails-core@latest`: a breaking core
    // major must never auto-land on users via npx.
    expect(CORE_PACKAGE_SPEC).toMatch(/^specrails-core@\^\d+\.\d+\.\d+$/)
  })

  it('keeps the online Core floor, release pin, and vendored lock compatible', () => {
    const lock = JSON.parse(
      readFileSync(
        path.join(repoRoot, 'scripts', 'assemble-bundled-core.lock.json'),
        'utf8',
      ),
    ) as BundleLock
    const declared =
      lock.packages?.['']?.dependencies?.['specrails-core']
    const resolved =
      lock.packages?.['node_modules/specrails-core']?.version
    const releaseWorkflow = readFileSync(
      path.join(repoRoot, '.github', 'workflows', 'desktop-release.yml'),
      'utf8',
    )
    const workflowVersion =
      /^\s*CORE_BUNDLE_VERSION:\s*"(\d+\.\d+\.\d+)"\s*$/m.exec(
        releaseWorkflow,
      )?.[1]
    const packageFloor =
      /^specrails-core@\^(\d+\.\d+\.\d+)$/.exec(CORE_PACKAGE_SPEC)?.[1]

    expect(declared).toBeDefined()
    expect(resolved).toBe(declared)
    expect(workflowVersion).toBe(declared)
    expect(packageFloor).toBeDefined()

    const bundled = parseVersion(declared!)
    const floor = parseVersion(packageFloor!)
    expect(bundled[0]).toBe(floor[0])
    expect(isAtLeast(bundled, floor)).toBe(true)
  })

  it('exercises every bundled provider in the Windows release smoke', () => {
    const smoke = readFileSync(
      path.join(repoRoot, 'scripts', 'smoke-bundled-core-windows.ps1'),
      'utf8',
    )
    const source =
      /\$providers\s*=\s*@\(([^)]+)\)/.exec(smoke)?.[1] ?? ''
    const providers = [...source.matchAll(/"([^"]+)"/g)].map(
      (match) => match[1],
    )

    expect(providers).toEqual(['claude', 'codex', 'gemini', 'kimi'])
  })
})
