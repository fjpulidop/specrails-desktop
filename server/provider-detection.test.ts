import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { syncBuiltinESMExports } from 'node:module'

// ─── Mock the adapter registry so no real CLI is probed ──────────────────────

const mocks = vi.hoisted(() => {
  const makeAdapter = (
    id: string,
    detect: () => Promise<Record<string, unknown>>,
    minCliVersion: string | null = null,
  ) => ({
    id,
    displayName: id[0].toUpperCase() + id.slice(1),
    minCliVersion,
    detectInstalled: vi.fn(detect),
  })
  return { makeAdapter, adapters: [] as ReturnType<typeof makeAdapter>[] }
})

vi.mock('./providers', () => ({
  listAdapters: () => mocks.adapters,
}))
vi.mock('./core-compat', () => ({
  checkCoreCompat: vi.fn(async () => ({ compatible: true })),
  coreCompatSupportsProvider: vi.fn(() => true),
}))

import {
  getDetectionSnapshot,
  refreshDetection,
  getDetectedIdsSync,
  isCodexBetaDisabled,
  isGeminiBetaDisabled,
  _resetDetectionForTests,
} from './provider-detection'
import {
  setDetectedProvidersSupplier,
  resolveProvider,
  derivePrimaryProvider,
  validateRequestedProvider,
  isMultiProvider,
} from './provider-selection'
import type { CliProvider } from './desktop-db'

const installed = async () => ({ installed: true, executable: true, version: '1.0.0' })
const missing = async () => ({ installed: false, executable: false })

describe('Codex authentication presence follows the invocation home', () => {
  let root: string
  let authHome: string
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-auth-probe-'))
    authHome = path.join(root, 'Codex José Login')
    fs.mkdirSync(authHome)
    vi.spyOn(os, 'homedir').mockReturnValue(root)
    syncBuiltinESMExports()
    vi.stubEnv('CODEX_HOME', authHome)
    mocks.adapters.push(mocks.makeAdapter('codex', installed))
  })
  afterEach(() => {
    vi.restoreAllMocks()
    syncBuiltinESMExports()
    vi.unstubAllEnvs()
    fs.rmSync(root, { recursive: true, force: true })
  })
  it('recognizes an accessible auth file in the custom home without reading it', async () => {
    fs.writeFileSync(path.join(authHome, 'auth.json'), 'synthetic fixture; never credential contents')
    const read = vi.spyOn(fs, 'readFileSync')
    syncBuiltinESMExports()
    expect((await getDetectionSnapshot()).providers.codex.authState).toBe('authenticated')
    expect(read.mock.calls.some(([file]) => file === path.join(authHome, 'auth.json'))).toBe(false)
  })
  it('does not claim the default home login applies when a different override is empty', async () => {
    fs.mkdirSync(path.join(root, '.codex'))
    fs.writeFileSync(path.join(root, '.codex', 'auth.json'), '{}')
    expect((await getDetectionSnapshot()).providers.codex.authState).toBe('unauthenticated')
    vi.stubEnv('CODEX_HOME', '')
    expect((await getDetectionSnapshot({ refresh: true })).providers.codex.authState).toBe('authenticated')
  })
  it('keeps uncertain relative or unreadable locations unknown without disabling the provider', async () => {
    vi.stubEnv('CODEX_HOME', 'relative-login')
    expect((await getDetectionSnapshot()).providers.codex.authState).toBe('unknown')
    vi.stubEnv('CODEX_HOME', authHome)
    fs.mkdirSync(path.join(authHome, 'auth.json')) // present but not a readable credential file
    const result = (await getDetectionSnapshot({ refresh: true })).providers.codex
    expect(result.authState).toBe('unknown')
    expect(result.usable).toBe(true)
  })
  it('reports inaccessible credentials as unknown instead of claiming a login is missing', async () => {
    const authFile = path.join(authHome, 'auth.json')
    fs.writeFileSync(authFile, '{}')
    const access = fs.accessSync
    vi.spyOn(fs, 'accessSync').mockImplementation((file, mode) => {
      if (file === authFile) throw Object.assign(new Error('Access denied'), { code: 'EACCES' })
      access(file, mode)
    })
    syncBuiltinESMExports()
    expect((await getDetectionSnapshot()).providers.codex.authState).toBe('unknown')
  })
})

beforeEach(() => {
  _resetDetectionForTests()
  mocks.adapters.length = 0
  delete process.env.SPECRAILS_CODEX_BETA
  delete process.env.SPECRAILS_HUB_CODEX_BETA
  delete process.env.SPECRAILS_GEMINI_BETA
})

afterEach(() => {
  setDetectedProvidersSupplier(null)
})

