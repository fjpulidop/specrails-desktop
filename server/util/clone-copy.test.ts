import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { CLONE_MIN_FILE_BYTES, cloneCopySync } from './clone-copy'

let tmp: string
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-clone-')) })
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

describe('cloneCopySync', () => {
  it('copies small files without spawning and keeps the bytes', () => {
    const src = path.join(tmp, 'small.json')
    fs.writeFileSync(src, '{"a":1}')
    expect(cloneCopySync(src, path.join(tmp, 'out.json'))).toBe('copied')
    expect(fs.readFileSync(path.join(tmp, 'out.json'), 'utf8')).toBe('{"a":1}')
  })

  it.runIf(process.platform === 'darwin')('clones large files and directories on macOS (byte-identical)', () => {
    const big = path.join(tmp, 'big.bin')
    fs.writeFileSync(big, Buffer.alloc(CLONE_MIN_FILE_BYTES + 1, 7))
    expect(cloneCopySync(big, path.join(tmp, 'big.copy'))).toBe('cloned')
    expect(fs.readFileSync(path.join(tmp, 'big.copy')).equals(fs.readFileSync(big))).toBe(true)
    const dir = path.join(tmp, 'dir')
    fs.mkdirSync(path.join(dir, 'nested'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'nested', 'a.txt'), 'a')
    fs.symlinkSync(path.join(dir, 'nested', 'a.txt'), path.join(dir, 'link.txt'))
    expect(cloneCopySync(dir, path.join(tmp, 'dir.copy'), { dereference: true })).toBe('cloned')
    expect(fs.readFileSync(path.join(tmp, 'dir.copy', 'nested', 'a.txt'), 'utf8')).toBe('a')
    expect(fs.lstatSync(path.join(tmp, 'dir.copy', 'link.txt')).isSymbolicLink()).toBe(false)
  })

  it('falls back to a normal copy on other platforms', () => {
    const dir = path.join(tmp, 'dir')
    fs.mkdirSync(dir)
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a')
    expect(cloneCopySync(dir, path.join(tmp, 'dir.copy'), { platform: 'linux' })).toBe('copied')
    expect(fs.readFileSync(path.join(tmp, 'dir.copy', 'a.txt'), 'utf8')).toBe('a')
  })

  it('refuses an existing destination', () => {
    const src = path.join(tmp, 'a')
    fs.writeFileSync(src, 'a')
    fs.writeFileSync(path.join(tmp, 'b'), 'b')
    expect(() => cloneCopySync(src, path.join(tmp, 'b'))).toThrow(/destination exists/)
    expect(fs.readFileSync(path.join(tmp, 'b'), 'utf8')).toBe('b')
  })
})
