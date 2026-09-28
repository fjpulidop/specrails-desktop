import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { withRuntimePackageLock } from './agent-runtime-package-lock'

const DIGEST = /^[a-f0-9]{64}$/
const STAGED = /^\.staged-[a-f0-9-]{36}$/
const GARBAGE = /^\.garbage-[a-f0-9]{64}-[a-f0-9-]{36}$/
/** Collects only expired, unreferenced package directories. Every run pin is
 * inspected before the first mutation; an unknown pin protects the whole cache.
 * Callers must use the same package lock when publishing new retained pins. */
export function collectUnreferencedRuntimePackages(pipelineRoot: string, options: { dryRun: boolean; minimumAgeMs: number; now: number }): string[] {
  if (!Number.isSafeInteger(options.minimumAgeMs) || options.minimumAgeMs < 86_400_000 || !Number.isFinite(options.now)) throw new Error('Package retention requires an age of at least one day and a valid clock')
  if (!fs.existsSync(pipelineRoot)) return []
  if (fs.lstatSync(pipelineRoot).isSymbolicLink() || !fs.statSync(pipelineRoot).isDirectory()) throw new Error('Pipeline storage must be a real directory')
  const cache = path.join(pipelineRoot, 'runtime-packages')
  if (!fs.existsSync(cache)) return []
  return withRuntimePackageLock(cache, () => {
    const referenced = new Set<string>()
    for (const entry of fs.readdirSync(pipelineRoot, { withFileTypes: true })) {
      if (entry.name === 'runtime-packages') continue
      if (entry.isSymbolicLink()) throw new Error('Cannot collect packages across an unknown pipeline link')
      if (!entry.isDirectory()) continue
      const directory = path.join(pipelineRoot, entry.name)
      if (entry.name === '.retention') {
        if (fs.readdirSync(directory).length) throw new Error('Runtime quarantine must be recovered before package collection')
        continue
      }
      const pinFile = path.join(directory, 'desktop-runtime-package.json')
      if (!fs.existsSync(pinFile)) {
        if (fs.existsSync(path.join(directory, 'agent-runtime-request.json'))) throw new Error('A saved execution has no proven original package pin')
        continue
      }
      const stat = fs.lstatSync(pinFile)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16_384) throw new Error('Invalid runtime package pin')
      const pin = JSON.parse(fs.readFileSync(pinFile, 'utf8'))
      if (pin.schemaVersion !== 1 || typeof pin.integrity !== 'string' || !DIGEST.test(pin.integrity) ||
        pin.root !== path.join(cache, pin.integrity) || typeof pin.cli !== 'string' || !pin.cli || path.isAbsolute(pin.cli) || pin.cli.split(/[\\/]/).includes('..')) throw new Error('Runtime package pin scope is invalid')
      referenced.add(pin.integrity)
    }
    const eligible: string[] = []
    for (const entry of fs.readdirSync(cache, { withFileTypes: true })) {
      if (!DIGEST.test(entry.name) && !GARBAGE.test(entry.name) && !STAGED.test(entry.name)) continue
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Runtime package storage contains an invalid entry')
      if (referenced.has(entry.name)) continue
      const stat = fs.statSync(path.join(cache, entry.name))
      if (stat.mtimeMs > options.now || options.now - stat.mtimeMs < options.minimumAgeMs) continue
      eligible.push(entry.name)
    }
    for (const name of options.dryRun ? [] : eligible) {
      const original = path.join(cache, name)
      // A crashed deletion cannot leave a partially deleted digest available to
      // a future publisher. The private garbage name is safe to retry later.
      const garbage = GARBAGE.test(name) || STAGED.test(name) ? original : path.join(cache, `.garbage-${name}-${randomUUID()}`)
      if (garbage !== original) fs.renameSync(original, garbage)
      fs.rmSync(garbage, { recursive: true })
    }
    return eligible.sort()
  })
}
