import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
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
  it('uses the absolute PATH Node under pkg, never a bare `node` that pkg rewrites to the server binary', () => {
    processWithPkg.pkg = { entrypoint: '/snapshot/server/index.js' }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pkg-node-'))
    const node = path.join(dir, process.platform === 'win32' ? 'node.exe' : 'node')
    fs.writeFileSync(node, '', { mode: 0o755 })
    try {
      const env = { PATH: ['/definitely/missing', dir].join(process.platform === 'win32' ? ';' : ':') }
      expect(resolveCoreNodeRuntime(env)).toBe(node)
      expect(path.isAbsolute(resolveCoreNodeRuntime(env))).toBe(true)
      expect(resolveCoreNodeRuntime(env)).not.toBe(process.execPath)
      // No Node on PATH at all: the bare name is the last resort.
      expect(resolveCoreNodeRuntime({ PATH: '/definitely/missing' })).toBe('node')
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
  it.each(['/Applications/Specrails/runtimes/node/bin/node', 'C:\\Program Files\\Specrails\\runtimes\\node\\node.exe'])('prefers the available bundled Node executable %s', (bundled) => {
    fixture.bundled = bundled
    expect(resolveCoreNodeRuntime()).toBe(bundled)
    processWithPkg.pkg = { entrypoint: 'server/index.js' }
    expect(resolveCoreNodeRuntime()).toBe(bundled)
  })
})
