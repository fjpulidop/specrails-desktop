import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveCoreNodeRuntime } from './core-node-runtime'

const fixture = vi.hoisted(() => ({ bundled: null as string | null }))
vi.mock('./path-resolver', () => ({ resolveBundledNodeExe: () => fixture.bundled }))
const processWithPkg = process as NodeJS.Process & { pkg?: unknown }
let previous: PropertyDescriptor | undefined
beforeEach(() => { fixture.bundled = null; previous = Object.getOwnPropertyDescriptor(process, 'pkg'); delete processWithPkg.pkg })
afterEach(() => {
  if (previous) Object.defineProperty(process, 'pkg', previous)
  else delete processWithPkg.pkg
})

describe('resolveCoreNodeRuntime', () => {
  it('keeps the current executable when running under ordinary Node', () => {
    expect(resolveCoreNodeRuntime()).toBe(process.execPath)
  })
  it('uses PATH Node instead of relaunching a pkg server when bundled Node is missing', () => {
    processWithPkg.pkg = { entrypoint: '/snapshot/server/index.js' }
    expect(resolveCoreNodeRuntime()).toBe('node')
    expect(resolveCoreNodeRuntime()).not.toBe(process.execPath)
  })
  it.each(['/Applications/Specrails/runtimes/node/bin/node', 'C:\\Program Files\\Specrails\\runtimes\\node\\node.exe'])('prefers the available bundled Node executable %s', (bundled) => {
    fixture.bundled = bundled
    expect(resolveCoreNodeRuntime()).toBe(bundled)
    processWithPkg.pkg = { entrypoint: 'server/index.js' }
    expect(resolveCoreNodeRuntime()).toBe(bundled)
  })
})
