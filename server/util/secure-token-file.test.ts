import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { readPrivateTextFile, writePrivateTextFile } from './secure-token-file'

const roots: string[] = []

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'specrails-token-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe.runIf(process.platform !== 'win32')('secure token files', () => {
  it('tightens an existing credential to 0600 before reading it', () => {
    const file = path.join(tempRoot(), 'desktop.token')
    fs.writeFileSync(file, 'secret', { mode: 0o644 })

    expect(readPrivateTextFile(file)).toBe('secret')
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
  })

  it('refuses to read through a symlink', () => {
    const root = tempRoot()
    const target = path.join(root, 'target')
    const link = path.join(root, 'mcp.token')
    fs.writeFileSync(target, 'stolen')
    fs.symlinkSync(target, link)

    expect(() => readPrivateTextFile(link)).toThrow()
  })

  it('atomically replaces a hostile symlink without changing its target', () => {
    const root = tempRoot()
    const target = path.join(root, 'target')
    const link = path.join(root, 'desktop.token')
    fs.writeFileSync(target, 'keep-me')
    fs.symlinkSync(target, link)

    writePrivateTextFile(link, 'new-secret')

    expect(fs.readFileSync(target, 'utf8')).toBe('keep-me')
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(false)
    expect(fs.readFileSync(link, 'utf8')).toBe('new-secret')
    expect(fs.statSync(link).mode & 0o777).toBe(0o600)
    expect(fs.statSync(root).mode & 0o777).toBe(0o700)
  })
})
