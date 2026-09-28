import { afterEach, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import Database from 'better-sqlite3'
import { withRuntimePackageLock } from './agent-runtime-package-lock'
const roots: string[] = []
function cache() { const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'runtime cache lock '))); roots.push(root); return path.join(root, 'packages') }
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
it('excludes a competing connection and releases on callback failure', () => {
  const root = cache()
  expect(() => withRuntimePackageLock(root, () => {
    const other = new Database(path.join(root, '.maintenance.sqlite'), { timeout: 0 })
    try { expect(() => other.exec('BEGIN IMMEDIATE')).toThrow('locked') } finally { other.close() }
    throw Error('Interrupted collection')
  })).toThrow('Interrupted collection')
  expect(withRuntimePackageLock(root, () => 'next owner')).toBe('next owner')
})
it('does not execute collection while another publisher holds the reservation', () => {
  const root = cache(); withRuntimePackageLock(root, () => undefined)
  const publisher = new Database(path.join(root, '.maintenance.sqlite'), { timeout: 0 }); publisher.exec('BEGIN IMMEDIATE')
  let invoked = false
  try { expect(() => withRuntimePackageLock(root, () => { invoked = true })).toThrow('locked') }
  finally { publisher.exec('ROLLBACK'); publisher.close() }
  expect(invoked).toBe(false)
  expect(withRuntimePackageLock(root, () => 42)).toBe(42)
})
it('rejects an aliased cache before opening a database outside its scope', () => {
  const root = cache(), target = path.join(path.dirname(root), 'other'); fs.mkdirSync(target)
  fs.symlinkSync(target, root, process.platform === 'win32' ? 'junction' : 'dir')
  expect(() => withRuntimePackageLock(root, () => undefined)).toThrow('real directory')
  expect(fs.readdirSync(target)).toEqual([])
})
it('rejects a non-file maintenance lock without invoking collection', () => {
  const root = cache(); fs.mkdirSync(path.join(root, '.maintenance.sqlite'), { recursive: true })
  expect(() => withRuntimePackageLock(root, () => undefined)).toThrow('invalid')
})
