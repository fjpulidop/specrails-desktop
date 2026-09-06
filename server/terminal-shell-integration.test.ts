import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import {
  composeShellIntegrationSpawn,
  cleanupSessionShim,
  cleanupStaleShimDirs,
  shimDirFor,
  NO_SHELL_INTEGRATION,
} from './terminal-shell-integration'

const ENABLED = { shellIntegrationEnabled: true }
const DISABLED = { shellIntegrationEnabled: false }

let tmpHome: string
let originalRegistryHome: string | undefined

beforeEach(() => {
  originalRegistryHome = process.env.SPECRAILS_REGISTRY_HOME
  delete process.env.SPECRAILS_REGISTRY_HOME
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-shim-test-'))
  vi.spyOn(os, 'homedir').mockReturnValue(tmpHome)
})

afterEach(() => {
  vi.restoreAllMocks()
  if (originalRegistryHome !== undefined) process.env.SPECRAILS_REGISTRY_HOME = originalRegistryHome
  else delete process.env.SPECRAILS_REGISTRY_HOME
  try { fs.rmSync(tmpHome, { recursive: true, force: true }) } catch { /* ignore */ }
})

describe('composeShellIntegrationSpawn', () => {
  it('returns NO_SHELL_INTEGRATION when disabled', () => {
    const got = composeShellIntegrationSpawn('/bin/zsh', 's1', 'proj', DISABLED)
    expect(got).toEqual(NO_SHELL_INTEGRATION)
  })

  it('uses SPECRAILS_REGISTRY_HOME for per-session shim directories', () => {
    const registryHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-shim-registry-'))
    process.env.SPECRAILS_REGISTRY_HOME = registryHome
    try {
      expect(shimDirFor('proj', 's1')).toBe(path.join(registryHome, '.specrails', 'projects', 'proj', 'terminals', 's1'))
    } finally {
      fs.rmSync(registryHome, { recursive: true, force: true })
    }
  })

  it('zsh: writes ZDOTDIR/.zshrc and returns ZDOTDIR + real-ZDOTDIR env', () => {
    const got = composeShellIntegrationSpawn('/bin/zsh', 's1', 'proj', ENABLED)
    expect(got.args).toEqual([])
    expect(got.env.ZDOTDIR).toBe(shimDirFor('proj', 's1'))
    // The shim needs the user's real ZDOTDIR to re-source their login files.
    expect(got.env.SPECRAILS_REAL_ZDOTDIR).toBe(process.env.ZDOTDIR ?? '')
    expect(got.shimPath).toBe(path.join(got.shimDir!, '.zshrc'))
    const content = fs.readFileSync(got.shimPath!, 'utf-8')
    expect(content).toMatch(/zsh-shim\.zsh/)
    // chmod 600
    const stat = fs.statSync(got.shimPath!)
    expect(stat.mode & 0o777).toBe(0o600)
  })

  it('bash: returns --rcfile and writes shim file', () => {
    const got = composeShellIntegrationSpawn('/bin/bash', 's2', 'proj', ENABLED)
    expect(got.args[0]).toBe('--rcfile')
    expect(got.shimPath).toBe(got.args[1])
    expect(fs.readFileSync(got.shimPath!, 'utf-8')).toMatch(/bash-shim\.bash/)
  })

  it('fish: injects shim via -C init-command without hijacking XDG_CONFIG_HOME', () => {
    const got = composeShellIntegrationSpawn('/usr/local/bin/fish', 's3', 'proj', ENABLED)
    // Must NOT repoint fish's whole config tree — the user's config.fish stays intact.
    expect(got.env.XDG_CONFIG_HOME).toBeUndefined()
    expect(got.args[0]).toBe('-C')
    expect(got.args[1]).toMatch(/^source '.*fish-shim\.fish'$/)
    // shimPath points at the bundled shim (non-null so OSC parsing activates);
    // no per-session dir is written.
    expect(got.shimPath).toMatch(/fish-shim\.fish$/)
    expect(got.shimDir).toBeNull()
  })

  it('PowerShell: permits only the generated process profile and leaves no engine arguments after -File', () => {
    const got = composeShellIntegrationSpawn('C:\\Program Files\\PowerShell\\7\\pwsh.exe', 's4', 'proj', ENABLED)
    expect(got.args).toEqual(['-NoLogo', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', got.shimPath])
    expect(got.replaceArgs).toBe(true)
    expect(fs.readFileSync(got.shimPath!, 'utf-8')).toMatch(/powershell-shim\.ps1/)
  })

  it('unsupported shell falls back to NO_SHELL_INTEGRATION', () => {
    const got = composeShellIntegrationSpawn('/bin/tcsh', 's5', 'proj', ENABLED)
    expect(got).toEqual(NO_SHELL_INTEGRATION)
  })

  it('per-session shim dir is unique', () => {
    const a = composeShellIntegrationSpawn('/bin/zsh', 'sA', 'proj', ENABLED)
    const b = composeShellIntegrationSpawn('/bin/zsh', 'sB', 'proj', ENABLED)
    expect(a.shimDir).not.toBe(b.shimDir)
  })
})

describe('cleanupSessionShim', () => {
  it('removes the per-session directory', () => {
    const got = composeShellIntegrationSpawn('/bin/zsh', 'sX', 'proj', ENABLED)
    expect(fs.existsSync(got.shimDir!)).toBe(true)
    cleanupSessionShim('proj', 'sX')
    expect(fs.existsSync(got.shimDir!)).toBe(false)
  })

  it('is a no-op when the directory does not exist', () => {
    expect(() => cleanupSessionShim('proj', 'never-existed')).not.toThrow()
  })
})

describe('cleanupStaleShimDirs', () => {
  it('removes directories older than 24h and leaves recent ones alone', () => {
    const oldGot = composeShellIntegrationSpawn('/bin/zsh', 'old', 'proj', ENABLED)
    const newGot = composeShellIntegrationSpawn('/bin/zsh', 'new', 'proj', ENABLED)
    // Backdate the "old" dir by 48h.
    const fortyEightAgo = (Date.now() - 48 * 3600 * 1000) / 1000
    fs.utimesSync(oldGot.shimDir!, fortyEightAgo, fortyEightAgo)
    const removed = cleanupStaleShimDirs()
    expect(removed).toBe(1)
    expect(fs.existsSync(oldGot.shimDir!)).toBe(false)
    expect(fs.existsSync(newGot.shimDir!)).toBe(true)
  })

  it('returns 0 when no projects directory exists', () => {
    // tmpHome was created but never had projects/ inside.
    expect(cleanupStaleShimDirs()).toBe(0)
  })
})
