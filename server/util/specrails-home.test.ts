import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveSpecrailsHome } from './specrails-home'

const saved = process.env.SPECRAILS_REGISTRY_HOME
afterEach(() => {
  if (saved === undefined) delete process.env.SPECRAILS_REGISTRY_HOME
  else process.env.SPECRAILS_REGISTRY_HOME = saved
})

describe('resolveSpecrailsHome', () => {
  it('prefers an explicit home, then SPECRAILS_REGISTRY_HOME, then the user home', () => {
    process.env.SPECRAILS_REGISTRY_HOME = '/tmp/specrails-dev-home'
    expect(resolveSpecrailsHome('/explicit')).toBe('/explicit')
    expect(resolveSpecrailsHome()).toBe('/tmp/specrails-dev-home')
    delete process.env.SPECRAILS_REGISTRY_HOME
    expect(resolveSpecrailsHome()).toBe(os.homedir())
  })

  // The development desktop profile sets SPECRAILS_REGISTRY_HOME so it never
  // shares the installed app's data. A `.specrails` path built on homedir()
  // would bypass that and write into the installed app's databases.
  it('is the only way server and CLI code reach the per-user .specrails directory', () => {
    const repo = path.resolve(__dirname, '..', '..')
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(full); continue }
        if (!/\.ts$/.test(entry.name) || /\.test\.ts$/.test(entry.name)) continue
        fs.readFileSync(full, 'utf8').split('\n').forEach((line, index) => {
          if (/homedir\(\)/.test(line) && /['"]\.specrails['"]/.test(line)) offenders.push(`${path.relative(repo, full)}:${index + 1}`)
        })
      }
    }
    walk(path.join(repo, 'server'))
    walk(path.join(repo, 'cli'))
    expect(offenders).toEqual([])
  })
})
