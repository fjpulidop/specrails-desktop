import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { DISK_FAIL_BYTES, DISK_WARN_BYTES, desktopGuiFramework, diskChip, githubChip, headlessChip, providerChip, quotaChip, signInFromExit } from '../domain'
import { probeDesktopGui } from '../runtime/desktop-gui-probe'
import { createLaunchPreflight, PROBE_TIMEOUT_MS, SIGN_IN_TTL_MS, statfsFreeBytes, type PreflightDeps } from '../runtime/preflight'

describe('launch preflight chips', () => {
  it('fails under 1 GiB and warns under 5 GiB free', () => {
    expect(diskChip(DISK_FAIL_BYTES - 1).state).toBe('fail')
    expect(diskChip(DISK_WARN_BYTES - 1).state).toBe('warn')
    expect(diskChip(DISK_WARN_BYTES).state).toBe('ok')
    expect(diskChip(null).state).toBe('unknown')
  })

  it('reads sign-in from the exit code only', () => {
    expect(signInFromExit({ code: 0 })).toBe('signed-in')
    expect(signInFromExit({ code: 1 })).toBe('signed-out')
    expect(signInFromExit({ code: null, timedOut: true })).toBe('unknown')
    expect(signInFromExit({ code: null, missing: true })).toBe('missing')
    expect(providerChip('claude', 'signed-out').state).toBe('fail')
    expect(githubChip('signed-out').state).toBe('warn')
  })

  it('warns on quota at 80 %, 90 % and on a refusal, never blocks on it', () => {
    for (const level of ['warning', 'critical', 'rejected']) expect(quotaChip({ providerId: 'claude', level, usedPercent: 85, rejectedUntil: null }).state).toBe('warn')
    expect(quotaChip({ providerId: 'claude', level: 'ok', usedPercent: 10, rejectedUntil: null }).state).toBe('ok')
  })
})

function deps(overrides: Partial<PreflightDeps> = {}): PreflightDeps & { exec: ReturnType<typeof vi.fn> } {
  let now = 1_000
  const exec = vi.fn(async (command: string) => ({ code: command === 'gh' ? 1 : 0, timedOut: false, missing: false }))
  return {
    exec, freeBytes: async () => 20 * 1024 ** 3, executable: async (id) => (id === 'codex' ? null : id),
    quota: (id) => (id === 'claude' ? { providerId: 'claude', level: 'warning', usedPercent: 82, rejectedUntil: null } : null),
    now: () => (now += 1), ...overrides,
  } as PreflightDeps & { exec: ReturnType<typeof vi.fn> }
}

describe('launch preflight probes', () => {
  it('checks disk, every provider, GitHub and quota in parallel', async () => {
    const d = deps()
    const report = await createLaunchPreflight(d).run({ worktreesDir: '/x', providers: ['claude', 'codex', 'claude'], github: true })
    expect(report.chips.map((chip) => [chip.id, chip.state])).toEqual([
      ['disk', 'ok'], ['provider:claude', 'ok'], ['provider:codex', 'fail'], ['github', 'warn'], ['quota:claude', 'warn'],
    ])
    expect(report.blocking).toBe(true)
    expect(d.exec).toHaveBeenCalledWith('claude', ['auth', 'status'], PROBE_TIMEOUT_MS)
  })

  it('caches sign-in for a minute and shares a probe in flight', async () => {
    let now = 0
    const d = deps({ now: () => now })
    const preflight = createLaunchPreflight(d)
    await Promise.all([preflight.run({ worktreesDir: '/x', providers: ['claude'], github: false }), preflight.run({ worktreesDir: '/x', providers: ['claude'], github: false })])
    expect(d.exec).toHaveBeenCalledTimes(1)
    now = SIGN_IN_TTL_MS + 1
    await preflight.run({ worktreesDir: '/x', providers: ['claude'], github: false })
    expect(d.exec).toHaveBeenCalledTimes(2)
    await preflight.run({ worktreesDir: '/x', providers: ['claude'], github: false, fresh: true })
    expect(d.exec).toHaveBeenCalledTimes(3)
  })

  it('reports unknown when a probe throws, and retries it next time', async () => {
    const exec = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue({ code: 0, timedOut: false, missing: false })
    const preflight = createLaunchPreflight(deps({ exec }))
    expect((await preflight.run({ worktreesDir: '/x', providers: ['claude'], github: false })).chips[1]).toMatchObject({ status: 'unknown' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect((await preflight.run({ worktreesDir: '/x', providers: ['claude'], github: false })).chips[1]).toMatchObject({ status: 'signed-in' })
  })

  it('reads free space from the nearest existing ancestor', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'preflight-'))
    try {
      expect(await statfsFreeBytes(path.join(root, 'missing', 'worktrees'))).toBeGreaterThan(0)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})

describe('headless desktop apps', () => {
  it('detects the desktop GUI toolkit from dependencies and marker files', () => {
    expect(desktopGuiFramework({ dependencies: ['react', 'electron'], files: [] })).toBe('electron')
    expect(desktopGuiFramework({ dependencies: [], files: ['src-tauri/tauri.conf.json'] })).toBe('tauri')
    expect(desktopGuiFramework({ dependencies: ['@tauri-apps/api'], files: [] })).toBe('tauri')
    expect(desktopGuiFramework({ dependencies: [], files: ['wails.json'] })).toBe('wails')
    expect(desktopGuiFramework({ dependencies: ['react', 'vite'], files: [] })).toBeNull()
  })

  it('is fine for Electron (Specrails hides it) and warns for other toolkits until they honour SPECRAILS_HEADLESS', () => {
    expect(headlessChip('electron', false).state).toBe('ok')
    expect(headlessChip('tauri', false).state).toBe('warn')
    expect(headlessChip('tauri', true).state).toBe('ok')
  })

  it('adds the chip only for a desktop GUI project and never blocks on it', async () => {
    const gui = createLaunchPreflight(deps({ desktopGui: async () => ({ framework: 'tauri', honoured: false }) }))
    const report = await gui.run({ worktreesDir: '/x', providers: [], github: false, projectDir: '/repo' })
    expect(report.chips.map((chip) => [chip.id, chip.state])).toEqual([['disk', 'ok'], ['headless', 'warn']])
    expect(report.blocking).toBe(false)
    const plain = createLaunchPreflight(deps({ desktopGui: async () => null }))
    expect((await plain.run({ worktreesDir: '/x', providers: [], github: false, projectDir: '/repo' })).chips.map((chip) => chip.id)).toEqual(['disk'])
  })

  it('reads the repository without writing to it', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'gui-probe-'))
    try {
      writeFileSync(path.join(root, 'package.json'), JSON.stringify({ devDependencies: { electron: '^42.0.0' } }))
      mkdirSync(path.join(root, 'node_modules', 'x'), { recursive: true })
      writeFileSync(path.join(root, 'node_modules', 'x', 'index.js'), 'process.env.SPECRAILS_HEADLESS')
      expect(await probeDesktopGui(root)).toEqual({ framework: 'electron', honoured: false })
      mkdirSync(path.join(root, 'src', 'main'), { recursive: true })
      writeFileSync(path.join(root, 'src', 'main', 'main.ts'), "const headless = process.env.SPECRAILS_HEADLESS === '1'")
      expect(await probeDesktopGui(root)).toEqual({ framework: 'electron', honoured: true })
      expect(await probeDesktopGui(path.join(root, 'src'))).toBeNull()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
