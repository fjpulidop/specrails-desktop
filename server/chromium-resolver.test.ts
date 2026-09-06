import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn, spawnSync } from 'child_process'

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  return { ...actual, spawn: vi.fn(actual.spawn) }
})
import {
  discoverChromiumExecutable,
  resolveBundledChromiumPath,
  resolveBundledChromiumExecutable,
} from './chromium-resolver'

describe('chromium-resolver', () => {
  const savedDesktop = process.env.SPECRAILS_IS_DESKTOP
  const savedRuntimes = process.env.SPECRAILS_BUNDLED_RUNTIMES_PATH
  const savedCache = process.env.SPECRAILS_CHROMIUM_CACHE_DIR
  const savedCopyfile = process.env.COPYFILE_DISABLE
  const savedCopyAttributes = process.env.COPY_EXTENDED_ATTRIBUTES_DISABLE
  let tmp: string

  // Build a fake Playwright-style chromium tree for the current platform and
  // return the expected executable path.
  function makeChromiumTree(root: string): string {
    fs.mkdirSync(root, { recursive: true })
    if (process.platform === 'win32') {
      const dir = path.join(root, 'chrome-win')
      fs.mkdirSync(dir, { recursive: true })
      const exe = path.join(dir, 'chrome.exe')
      fs.writeFileSync(exe, 'x')
      return exe
    }
    if (process.platform === 'darwin') {
      const macos = path.join(root, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS')
      fs.mkdirSync(macos, { recursive: true })
      const exe = path.join(macos, 'Google Chrome for Testing')
      fs.writeFileSync(exe, 'x')
      return exe
    }
    const dir = path.join(root, 'chrome-linux')
    fs.mkdirSync(dir, { recursive: true })
    const exe = path.join(dir, 'chrome')
    fs.writeFileSync(exe, 'x')
    return exe
  }

  // The single platform folder name inside makeChromiumTree (chrome-mac-arm64 / …).
  function platformFolder(): string {
    if (process.platform === 'win32') return 'chrome-win'
    if (process.platform === 'darwin') return 'chrome-mac-arm64'
    return 'chrome-linux'
  }

  // Pack a fake chromium tree into <runtimes>/chromium/chromium.tar.gz using system tar.
  function makeArchive(runtimesPath: string, contents = 'x', name = 'chromium.tar.gz'): string {
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'chromium-stage-'))
    fs.writeFileSync(makeChromiumTree(staging), contents)
    const chromiumDir = path.join(runtimesPath, 'chromium')
    fs.mkdirSync(chromiumDir, { recursive: true })
    const archive = path.join(chromiumDir, name)
    const r = spawnSync('tar', [name.endsWith('.gz') ? '-czf' : '-cf', archive, '-C', staging, platformFolder()])
    fs.rmSync(staging, { recursive: true, force: true })
    if (r.status !== 0) throw new Error(`tar failed: ${r.stderr}`)
    return archive
  }

  // Pack a fake chromium tree into <runtimes>/chromium/chromium.pak via the REAL
  // legacy compatibility script — proving the script's XOR key matches the resolver's.
  function makeObfuscatedArchive(runtimesPath: string): string {
    const tarGz = makeArchive(runtimesPath)
    const pak = path.join(runtimesPath, 'chromium', 'chromium.pak')
    const r = spawnSync(process.execPath, ['scripts/obfuscate-chromium.mjs', tarGz, pak])
    if (r.status !== 0) throw new Error(`obfuscate failed: ${r.stderr}`)
    fs.rmSync(tarGz, { force: true }) // ship only the .pak
    return pak
  }

  beforeEach(() => {
    vi.clearAllMocks()
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chromium-resolver-'))
    process.env.SPECRAILS_CHROMIUM_CACHE_DIR = path.join(tmp, 'cache')
  })
  afterEach(() => {
    vi.restoreAllMocks()
    const restore = (k: string, v: string | undefined) => {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    restore('SPECRAILS_IS_DESKTOP', savedDesktop)
    restore('SPECRAILS_BUNDLED_RUNTIMES_PATH', savedRuntimes)
    restore('SPECRAILS_CHROMIUM_CACHE_DIR', savedCache)
    restore('COPYFILE_DISABLE', savedCopyfile)
    restore('COPY_EXTENDED_ATTRIBUTES_DISABLE', savedCopyAttributes)
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('discovers the bundled chromium executable for the current platform', () => {
    const root = path.join(tmp, 'chromium')
    const exe = makeChromiumTree(root)
    expect(discoverChromiumExecutable(root)).toBe(exe)
  })

  it('discoverChromiumExecutable returns null for an empty/missing tree', () => {
    expect(discoverChromiumExecutable(path.join(tmp, 'nope'))).toBeNull()
    fs.mkdirSync(path.join(tmp, 'empty'))
    expect(discoverChromiumExecutable(path.join(tmp, 'empty'))).toBeNull()
  })

  // ── resolveBundledChromiumPath (sync, unpacked-only) ───────────────────────

  it('returns null when not in desktop mode', () => {
    delete process.env.SPECRAILS_IS_DESKTOP
    process.env.SPECRAILS_BUNDLED_RUNTIMES_PATH = tmp
    makeChromiumTree(path.join(tmp, 'chromium'))
    expect(resolveBundledChromiumPath()).toBeNull()
  })

  it('returns null when the runtimes path is unset', () => {
    process.env.SPECRAILS_IS_DESKTOP = '1'
    delete process.env.SPECRAILS_BUNDLED_RUNTIMES_PATH
    expect(resolveBundledChromiumPath()).toBeNull()
  })

  it('returns null when no bundled chromium exists', () => {
    process.env.SPECRAILS_IS_DESKTOP = '1'
    process.env.SPECRAILS_BUNDLED_RUNTIMES_PATH = tmp
    expect(resolveBundledChromiumPath()).toBeNull()
  })

  it('resolves the unpacked bundled chromium when present (desktop mode)', () => {
    process.env.SPECRAILS_IS_DESKTOP = '1'
    process.env.SPECRAILS_BUNDLED_RUNTIMES_PATH = tmp
    const exe = makeChromiumTree(path.join(tmp, 'chromium'))
    expect(resolveBundledChromiumPath()).toBe(exe)
  })

  // ── resolveBundledChromiumExecutable (async, extracts archive) ─────────────

  it('async resolver returns null when not in desktop mode', async () => {
    delete process.env.SPECRAILS_IS_DESKTOP
    process.env.SPECRAILS_BUNDLED_RUNTIMES_PATH = tmp
    makeArchive(tmp)
    expect(await resolveBundledChromiumExecutable()).toBeNull()
  })

  it('async resolver returns null when runtimes path is unset', async () => {
    process.env.SPECRAILS_IS_DESKTOP = '1'
    delete process.env.SPECRAILS_BUNDLED_RUNTIMES_PATH
    expect(await resolveBundledChromiumExecutable()).toBeNull()
  })

  it('async resolver falls back to an unpacked tree when no archive is shipped', async () => {
    process.env.SPECRAILS_IS_DESKTOP = '1'
    process.env.SPECRAILS_BUNDLED_RUNTIMES_PATH = tmp
    const exe = makeChromiumTree(path.join(tmp, 'chromium'))
    expect(await resolveBundledChromiumExecutable()).toBe(exe)
  })

  it('async resolver extracts the shipped archive and returns the executable', async () => {
    process.env.SPECRAILS_IS_DESKTOP = '1'
    process.env.SPECRAILS_BUNDLED_RUNTIMES_PATH = tmp
    makeArchive(tmp)
    const exe = await resolveBundledChromiumExecutable()
    expect(exe).toBeTruthy()
    // Extracted under the cache dir, not the read-only runtimes path.
    expect(exe!.startsWith(process.env.SPECRAILS_CHROMIUM_CACHE_DIR!)).toBe(true)
    expect(fs.existsSync(exe!)).toBe(true)
    // Marker written so a later run can skip re-extraction.
    expect(fs.existsSync(path.join(process.env.SPECRAILS_CHROMIUM_CACHE_DIR!, '.source'))).toBe(true)
  })

  it('extracts with metadata preservation enabled without mutating the caller environment', async () => {
    process.env.SPECRAILS_IS_DESKTOP = '1'
    process.env.SPECRAILS_BUNDLED_RUNTIMES_PATH = tmp
    makeArchive(tmp)
    process.env.COPYFILE_DISABLE = '1'
    process.env.COPY_EXTENDED_ATTRIBUTES_DISABLE = '1'
    expect(await resolveBundledChromiumExecutable()).toBeTruthy()
    const calls = vi.mocked(spawn).mock.calls
    expect(calls).toHaveLength(1)
    const options = calls[0][2]!
    expect(options.env).not.toBe(process.env)
    expect(options.env?.COPYFILE_DISABLE).toBeUndefined()
    expect(options.env?.COPY_EXTENDED_ATTRIBUTES_DISABLE).toBeUndefined()
    expect(options.env?.SPECRAILS_CHROMIUM_CACHE_DIR).toBe(process.env.SPECRAILS_CHROMIUM_CACHE_DIR)
    expect(process.env.COPYFILE_DISABLE).toBe('1')
    expect(process.env.COPY_EXTENDED_ATTRIBUTES_DISABLE).toBe('1')
  })

  it('async resolver de-obfuscates and extracts a chromium.pak blob', async () => {
    process.env.SPECRAILS_IS_DESKTOP = '1'
    process.env.SPECRAILS_BUNDLED_RUNTIMES_PATH = tmp
    const pak = makeObfuscatedArchive(tmp)
    // Preserve the old encoded format while preferring transparent archives below.
    expect(fs.readFileSync(pak).subarray(0, 2).equals(Buffer.from([0x1f, 0x8b]))).toBe(false)
    const exe = await resolveBundledChromiumExecutable()
    expect(exe).toBeTruthy()
    expect(exe!.startsWith(process.env.SPECRAILS_CHROMIUM_CACHE_DIR!)).toBe(true)
    expect(fs.existsSync(exe!)).toBe(true)
  })

  it('async resolver reuses the extracted cache when the marker matches (no re-extract)', async () => {
    process.env.SPECRAILS_IS_DESKTOP = '1'
    process.env.SPECRAILS_BUNDLED_RUNTIMES_PATH = tmp
    makeArchive(tmp)
    const exe = await resolveBundledChromiumExecutable()
    const rename = vi.spyOn(fs, 'renameSync')
    expect(await resolveBundledChromiumExecutable()).toBe(exe)
    expect(rename).not.toHaveBeenCalled()

  })

  it('async resolver returns null when the archive is corrupt and no fallback exists', async () => {
    process.env.SPECRAILS_IS_DESKTOP = '1'
    process.env.SPECRAILS_BUNDLED_RUNTIMES_PATH = tmp
    const chromiumDir = path.join(tmp, 'chromium')
    fs.mkdirSync(chromiumDir, { recursive: true })
    fs.writeFileSync(path.join(chromiumDir, 'chromium.tar.gz'), 'corrupt')
    expect(await resolveBundledChromiumExecutable()).toBeNull()
  })
  it.each(['chromium.tar.gz', 'chromium.tar'])('prefers transparent %s over a legacy archive', async (name) => {
    process.env.SPECRAILS_IS_DESKTOP = '1'
    process.env.SPECRAILS_BUNDLED_RUNTIMES_PATH = tmp
    makeObfuscatedArchive(tmp)
    const oldExe = await resolveBundledChromiumExecutable()
    expect(fs.readFileSync(oldExe!, 'utf8')).toBe('x')
    makeArchive(tmp, 'new signed distribution fixture', name)
    const exe = await resolveBundledChromiumExecutable()
    expect(fs.readFileSync(exe!, 'utf8')).toBe('new signed distribution fixture')
    const marker = JSON.parse(fs.readFileSync(path.join(process.env.SPECRAILS_CHROMIUM_CACHE_DIR!, '.source'), 'utf8'))
    expect(marker.path).toBe(fs.realpathSync(path.join(tmp, 'chromium', name)))
  })

  it('does not let a corrupt preferred archive silently select an old pak', async () => {
    process.env.SPECRAILS_IS_DESKTOP = '1'
    process.env.SPECRAILS_BUNDLED_RUNTIMES_PATH = tmp
    makeObfuscatedArchive(tmp)
    fs.writeFileSync(path.join(tmp, 'chromium', 'chromium.tar.gz'), 'corrupt new distribution')
    expect(await resolveBundledChromiumExecutable()).toBeNull()
  })

  it('re-extracts when the selected bundle path changes despite identical archive size and mtime', async () => {
    process.env.SPECRAILS_IS_DESKTOP = '1'
    process.env.SPECRAILS_BUNDLED_RUNTIMES_PATH = tmp
    const first = makeArchive(tmp)
    const exe = await resolveBundledChromiumExecutable()
    fs.writeFileSync(exe!, 'old cached binary')
    const secondRoot = path.join(tmp, 'replacement bundle')
    fs.mkdirSync(path.join(secondRoot, 'chromium'), { recursive: true })
    const second = path.join(secondRoot, 'chromium', 'chromium.tar.gz')
    fs.copyFileSync(first, second)
    const timestamp = new Date(1_700_000_000_000)
    fs.utimesSync(first, timestamp, timestamp)
    fs.utimesSync(second, timestamp, timestamp)
    // Refresh the first marker after changing only its timestamps.
    await resolveBundledChromiumExecutable()
    fs.writeFileSync(exe!, 'old cached binary')
    process.env.SPECRAILS_BUNDLED_RUNTIMES_PATH = secondRoot
    expect(fs.readFileSync((await resolveBundledChromiumExecutable())!, 'utf8')).toBe('x')
  })

  it('re-extracts a cache deleted after a successful resolution', async () => {
    process.env.SPECRAILS_IS_DESKTOP = '1'
    process.env.SPECRAILS_BUNDLED_RUNTIMES_PATH = tmp
    makeArchive(tmp)
    const exe = await resolveBundledChromiumExecutable()
    fs.rmSync(process.env.SPECRAILS_CHROMIUM_CACHE_DIR!, { recursive: true, force: true })
    expect(await resolveBundledChromiumExecutable()).toBe(exe)
    expect(fs.existsSync(exe!)).toBe(true)
  })

  it('resolves separately when the requested writable cache directory changes', async () => {
    process.env.SPECRAILS_IS_DESKTOP = '1'
    process.env.SPECRAILS_BUNDLED_RUNTIMES_PATH = tmp
    makeArchive(tmp)
    const first = await resolveBundledChromiumExecutable()
    process.env.SPECRAILS_CHROMIUM_CACHE_DIR = path.join(tmp, 'other cache')
    const second = await resolveBundledChromiumExecutable()
    expect(second).not.toBe(first)
    expect(second!.startsWith(process.env.SPECRAILS_CHROMIUM_CACHE_DIR!)).toBe(true)
    expect(fs.existsSync(first!)).toBe(true)
    expect(fs.existsSync(second!)).toBe(true)
  })

  it('shares one extraction for concurrent requests for the same bundle and cache', async () => {
    process.env.SPECRAILS_IS_DESKTOP = '1'
    process.env.SPECRAILS_BUNDLED_RUNTIMES_PATH = tmp
    makeArchive(tmp)
    const rename = vi.spyOn(fs, 'renameSync')
    const results = await Promise.all([resolveBundledChromiumExecutable(), resolveBundledChromiumExecutable(), resolveBundledChromiumExecutable()])
    expect(new Set(results).size).toBe(1)
    expect(results[0]).toBeTruthy()
    expect(rename.mock.calls.filter(([, to]) => to === process.env.SPECRAILS_CHROMIUM_CACHE_DIR)).toHaveLength(1)
  })

  it('rejects an archive changed during extraction and serializes the replacement retry', async () => {
    process.env.SPECRAILS_IS_DESKTOP = '1'
    process.env.SPECRAILS_BUNDLED_RUNTIMES_PATH = tmp
    makeArchive(tmp, 'old browser')
    const first = resolveBundledChromiumExecutable()
    // The tar process is pending; replace its input before publishing its result.
    makeArchive(tmp, 'replacement browser')
    const second = resolveBundledChromiumExecutable()
    const [oldResult, newResult] = await Promise.all([first, second])
    expect(oldResult).toBeNull()
    expect(fs.readFileSync(newResult!, 'utf8')).toBe('replacement browser')
    expect(fs.readdirSync(tmp).filter((entry) => entry.startsWith('cache.tmp-'))).toEqual([])
  })

  it('restores the previous cache when publication of a new extraction fails', async () => {
    process.env.SPECRAILS_IS_DESKTOP = '1'
    process.env.SPECRAILS_BUNDLED_RUNTIMES_PATH = tmp
    makeArchive(tmp, 'old browser')
    const exe = await resolveBundledChromiumExecutable()
    const cache = process.env.SPECRAILS_CHROMIUM_CACHE_DIR!
    const marker = fs.readFileSync(path.join(cache, '.source'), 'utf8')
    makeArchive(tmp, 'new browser')
    const originalRename = fs.renameSync.bind(fs)
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(from).includes('.tmp-') && !String(from).endsWith('.previous') && to === cache) throw new Error('fixture publication failure')
      originalRename(from, to)
    })
    expect(await resolveBundledChromiumExecutable()).toBeNull()
    expect(fs.readFileSync(exe!, 'utf8')).toBe('old browser')
    expect(fs.readFileSync(path.join(cache, '.source'), 'utf8')).toBe(marker)
    vi.restoreAllMocks()
    expect(fs.readFileSync((await resolveBundledChromiumExecutable())!, 'utf8')).toBe('new browser')
  })

  it.skipIf(process.platform === 'win32')('preserves the framework symlinks inside a transparent archive', async () => {
    process.env.SPECRAILS_IS_DESKTOP = '1'
    process.env.SPECRAILS_BUNDLED_RUNTIMES_PATH = tmp
    const stage = path.join(tmp, 'stage')
    makeChromiumTree(stage)
    const framework = path.join(stage, platformFolder(), 'Fixture.framework')
    fs.mkdirSync(path.join(framework, 'Versions', 'A', 'Resources'), { recursive: true })
    fs.symlinkSync('A', path.join(framework, 'Versions', 'Current'))
    fs.symlinkSync('Versions/Current/Resources', path.join(framework, 'Resources'))
    fs.mkdirSync(path.join(tmp, 'chromium'), { recursive: true })
    const packed = spawnSync('tar', ['-czf', path.join(tmp, 'chromium', 'chromium.tar.gz'), '-C', stage, platformFolder()])
    expect(packed.status).toBe(0)
    expect(await resolveBundledChromiumExecutable()).toBeTruthy()
    const extracted = path.join(process.env.SPECRAILS_CHROMIUM_CACHE_DIR!, platformFolder(), 'Fixture.framework')
    expect(fs.readlinkSync(path.join(extracted, 'Versions', 'Current'))).toBe('A')
    expect(fs.readlinkSync(path.join(extracted, 'Resources'))).toBe('Versions/Current/Resources')
  })

})
