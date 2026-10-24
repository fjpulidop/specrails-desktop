// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// DESIGN.md "Role Rule": pick a type role token (text-body, text-strong…), never a raw text-[Npx].
const RAW_SIZE = /text-\[\d+(\.\d+)?px\]/
const ROOT = join(__dirname, '..')

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) {
      if (name === 'node_modules' || name === '__tests__' || name === 'fixtures') continue
      walk(p, out)
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p)
  }
  return out
}

describe('type role tokens', () => {
  it('has no raw text-[Npx] sizes in client source', () => {
    const offenders = walk(ROOT).filter((f) => RAW_SIZE.test(readFileSync(f, 'utf8')))
    expect(offenders.map((f) => f.slice(ROOT.length + 1))).toEqual([])
  })
})