describe('getDetectionSnapshot', () => {
  it('covers every registered adapter and reports the usable set', async () => {
    mocks.adapters.push(
      mocks.makeAdapter('claude', installed),
      mocks.makeAdapter('gemini', installed),
      mocks.makeAdapter('codex', missing),
    )
    const snap = await getDetectionSnapshot()
    expect(Object.keys(snap.providers).sort()).toEqual(['claude', 'codex', 'gemini'])
    expect(snap.detected).toEqual(['claude', 'gemini'])
    expect(snap.providers.codex.installed).toBe(false)
    expect(snap.providers.codex.usable).toBe(false)
  })

  it('beta veto excludes a provider from the usable set', async () => {
    process.env.SPECRAILS_GEMINI_BETA = '0'
    mocks.adapters.push(
      mocks.makeAdapter('claude', installed),
      mocks.makeAdapter('gemini', installed),
    )
    const snap = await getDetectionSnapshot()
    expect(snap.detected).toEqual(['claude'])
    expect(snap.providers.gemini.vetoed).toBe(true)
    expect(snap.providers.gemini.installed).toBe(true)
  })

  it('caches results inside the TTL and refreshes on demand', async () => {
    const adapter = mocks.makeAdapter('claude', installed)
    mocks.adapters.push(adapter)
    await getDetectionSnapshot()
    await getDetectionSnapshot()
    expect(adapter.detectInstalled).toHaveBeenCalledTimes(1)
    await getDetectionSnapshot({ refresh: true })
    expect(adapter.detectInstalled).toHaveBeenCalledTimes(2)
  })

  it('a throwing probe degrades to not-installed instead of failing detection', async () => {
    mocks.adapters.push(
      mocks.makeAdapter('claude', installed),
      mocks.makeAdapter('codex', async () => {
        throw new Error('boom')
      }),
    )
    const snap = await getDetectionSnapshot()
    expect(snap.detected).toEqual(['claude'])
    expect(snap.providers.codex.installed).toBe(false)
    expect(snap.providers.codex.error).toContain('boom')
    expect(snap.providers.codex.authState).toBe('unknown')
  })

  it('version floor failure keeps the provider listed but unusable', async () => {
    mocks.adapters.push(
      mocks.makeAdapter(
        'codex',
        async () => ({ installed: true, executable: true, version: '0.1.0', meetsMinimum: false }),
        '0.128.0',
      ),
    )
    const snap = await getDetectionSnapshot()
    expect(snap.detected).toEqual([])
    expect(snap.providers.codex.error).toContain('0.128.0')
  })
})

describe('refreshDetection change reporting', () => {
  it('first detection is never "changed"; a later set change is', async () => {
    mocks.adapters.push(mocks.makeAdapter('claude', installed))
    const first = await refreshDetection()
    expect(first.changed).toBe(false)
    mocks.adapters.push(mocks.makeAdapter('codex', installed))
    const second = await refreshDetection()
    expect(second.changed).toBe(true)
    expect(second.snapshot.detected).toEqual(['claude', 'codex'])
    const third = await refreshDetection()
    expect(third.changed).toBe(false)
  })
})

describe('beta veto helpers', () => {
  it('codex honours the legacy fallback var', () => {
    expect(isCodexBetaDisabled()).toBe(false)
    process.env.SPECRAILS_HUB_CODEX_BETA = '0'
    expect(isCodexBetaDisabled()).toBe(true)
    process.env.SPECRAILS_CODEX_BETA = '1'
    expect(isCodexBetaDisabled()).toBe(false)
  })

  it('gemini only disables on the exact string 0', () => {
    process.env.SPECRAILS_GEMINI_BETA = 'false'
    expect(isGeminiBetaDisabled()).toBe(false)
    process.env.SPECRAILS_GEMINI_BETA = '0'
    expect(isGeminiBetaDisabled()).toBe(true)
  })
})

describe('provider-selection with a detection supplier', () => {
  const row = { provider: 'codex' as CliProvider, providers: ['codex'] as CliProvider[] }

  it('detected set is authoritative over the project row', () => {
    setDetectedProvidersSupplier(() => ['claude', 'kimi'])
    expect(isMultiProvider(row)).toBe(true)
    expect(validateRequestedProvider(row, 'kimi')).toEqual({ ok: true, provider: 'kimi' })
    expect(validateRequestedProvider(row, 'codex').ok).toBe(false)
  })

  it('primary derivation: stored while detected, else claude, else preference order', () => {
    setDetectedProvidersSupplier(() => ['claude', 'codex'])
    expect(derivePrimaryProvider(row)).toBe('codex')
    setDetectedProvidersSupplier(() => ['claude', 'gemini'])
    expect(derivePrimaryProvider(row)).toBe('claude')
    setDetectedProvidersSupplier(() => ['kimi', 'gemini'])
    expect(derivePrimaryProvider(row)).toBe('gemini')
  })

  it('stale stored engine falls back to derived primary without throwing', () => {
    setDetectedProvidersSupplier(() => ['claude'])
    expect(resolveProvider(row, 'gemini')).toBe('claude')
  })

  it('null supplier restores legacy row behaviour', () => {
    setDetectedProvidersSupplier(null)
    expect(resolveProvider(row, 'gemini')).toBe('codex')
    expect(isMultiProvider(row)).toBe(false)
  })

  it('getDetectedIdsSync is null before any detection', () => {
    expect(getDetectedIdsSync()).toBeNull()
  })
})
