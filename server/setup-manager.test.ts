import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'

const testOriginalPath = process.env.PATH
beforeEach(() => { process.env.PATH = '' })
afterEach(() => { process.env.PATH = testOriginalPath })
import { EventEmitter } from 'events'
import { Readable } from 'stream'

// Mock child_process before importing
vi.mock('child_process', () => ({
  spawn: vi.fn(),
  spawnSync: vi.fn().mockReturnValue({ status: 0, stdout: 'specrails-core v4.1.1\n', stderr: '' }),
}))

vi.mock('tree-kill', () => ({
  default: vi.fn(),
}))

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs')
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
    readdirSync: vi.fn().mockReturnValue([]),
    rmSync: vi.fn(),
    mkdirSync: vi.fn(),
    readFileSync: vi.fn().mockReturnValue('# Enrich prompt content'),
    realpathSync: vi.fn((p: any) => String(p)),
    writeFileSync: vi.fn(),
    copyFileSync: vi.fn(),
  }
})

// Default: claude is detected. Override per-test for Codex paths.
vi.mock('./core-compat', () => ({
  findCoreContract: vi.fn().mockResolvedValue(null),
  detectCLISync: vi.fn().mockReturnValue('claude'),
}))

// Default: prerequisites pass. Override per-test if the suite needs to exercise
// the missing-prereq guard.
vi.mock('./setup-prerequisites', () => ({
  formatMissingSetupPrerequisites: vi.fn().mockReturnValue(null),
  getSetupPrerequisitesStatus: vi.fn().mockReturnValue({
    ok: true,
    platform: 'darwin',
    prerequisites: [],
    missingRequired: [],
  }),
}))

import { spawn as mockSpawn, spawnSync as mockSpawnSync } from 'child_process'
import treeKill from 'tree-kill'
import { existsSync, readdirSync, rmSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'fs'
import { detectCLISync } from './core-compat'
import { SetupManager, CHECKPOINTS, QUICK_CHECKPOINTS, computeSummary, sweepLegacySrCommands, validateInstalledCore } from './setup-manager'
import { CORE_PACKAGE_SPEC } from './core-package'
import { initDb, type DbInstance } from './db'
import * as workspaceResolution from './workspace-resolution'

function createMockChildProcess() {
  const child = new EventEmitter() as any
  child.stdout = new Readable({ read() {} })
  child.stderr = new Readable({ read() {} })
  child.pid = 55000
  child.kill = vi.fn()
  return child
}

function pushLine(child: any, line: string) {
  child.stdout.push(line + '\n')
}

function pushErrorLine(child: any, line: string) {
  child.stderr.push(line + '\n')
}

function finishProcess(child: any, code: number): Promise<void> {
  return new Promise((resolve) => {
    child.stdout.push(null)
    child.stderr.push(null)
    setImmediate(() => {
      child.emit('close', code)
      resolve()
    })
  })
}

function getBroadcastedByType(broadcast: ReturnType<typeof vi.fn>, type: string) {
  return broadcast.mock.calls
    .map((args) => args[0] as Record<string, unknown>)
    .filter((msg) => msg.type === type)
}

describe('SetupManager', () => {
  let sm: SetupManager
  let broadcast: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.resetAllMocks()
    broadcast = vi.fn()
    sm = new SetupManager(broadcast)
    vi.mocked(mockSpawnSync).mockReturnValue({
      status: 0,
      stdout: 'specrails-core v4.1.1\n',
      stderr: '',
    } as any)

    // Default: existsSync returns false, readdirSync returns []
    vi.mocked(existsSync).mockReturnValue(false)
    vi.mocked(readdirSync).mockReturnValue([])
  })

  afterEach(() => {
    delete process.env.SPECRAILS_CORE_BIN
    // Defence: ensure no bundled-core env leaks across the fs-mocked suite (it
    // would flip startInstall into the offline branch and break the npx asserts).
    delete process.env.SPECRAILS_BUNDLED_CORE_PATH
    vi.restoreAllMocks()
  })

  // ─── Constants ──────────────────────────────────────────────────────────────

  describe('CHECKPOINTS', () => {
    it('has 7 checkpoint definitions', () => {
      expect(CHECKPOINTS).toHaveLength(7)
    })

    it('contains expected checkpoint keys', () => {
      const keys = CHECKPOINTS.map((c) => c.key)
      expect(keys).toContain('base_install')
      expect(keys).toContain('codebase_analysis')
      expect(keys).toContain('command_generation')
    })
  })

  describe('QUICK_CHECKPOINTS', () => {
    it('has 3 checkpoint definitions', () => {
      expect(QUICK_CHECKPOINTS).toHaveLength(3)
    })

    it('contains config_written, base_install, quick_complete keys', () => {
      const keys = QUICK_CHECKPOINTS.map((c) => c.key)
      expect(keys).toContain('config_written')
      expect(keys).toContain('base_install')
      expect(keys).toContain('quick_complete')
    })
  })

  describe('validateInstalledCore', () => {
    it('accepts installs without legacy markers', () => {
      vi.mocked(existsSync).mockImplementation((p: any) =>
        String(p).includes('.specrails/specrails-version')
      )
      vi.mocked(readFileSync).mockImplementation((p: any) => {
        if (String(p).includes('.specrails/specrails-version')) return '4.1.1\n' as any
        return '# Enrich prompt content' as any
      })

      expect(validateInstalledCore('/path/to/project')).toEqual({ ok: true, reasons: [] })
    })

    it('rejects legacy installs', () => {
      vi.mocked(existsSync).mockImplementation((p: any) => {
        const s = String(p)
        return s.includes('.specrails/specrails-version') || s.includes('.specrails/bin/doctor.sh')
      })
      vi.mocked(readFileSync).mockImplementation((p: any) => {
        if (String(p).includes('.specrails/specrails-version')) return '4.0.5\n' as any
        return '# Enrich prompt content' as any
      })

      const result = validateInstalledCore('/path/to/project')
      expect(result.ok).toBe(false)
      expect(result.reasons.join('\n')).toContain('4.0.5')
      expect(result.reasons.join('\n')).toContain('legacy bash doctor detected')
    })
  })

  // ─── State queries ─────────────────────────────────────────────────────────

  describe('isInstalling / isSettingUp / isEnriching', () => {
    it('returns false when no processes running', () => {
      expect(sm.isInstalling('p1')).toBe(false)
      expect(sm.isSettingUp('p1')).toBe(false)
      expect(sm.isEnriching('p1')).toBe(false)
    })

    it('returns true after starting install', () => {
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      sm.startInstall('p1', '/path/to/project')
      expect(sm.isInstalling('p1')).toBe(true)
    })

    it('returns true after startEnrich', () => {
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      sm.startEnrich('p1', '/path/to/project')
      expect(sm.isEnriching('p1')).toBe(true)
      expect(sm.isSettingUp('p1')).toBe(true) // backward compat alias
    })

    it('returns true after startSetup (deprecated alias)', () => {
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      sm.startSetup('p1', '/path/to/project')
      expect(sm.isSettingUp('p1')).toBe(true)
    })
  })

  // ─── startInstall ──────────────────────────────────────────────────────────

  describe('startInstall', () => {
    it('spawns npx specrails-core (pinned spec) init --yes --root-dir when no config exists', () => {
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(existsSync).mockReturnValue(false)

      sm.startInstall('p1', '/path/to/project')

      expect(mockSpawn).toHaveBeenCalledWith(
        'npx',
        ['--yes', '--prefer-online', CORE_PACKAGE_SPEC, 'init', '--yes', '--root-dir', '/path/to/project'],
        expect.objectContaining({ cwd: '/path/to/project' })
      )
    })

    it('uses the legacy npx path (byte-identical) when SPECRAILS_BUNDLED_CORE_PATH is unset', () => {
      // bundled-core existence gate: env unset + fs.existsSync mocked false ⇒
      // getBundledCoreCli() === null ⇒ legacy npx spawn, never the bundled node CLI.
      delete process.env.SPECRAILS_BUNDLED_CORE_PATH
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(existsSync).mockReturnValue(false)

      sm.startInstall('p-legacy', '/path/to/project')

      // Spawned npx (not process.execPath / a node CLI path).
      const [bin, args] = vi.mocked(mockSpawn).mock.calls[0]
      expect(bin).toBe('npx')
      expect(args as string[]).toContain('init')
    })

    it('spawns npx specrails-core (pinned spec) init --from-config when config exists', () => {
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(existsSync).mockReturnValue(true)

      sm.startInstall('p1', '/path/to/project')

      const [, spawnArgs, spawnOpts] = vi.mocked(mockSpawn).mock.calls[0]
      expect(spawnArgs).toEqual(
        expect.arrayContaining(['--yes', '--prefer-online', CORE_PACKAGE_SPEC, 'init', '--yes', '--from-config'])
      )
      const fromConfigIdx = (spawnArgs as string[]).indexOf('--from-config')
      expect(fromConfigIdx).toBeGreaterThanOrEqual(0)
      expect((spawnArgs as string[])[fromConfigIdx + 1]).toContain('specrails-desktop-install-config-p1-')
      expect(spawnOpts).toEqual(expect.objectContaining({ cwd: '/path/to/project' }))
    })

    it('broadcasts setup_log for stdout', async () => {
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      sm.startInstall('p1', '/path/to/project')
      pushLine(child, 'Installing specrails...')

      // Wait for readline to process
      await new Promise((r) => setImmediate(r))

      const logs = getBroadcastedByType(broadcast, 'setup_log')
      expect(logs.length).toBeGreaterThan(0)
      expect(logs[0].line).toBe('Installing specrails...')
      expect(logs[0].stream).toBe('stdout')
    })

    it('broadcasts setup_install_done on exit 0', async () => {
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      sm.startInstall('p1', '/path/to/project')
      await finishProcess(child, 0)

      const done = getBroadcastedByType(broadcast, 'setup_install_done')
      expect(done).toHaveLength(1)
      expect(done[0].projectId).toBe('p1')
    })

    it('broadcasts setup_error on non-zero exit', async () => {
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      sm.startInstall('p1', '/path/to/project')
      pushErrorLine(child, 'No Claude authentication found.')
      await finishProcess(child, 1)

      const errors = getBroadcastedByType(broadcast, 'setup_error')
      expect(errors).toHaveLength(1)
      expect(errors[0].error).toContain('code 1')
      expect(errors[0].error).toContain('Recent output:')
      expect(errors[0].error).toContain('No Claude authentication found.')
    })

    it('fails before spawn when resolved specrails-core runtime is legacy', () => {
      vi.mocked(mockSpawnSync).mockReturnValue({
        status: 0,
        stdout: 'specrails-core v4.0.5\n',
        stderr: '',
      } as any)

      sm.startInstall('p1', '/path/to/project')

      const errors = getBroadcastedByType(broadcast, 'setup_error')
      expect(errors).toHaveLength(1)
      expect(errors[0].error).toContain('4.0.5')
      expect(vi.mocked(mockSpawn)).not.toHaveBeenCalled()
    })

    it('H19: passes a hard timeout to the core runtime probe spawnSync', () => {
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      sm.startInstall('p1', '/path/to/project')

      const probeCall = vi.mocked(mockSpawnSync).mock.calls.find(
        ([, args]) => Array.isArray(args) && (args as string[]).includes('version'),
      )
      expect(probeCall).toBeDefined()
      expect(probeCall![2]).toEqual(expect.objectContaining({ timeout: 60_000 }))
    })

    it('H19: degrades to setup_error mentioning the registry when the probe times out', () => {
      vi.mocked(mockSpawnSync).mockReturnValue({
        error: Object.assign(new Error('spawnSync npx ETIMEDOUT'), { code: 'ETIMEDOUT' }),
        status: null,
        signal: 'SIGTERM',
        stdout: '',
        stderr: '',
      } as any)

      sm.startInstall('p1', '/path/to/project')

      const errors = getBroadcastedByType(broadcast, 'setup_error')
      expect(errors).toHaveLength(1)
      expect(errors[0].error).toContain('timed out after 60s')
      expect(errors[0].error).toContain('npm registry unreachable')
      expect(vi.mocked(mockSpawn)).not.toHaveBeenCalled()
    })

    it('fails before spawn when Git is missing from PATH', async () => {
      const prereqs = await import('./setup-prerequisites')
      vi.mocked(prereqs.formatMissingSetupPrerequisites).mockReturnValueOnce(
        '- Git (git) is not on PATH. Install Git and restart Specrails.',
      )

      sm.startInstall('p1', '/path/to/project')

      const errors = getBroadcastedByType(broadcast, 'setup_error')
      expect(errors).toHaveLength(1)
      expect(errors[0].error).toContain('Git')
      expect(errors[0].error).toContain('PATH')
      expect(vi.mocked(mockSpawn)).not.toHaveBeenCalled()
    })

    it('rejects an explicit Core shim whose package cannot be verified before spawn', () => {
      process.env.SPECRAILS_CORE_BIN = 'missing-core'
      sm.startInstall('p1', '/path/to/project')
      expect(mockSpawn).not.toHaveBeenCalled()
      expect(getBroadcastedByType(broadcast, 'setup_error')[0].error).toMatch(/SPECRAILS_CORE_BIN/)
    })

    it('rejects legacy installs even when the child exits 0', async () => {
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(existsSync).mockImplementation((p: any) => {
        const s = String(p)
        return s.includes('.specrails/specrails-version') || s.includes('.specrails/bin/doctor.sh')
      })
      vi.mocked(readFileSync).mockImplementation((p: any) => {
        if (String(p).includes('.specrails/specrails-version')) return '4.0.5\n' as any
        return '# Enrich prompt content' as any
      })

      sm.startInstall('p1', '/path/to/project')
      await finishProcess(child, 0)

      const errors = getBroadcastedByType(broadcast, 'setup_error')
      expect(errors).toHaveLength(1)
      expect(errors[0].error).toContain('legacy')
      expect(errors[0].error).toContain('4.0.5')

      const done = getBroadcastedByType(broadcast, 'setup_install_done')
      expect(done).toHaveLength(0)
    })

    it('passes --root-dir when no config exists (fallback for non-git repos)', () => {
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(existsSync).mockReturnValue(false)

      sm.startInstall('p1', '/non-git/project')

      const [, spawnArgs] = vi.mocked(mockSpawn).mock.calls[0]
      expect(spawnArgs).toContain('--root-dir')
      expect(spawnArgs).toContain('/non-git/project')
    })

    it('does not start install twice for same project', () => {
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      sm.startInstall('p1', '/path/to/project')
      sm.startInstall('p1', '/path/to/project')

      expect(mockSpawn).toHaveBeenCalledTimes(1)
    })

    it('clears install process on close', async () => {
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      sm.startInstall('p1', '/path/to/project')
      expect(sm.isInstalling('p1')).toBe(true)

      await finishProcess(child, 0)
      expect(sm.isInstalling('p1')).toBe(false)
    })
  })

  // ─── startEnrich ───────────────────────────────────────────────────────────

  describe('startEnrich', () => {
    it('completes Core 5 deterministic setup without invoking a removed enrich command', () => {
      vi.mocked(existsSync).mockImplementation((p: any) => /(?:specrails-version|\.claude\/agents|commands\/specrails)$/.test(String(p)))
      vi.mocked(readFileSync).mockImplementation((p: any) => String(p).endsWith('specrails-version') ? '5.0.0' : '')
      vi.mocked(readdirSync).mockImplementation((p: any) => String(p).endsWith('/agents') ? ['sr-architect.md', 'sr-developer.md', 'sr-reviewer.md'] as any : ['implement.md'] as any)
      sm.startEnrich('p1', '/path/to/project', 'claude')
      expect(mockSpawn).not.toHaveBeenCalled()
      expect(getBroadcastedByType(broadcast, 'setup_complete')).toHaveLength(1)
    })
    it('does not report a marker-only Core 5 installation as complete', () => {
      vi.mocked(existsSync).mockImplementation((p: any) => String(p).endsWith('specrails-version'))
      vi.mocked(readFileSync).mockReturnValue('5.0.0')
      sm.startEnrich('p1', '/path/to/project', 'claude')
      expect(mockSpawn).not.toHaveBeenCalled()
      expect(getBroadcastedByType(broadcast, 'setup_complete')).toHaveLength(0)
      expect(getBroadcastedByType(broadcast, 'setup_error')[0].error).toMatch(/repair/)
    })
    it('spawns claude with /specrails:enrich args', () => {
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      sm.startEnrich('p1', '/path/to/project')

      expect(mockSpawn).toHaveBeenCalledWith(
        'claude',
        expect.arrayContaining(['-p', '/specrails:enrich', '--dangerously-skip-permissions']),
        expect.objectContaining({ cwd: '/path/to/project' })
      )
    })

    it('uses /specrails:enrich --from-config when install-config.yaml exists', () => {
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      // Relocate-artifacts: the install config now lives in the per-project HOME
      // dir (basename install-config.yaml), NOT the repo's .specrails.
      vi.mocked(existsSync).mockImplementation((p: any) =>
        String(p).endsWith('install-config.yaml')
      )

      sm.startEnrich('p1', '/path/to/project')

      expect(mockSpawn).toHaveBeenCalledWith(
        'claude',
        expect.arrayContaining(['-p', '/specrails:enrich --from-config']),
        expect.objectContaining({ cwd: '/path/to/project' })
      )
    })

    it('does not start enrich twice', () => {
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      sm.startEnrich('p1', '/path/to/project')
      sm.startEnrich('p1', '/path/to/project')

      expect(mockSpawn).toHaveBeenCalledTimes(1)
    })

    it('deprecated startSetup alias delegates to startEnrich', () => {
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      sm.startSetup('p1', '/path/to/project')

      expect(mockSpawn).toHaveBeenCalledWith(
        'claude',
        expect.arrayContaining(['-p', '/specrails:enrich', '--dangerously-skip-permissions']),
        expect.any(Object)
      )
    })

    it('broadcasts setup_turn_done when claude exits 0 but artifacts incomplete', async () => {
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(existsSync).mockReturnValue(false)

      sm.startEnrich('p1', '/path/to/project')
      pushLine(child, JSON.stringify({ type: 'result', session_id: 'sess-123' }))
      await finishProcess(child, 0)

      const turnDone = getBroadcastedByType(broadcast, 'setup_turn_done')
      expect(turnDone).toHaveLength(1)
      expect(turnDone[0].sessionId).toBe('sess-123')
    })

    it('broadcasts setup_complete when claude exits 0 and artifacts exist', async () => {
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      vi.mocked(existsSync).mockImplementation((p: any) => {
        const s = String(p)
        return s.includes('.claude/agents') || s.includes('.claude/commands/sr')
      })
      vi.mocked(readdirSync).mockImplementation((p: any) => {
        const s = String(p)
        if (s.includes('/agents') && !s.includes('personas')) return ['sr-developer.md'] as any
        if (s.includes('/commands/sr')) return ['implement.md'] as any
        return [] as any
      })

      sm.startEnrich('p1', '/path/to/project')
      pushLine(child, JSON.stringify({ type: 'result', session_id: 'sess-456' }))
      await finishProcess(child, 0)

      const complete = getBroadcastedByType(broadcast, 'setup_complete')
      expect(complete).toHaveLength(1)
      expect(complete[0].summary).toBeDefined()
    })

    it('broadcasts setup_complete with .claude dir when provider is codex', async () => {
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      vi.mocked(existsSync).mockImplementation((p: any) => {
        const s = String(p)
        return s.includes('.claude/agents') || s.includes('.claude/commands/sr')
      })
      vi.mocked(readdirSync).mockImplementation((p: any) => {
        const s = String(p)
        if (s.includes('/agents') && !s.includes('personas')) return ['sr-developer.md'] as any
        if (s.includes('/commands/sr')) return ['implement.md'] as any
        return [] as any
      })

      sm.startEnrich('p1', '/path/to/project', 'codex')
      pushLine(child, 'Enrich complete')
      await finishProcess(child, 0)

      const complete = getBroadcastedByType(broadcast, 'setup_complete')
      expect(complete).toHaveLength(1)
      expect(complete[0].summary).toBeDefined()
    })

    it('broadcasts setup_complete from Kimi native direct-child role and command skills', async () => {
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(readFileSync).mockReturnValue(
        '---\nname: specrails-enrich\ndescription: test\ntype: prompt\n---\nEnrich $ARGUMENTS\n',
      )

      vi.mocked(existsSync).mockImplementation((p: any) => {
        const s = String(p)
        return s.includes('.kimi-code/skills')
          && (
            s.endsWith('/skills')
            || s.endsWith('/skills/sr-architect/SKILL.md')
            || s.endsWith('/skills/specrails-enrich/SKILL.md')
          )
      })
      vi.mocked(readdirSync).mockImplementation((p: any) => {
        const s = String(p)
        if (s.endsWith('.kimi-code/skills')) return ['sr-architect', 'specrails-enrich'] as any
        return [] as any
      })

      sm.startEnrich('p1', '/path/to/project', 'kimi')
      await finishProcess(child, 0)

      const complete = getBroadcastedByType(broadcast, 'setup_complete')
      expect(complete).toHaveLength(1)
      expect(complete[0].summary).toMatchObject({
        provider: 'kimi',
        agents: 1,
        specrailsCommands: 1,
      })
      expect(getBroadcastedByType(broadcast, 'setup_turn_done')).toHaveLength(0)
    })

    it('materializes and spawns Kimi enrich from a relocated workspace with explicit repo access', async () => {
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.spyOn(workspaceResolution, 'resolveProjectExecution').mockReturnValue({
        relocated: true,
        cwd: '/workspace/project-one',
        repoDir: '/repos/project-one',
        workspaceDir: '/workspace/project-one',
        env: { SPECRAILS_REPO_DIR: '/repos/project-one' },
      } as any)
      vi.mocked(existsSync).mockImplementation((p: any) =>
        String(p) === '/workspace/project-one/.kimi-code/skills/specrails-enrich/SKILL.md')
      vi.mocked(readFileSync).mockReturnValue(
        '---\nname: specrails-enrich\ndescription: test\ntype: prompt\n---\nEnrich $ARGUMENTS\n',
      )

      sm.startEnrich('p1', '/repos/project-one', 'kimi')

      const [binary, rawArgs, spawnOptions] = vi.mocked(mockSpawn).mock.calls[0]
      const args = rawArgs as string[]
      expect(binary).toBe('kimi')
      expect(args[args.indexOf('-p') + 1]).toContain('<kimi-skill-loaded')
      expect(args).toEqual(expect.arrayContaining(['--add-dir', '/repos/project-one']))
      expect(spawnOptions).toEqual(expect.objectContaining({
        cwd: '/workspace/project-one',
        env: expect.objectContaining({ SPECRAILS_REPO_DIR: '/repos/project-one' }),
      }))

      // Provider-reported errors are terminal even when an anomalous CLI exits
      // zero; setup must not emit a successful turn/completion.
      pushLine(child, JSON.stringify({
        role: 'meta',
        type: 'system.error',
        message: 'Authentication required. Run kimi login.',
      }))
      await finishProcess(child, 0)
      expect(getBroadcastedByType(broadcast, 'setup_error')).toEqual([
        expect.objectContaining({ error: 'Authentication required. Run kimi login.' }),
      ])
      expect(getBroadcastedByType(broadcast, 'setup_complete')).toHaveLength(0)
      expect(getBroadcastedByType(broadcast, 'setup_turn_done')).toHaveLength(0)
    })

    it('fails closed before spawn when an unrelated Claude tree has no Kimi enrich skill', async () => {
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      vi.mocked(existsSync).mockImplementation((p: any) => {
        const s = String(p)
        return s.includes('.claude/agents') || s.includes('.claude/commands/sr')
      })
      vi.mocked(readdirSync).mockImplementation((p: any) => {
        const s = String(p)
        if (s.includes('/agents') && !s.includes('personas')) return ['sr-developer.md'] as any
        if (s.includes('/commands/sr')) return ['implement.md'] as any
        return [] as any
      })

      sm.startEnrich('p1', '/path/to/project', 'kimi')

      expect(getBroadcastedByType(broadcast, 'setup_complete')).toHaveLength(0)
      expect(getBroadcastedByType(broadcast, 'setup_error')).toEqual([
        expect.objectContaining({
          error: expect.stringContaining('specrails-enrich'),
        }),
      ])
      expect(mockSpawn).not.toHaveBeenCalled()
    })

    it('broadcasts setup_error on non-zero exit', async () => {
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      sm.startEnrich('p1', '/path/to/project')
      await finishProcess(child, 1)

      const errors = getBroadcastedByType(broadcast, 'setup_error')
      expect(errors).toHaveLength(1)
    })

    it('spawns codex with enrich.md content when codex is the detected CLI', () => {
      vi.mocked(detectCLISync).mockReturnValue('codex')
      vi.mocked(readFileSync).mockReturnValue('# Full enrich instructions')
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      sm.startEnrich('p1', '/path/to/project')

      expect(readFileSync).toHaveBeenCalledWith(
        expect.stringContaining('.claude/commands/sr/enrich.md'),
        'utf-8'
      )
      const codexCall = mockSpawn.mock.calls.find((c) => c[0] === 'codex')
      expect(codexCall).toBeDefined()
      const args = codexCall![1] as string[]
      expect(args[0]).toBe('exec')
      expect(args).toContain('--json')
      expect(args.find((a) => a.includes('Full enrich instructions'))).toBeDefined()
    })

    it('falls back to setup.md for codex when enrich.md missing', () => {
      vi.mocked(detectCLISync).mockReturnValue('codex')
      vi.mocked(readFileSync).mockImplementation((p: any) => {
        const s = String(p)
        if (s.includes('enrich.md')) throw new Error('ENOENT')
        return '# Legacy setup content'
      })
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      sm.startEnrich('p1', '/path/to/project')

      // Codex argv (post-§10 adapter-driven): exec --json --sandbox workspace-write --skip-git-repo-check <prompt> --model gpt-5.4-mini
      const codexCall = mockSpawn.mock.calls.find((c) => c[0] === 'codex')
      expect(codexCall).toBeDefined()
      const args = codexCall![1] as string[]
      expect(args[0]).toBe('exec')
      expect(args).toContain('--json')
      expect(args.find((a) => a.includes('Legacy setup content'))).toBeDefined()
      expect((codexCall![2] as { cwd?: string }).cwd).toBe('/path/to/project')
    })

    it('falls back to claude binary when no CLI is detected', () => {
      vi.mocked(detectCLISync).mockReturnValue(null)
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      sm.startEnrich('p1', '/path/to/project')

      expect(mockSpawn).toHaveBeenCalledWith(
        'claude',
        expect.arrayContaining(['-p', '/specrails:enrich']),
        expect.any(Object)
      )
    })

    it('uses explicit provider parameter over detectCLISync', () => {
      vi.mocked(detectCLISync).mockReturnValue('claude')
      vi.mocked(readFileSync).mockReturnValue('# Enrich')
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      sm.startEnrich('p1', '/path/to/project', 'codex')

      const codexCall = mockSpawn.mock.calls.find((c) => c[0] === 'codex')
      expect(codexCall).toBeDefined()
      const args = codexCall![1] as string[]
      expect(args[0]).toBe('exec')
      expect(args).toContain('--json')
      expect(args.find((a) => a.includes('Enrich'))).toBeDefined()
      expect(detectCLISync).not.toHaveBeenCalled()
    })

    it('always pre-creates .claude directories regardless of provider', () => {
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      sm.startEnrich('p1', '/path/to/project', 'codex')

      const mkdirCalls = vi.mocked(mkdirSync).mock.calls.map(([p]) => String(p))
      expect(mkdirCalls.some((p) => p.includes('.claude/agents/personas'))).toBe(true)
      expect(mkdirCalls.some((p) => p.includes('.claude/commands/sr'))).toBe(true)
      expect(mkdirCalls.some((p) => p.includes('.claude/commands/specrails'))).toBe(true)
      expect(mkdirCalls.some((p) => p.includes('.claude/rules'))).toBe(true)
    })

    it('uses explicit claude provider even when codex is detected in PATH', () => {
      vi.mocked(detectCLISync).mockReturnValue('codex')
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      sm.startEnrich('p1', '/path/to/project', 'claude')

      expect(mockSpawn).toHaveBeenCalledWith(
        'claude',
        expect.arrayContaining(['-p', '/specrails:enrich']),
        expect.objectContaining({ cwd: '/path/to/project' })
      )
      expect(detectCLISync).not.toHaveBeenCalled()
    })

    it('captures real codex thread_id from session-started event and calls onSessionCaptured', async () => {
      const onSessionCaptured = vi.fn()
      const smWithCallback = new SetupManager(broadcast, onSessionCaptured)
      vi.mocked(readFileSync).mockReturnValue('# Enrich')
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      smWithCallback.startEnrich('p1', '/path/to/project', 'codex')
      // Feed real codex JSONL with a thread.started event — post-§10 the
      // SetupManager captures the real UUID instead of a synthetic id.
      child.stdout.push('{"type":"thread.started","thread_id":"019e2222-3333-7444-aaaa-bbbbbbbbbbbb"}\n')
      // Give the stream reader a microtask to process
      await new Promise((r) => setImmediate(r))

      expect(onSessionCaptured).toHaveBeenCalledWith('p1', '019e2222-3333-7444-aaaa-bbbbbbbbbbbb')
    })

    it('emits setup_turn_done with real codex thread_id when incomplete', async () => {
      vi.mocked(readFileSync).mockReturnValue('# Enrich')
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(existsSync).mockReturnValue(false)

      sm.startEnrich('p1', '/path/to/project', 'codex')
      child.stdout.push('{"type":"thread.started","thread_id":"019e3333-4444-7555-cccc-dddddddddddd"}\n')
      child.stdout.push('{"type":"item.completed","item":{"type":"agent_message","text":"hi"}}\n')
      child.stdout.push('{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}\n')
      await finishProcess(child, 0)

      const turnDone = getBroadcastedByType(broadcast, 'setup_turn_done')
      expect(turnDone).toHaveLength(1)
      expect(turnDone[0].sessionId).toBe('019e3333-4444-7555-cccc-dddddddddddd')
    })

    it('getInstallTier returns full after startEnrich', () => {
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      sm.startEnrich('p1', '/path/to/project')
      expect(sm.getInstallTier('p1')).toBe('full')
    })
  })

  // ─── resumeEnrich ──────────────────────────────────────────────────────────

  describe('resumeEnrich', () => {
    it('spawns claude with --resume and message', () => {
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      sm.resumeEnrich('p1', '/path', 'sess-abc', 'continue please')

      expect(mockSpawn).toHaveBeenCalledWith(
        'claude',
        expect.arrayContaining(['--resume', 'sess-abc', '-p', 'continue please']),
        expect.any(Object)
      )
    })

    it('deprecated resumeSetup alias delegates to resumeEnrich', () => {
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      sm.resumeSetup('p1', '/path', 'sess-abc', 'continue please')

      expect(mockSpawn).toHaveBeenCalledWith(
        'claude',
        expect.arrayContaining(['--resume', 'sess-abc', '-p', 'continue please']),
        expect.any(Object)
      )
    })

    it('does not resume if already running', () => {
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      sm.resumeEnrich('p1', '/path', 'sess-1', 'msg1')
      sm.resumeEnrich('p1', '/path', 'sess-2', 'msg2')

      expect(mockSpawn).toHaveBeenCalledTimes(1)
    })

    // Legacy synthetic-session fallback: pre-§10 codex sessions used
    // `codex-<projectId>-<timestamp>` ids. Those cannot be resumed against a
    // real codex thread, so resumeEnrich folds enrich.md content into a fresh
    // exec. New codex sessions capture the real thread UUID and take the
    // modern resume path (exercised by the "modern path" tests below).

    it('legacy synthetic session: folds enrich.md content into continuation prompt for codex', () => {
      vi.mocked(detectCLISync).mockReturnValue('claude')
      vi.mocked(readFileSync).mockReturnValue('# Enrich prompt content')
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      // Synthetic id from before §10
      sm.resumeEnrich('p1', '/path', 'codex-p1-1700000000000', 'continue please', 'codex')

      const codexCall = mockSpawn.mock.calls.find((c) => c[0] === 'codex')
      expect(codexCall).toBeDefined()
      const args = codexCall![1] as string[]
      expect(args[0]).toBe('exec')
      expect(args).toContain('--json')
      // No `resume` subcommand — this is a fresh exec
      expect(args).not.toContain('resume')
      // Combined prompt embeds the enrich content + the continuation header + user reply
      const promptArg = args.find((a) => a.includes('continue please'))!
      expect(promptArg).toContain('# Enrich prompt content')
      expect(promptArg).toContain('continuation of a previous enrich run')
      expect(detectCLISync).not.toHaveBeenCalled()
    })

    it('legacy synthetic session: falls back to setup.md when enrich.md is missing', () => {
      vi.mocked(readFileSync).mockImplementation((p: any) => {
        if (String(p).includes('enrich.md')) throw new Error('ENOENT')
        return '# Legacy setup content'
      })
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      sm.resumeEnrich('p1', '/path', 'codex-p1-1700000000001', 'continue please', 'codex')

      const args = vi.mocked(mockSpawn).mock.calls[0][1] as string[]
      const promptArg = args.find((a) => a.includes('continue please'))!
      expect(promptArg).toContain('# Legacy setup content')
    })

    it('legacy synthetic session: falls back to plain user message when both enrich.md and setup.md are missing', () => {
      vi.mocked(readFileSync).mockImplementation(() => { throw new Error('ENOENT') })
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      sm.resumeEnrich('p1', '/path', 'codex-p1-1700000000002', 'continue please', 'codex')

      const args = vi.mocked(mockSpawn).mock.calls[0][1] as string[]
      expect(args[0]).toBe('exec')
      expect(args).toContain('--json')
      expect(args).not.toContain('resume')
      expect(args).toContain('continue please')
    })

    it('modern path: real thread_id uses codex exec resume', () => {
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      // Real codex thread UUID (8-4-4-4-12 hex)
      sm.resumeEnrich('p1', '/path', '019e1111-2222-7333-bbbb-cccccccccccc', 'next turn', 'codex')

      const args = vi.mocked(mockSpawn).mock.calls[0][1] as string[]
      expect(args[0]).toBe('exec')
      expect(args[1]).toBe('resume')
      expect(args).toContain('--json')
      expect(args).toContain('019e1111-2222-7333-bbbb-cccccccccccc')
      expect(args).toContain('next turn')
    })

    it('resumes Kimi from a relocated workspace and preserves explicit repo access', async () => {
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.spyOn(workspaceResolution, 'resolveProjectExecution').mockReturnValue({
        relocated: true,
        cwd: '/workspace/project-one',
        repoDir: '/repos/project-one',
        workspaceDir: '/workspace/project-one',
        env: { SPECRAILS_REPO_DIR: '/repos/project-one' },
      } as any)

      sm.resumeEnrich(
        'p1',
        '/repos/project-one',
        '01KIMI00000000000000000001',
        'continue please',
        'kimi',
      )

      const [binary, rawArgs, spawnOptions] = vi.mocked(mockSpawn).mock.calls[0]
      const args = rawArgs as string[]
      expect(binary).toBe('kimi')
      expect(args).toEqual(expect.arrayContaining([
        '--session=01KIMI00000000000000000001',
        '--add-dir',
        '/repos/project-one',
      ]))
      expect(spawnOptions).toEqual(expect.objectContaining({
        cwd: '/workspace/project-one',
        env: expect.objectContaining({ SPECRAILS_REPO_DIR: '/repos/project-one' }),
      }))

      await finishProcess(child, 1)
    })
  })

  // ─── getCheckpointStatus ───────────────────────────────────────────────────

  describe('getCheckpointStatus', () => {
    it('returns all-pending (7) when no install has started', () => {
      const statuses = sm.getCheckpointStatus('p1', '/path/to/project')
      expect(statuses).toHaveLength(7)
      expect(statuses.every((s) => s.status === 'pending')).toBe(true)
    })

    it('returns 7 checkpoints after startEnrich (full tier)', () => {
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      sm.startEnrich('p1', '/path/to/project')
      const statuses = sm.getCheckpointStatus('p1', '/path/to/project')
      expect(statuses).toHaveLength(7)
    })

    it('returns 3 checkpoints after startInstall with a quick-tier config', () => {
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(existsSync).mockImplementation((p: any) => String(p).includes('install-config.yaml'))
      vi.mocked(readFileSync).mockReturnValue('version: 1\ntier: quick\nagents:\n  selected: [sr-architect]' as any)

      sm.startInstall('p1', '/path/to/project')
      const statuses = sm.getCheckpointStatus('p1', '/path/to/project')
      expect(statuses).toHaveLength(3)
    })
  })

  // ─── checkFilesystem new paths ─────────────────────────────────────────────

  describe('checkFilesystem new .specrails/ paths', () => {
    it('detects base_install from .specrails/specrails-version (new path)', () => {
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      vi.mocked(existsSync).mockImplementation((p: any) => {
        const s = String(p)
        return s.includes('.specrails/specrails-version')
      })

      sm.startEnrich('p1', '/path/to/project')
      const statuses = sm.getCheckpointStatus('p1', '/path/to/project')
      const baseInstall = statuses.find((s) => s.key === 'base_install')
      expect(baseInstall?.status).toBe('done')
    })

    it('detects base_install from legacy .specrails-version (backward compat)', () => {
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      vi.mocked(existsSync).mockImplementation((p: any) => {
        const s = String(p)
        return s.endsWith('.specrails-version') && !s.includes('.specrails/specrails-version')
      })

      sm.startEnrich('p1', '/path/to/project')
      const statuses = sm.getCheckpointStatus('p1', '/path/to/project')
      const baseInstall = statuses.find((s) => s.key === 'base_install')
      expect(baseInstall?.status).toBe('done')
    })

    it('detects codebase_analysis from .specrails/setup-templates (new path)', () => {
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      vi.mocked(existsSync).mockImplementation((p: any) => {
        const s = String(p)
        return s.includes('.specrails/specrails-version') || s.includes('.specrails/setup-templates')
      })

      sm.startEnrich('p1', '/path/to/project')
      const statuses = sm.getCheckpointStatus('p1', '/path/to/project')
      const codebaseAnalysis = statuses.find((s) => s.key === 'codebase_analysis')
      expect(codebaseAnalysis?.status).toBe('done')
    })

    it('completes Kimi agent and command checkpoints from .kimi-code skills', () => {
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(existsSync).mockImplementation((p: any) => {
        const s = String(p)
        return s.includes('.kimi-code/skills')
          && (
            s.endsWith('/skills')
            || s.endsWith('/skills/sr-developer/SKILL.md')
            || s.endsWith('/skills/specrails-doctor/SKILL.md')
          )
      })
      vi.mocked(readdirSync).mockImplementation((p: any) => {
        const s = String(p)
        if (s.endsWith('.kimi-code/skills')) return ['sr-developer', 'specrails-doctor'] as any
        return [] as any
      })

      sm.startEnrich('p1', '/path/to/project', 'kimi')
      const statuses = sm.getCheckpointStatus('p1', '/path/to/project')
      expect(statuses.find((s) => s.key === 'agent_generation')?.status).toBe('done')
      expect(statuses.find((s) => s.key === 'command_generation')?.status).toBe('done')
    })
  })

  // ─── Checkpoint detection from stream ──────────────────────────────────────

  describe('checkpoint detection from stream events', () => {
    it('detects codebase_analysis from assistant text', async () => {
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      sm.startEnrich('p1', '/path/to/project')

      const event = JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Starting Phase 1: codebase analysis of your project' }] },
      })
      pushLine(child, event)

      await new Promise((r) => setImmediate(r))

      const checkpointMsgs = getBroadcastedByType(broadcast, 'setup_checkpoint')
      const codebaseAnalysis = checkpointMsgs.find((m) => m.checkpoint === 'codebase_analysis')
      expect(codebaseAnalysis).toBeDefined()
      expect(codebaseAnalysis?.status).toBe('running')
    })

    it('detects agent_generation from tool_use event', async () => {
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      sm.startEnrich('p1', '/path/to/project')

      const event = JSON.stringify({
        type: 'tool_use',
        input: { file_path: '.claude/agents/sr-developer.md' },
      })
      pushLine(child, event)

      await new Promise((r) => setImmediate(r))

      const checkpointMsgs = getBroadcastedByType(broadcast, 'setup_checkpoint')
      const agentGen = checkpointMsgs.find((m) => m.checkpoint === 'agent_generation')
      expect(agentGen).toBeDefined()
    })

    it('detects base_install from new specrails/specrails-version path in tool_use', async () => {
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      sm.startEnrich('p1', '/path/to/project')

      const event = JSON.stringify({
        type: 'tool_use',
        input: { file_path: '.specrails/specrails-version' },
      })
      pushLine(child, event)

      await new Promise((r) => setImmediate(r))

      const checkpointMsgs = getBroadcastedByType(broadcast, 'setup_checkpoint')
      const baseInstall = checkpointMsgs.find((m) => m.checkpoint === 'base_install')
      expect(baseInstall).toBeDefined()
    })

    it('detects command_generation from new specrails/specrails-manifest.json path in tool_use', async () => {
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      sm.startEnrich('p1', '/path/to/project')

      const event = JSON.stringify({
        type: 'tool_use',
        input: { file_path: '.specrails/specrails-manifest.json' },
      })
      pushLine(child, event)

      await new Promise((r) => setImmediate(r))

      const checkpointMsgs = getBroadcastedByType(broadcast, 'setup_checkpoint')
      const commandGeneration = checkpointMsgs.find((m) => m.checkpoint === 'command_generation')
      expect(commandGeneration).toBeDefined()
    })
  })

  // ─── Abort ──────────────────────────────────────────────────────────────────

  describe('abort', () => {
    it('kills install process and clears state', () => {
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      sm.startInstall('p1', '/path/to/project')
      sm.abort('p1')

      expect(treeKill).toHaveBeenCalledWith(child.pid, 'SIGTERM')
      expect(sm.isInstalling('p1')).toBe(false)
    })

    it('kills enrich process and clears state', () => {
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      sm.startEnrich('p1', '/path/to/project')
      sm.abort('p1')

      expect(treeKill).toHaveBeenCalledWith(child.pid, 'SIGTERM')
      expect(sm.isEnriching('p1')).toBe(false)
    })

    it('clears install tier on abort', () => {
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      sm.startEnrich('p1', '/path/to/project')
      expect(sm.getInstallTier('p1')).toBe('full')
      sm.abort('p1')
      expect(sm.getInstallTier('p1')).toBeUndefined()
    })

    it('does nothing if no processes running', () => {
      expect(() => sm.abort('p1')).not.toThrow()
      expect(treeKill).not.toHaveBeenCalled()
    })

    it('escalates SIGTERM to SIGKILL after the grace window for a child that ignores SIGTERM', () => {
      vi.useFakeTimers()
      try {
        const child = createMockChildProcess()
        vi.mocked(mockSpawn).mockReturnValue(child as any)
        sm.startInstall('p1', '/path/to/project')
        sm.abort('p1')
        expect(treeKill).toHaveBeenCalledWith(child.pid, 'SIGTERM')
        // No SIGKILL before the grace window.
        expect(vi.mocked(treeKill).mock.calls.some((c) => c[1] === 'SIGKILL')).toBe(false)
        vi.advanceTimersByTime(5000)
        expect(vi.mocked(treeKill).mock.calls.some((c) => c[1] === 'SIGKILL')).toBe(true)
      } finally {
        vi.useRealTimers()
      }
    })
  })

  // ─── Stderr handling ───────────────────────────────────────────────────────

  describe('stderr handling', () => {
    it('broadcasts stderr as setup_log for install', async () => {
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      sm.startInstall('p1', '/path/to/project')

      // Push to stderr
      child.stderr.push('Warning: something\n')

      await new Promise((r) => setImmediate(r))

      const logs = getBroadcastedByType(broadcast, 'setup_log')
      const stderrLogs = logs.filter((l) => l.stream === 'stderr')
      expect(stderrLogs.length).toBeGreaterThan(0)
    })
  })

  // ─── Setup chat broadcast ──────────────────────────────────────────────────

  describe('setup chat broadcast', () => {
    it('broadcasts setup_chat for assistant text during enrich', async () => {
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      sm.startEnrich('p1', '/path/to/project')

      const event = JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Hello from enrich!' }] },
      })
      pushLine(child, event)

      await new Promise((r) => setImmediate(r))

      const chatMsgs = getBroadcastedByType(broadcast, 'setup_chat')
      expect(chatMsgs.length).toBeGreaterThan(0)
      expect(chatMsgs[0].text).toBe('Hello from enrich!')
      expect(chatMsgs[0].role).toBe('assistant')
    })
  })

  // ─── getSummary / computeSummary ────────────────────────────────────────────
  // Regression tests for: "App shows 0 Agents, 0 Personas, 0 Specs after install"
  // Root cause: three places in SetupWizard.tsx hardcoded { agents:0, personas:0, commands:0 }
  // Fix: computeSummary() now called in setup_install_done broadcasts; getSummary() is public.

  describe('getSummary', () => {
    it('returns zeros when no .claude/ directory exists', () => {
      vi.mocked(existsSync).mockReturnValue(false)
      vi.mocked(readdirSync).mockReturnValue([])

      const result = sm.getSummary({ path: '/path/to/project' })
      expect(result).toMatchObject({ agents: 0, personas: 0, specrailsCommands: 0, opsxCommands: 0 })
      expect(result).not.toHaveProperty('commands')
    })

    it('counts sr-*.md files as agents', () => {
      vi.mocked(existsSync).mockImplementation((p: any) =>
        String(p).includes('.claude/agents')
      )
      vi.mocked(readdirSync).mockImplementation((p: any) => {
        if (String(p).endsWith('.claude/agents')) {
          return ['sr-architect.md', 'sr-developer.md', 'sr-reviewer.md', 'not-an-agent.md'] as any
        }
        return []
      })

      const result = sm.getSummary({ path: '/path/to/project' })
      expect(result.agents).toBe(3)
      expect(result.personas).toBe(0)
      expect(result.specrailsCommands).toBe(0)
      expect(result.opsxCommands).toBe(0)
    })

    it('counts .md files in agents/personas/ as personas', () => {
      vi.mocked(existsSync).mockImplementation((p: any) => {
        const s = String(p)
        return s.includes('.claude/agents')
      })
      vi.mocked(readdirSync).mockImplementation((p: any) => {
        const s = String(p)
        if (s.endsWith('.claude/agents')) return ['sr-architect.md'] as any
        if (s.includes('agents/personas')) return ['the-builder.md', 'the-maintainer.md'] as any
        return []
      })

      const result = sm.getSummary({ path: '/path/to/project' })
      expect(result.personas).toBe(2)
    })

    it('counts .md files in commands/specrails/ as specrailsCommands', () => {
      vi.mocked(existsSync).mockImplementation((p: any) =>
        String(p).includes('commands/specrails')
      )
      vi.mocked(readdirSync).mockImplementation((p: any) => {
        if (String(p).includes('commands/specrails')) {
          return ['implement.md', 'batch-implement.md', 'propose-spec.md'] as any
        }
        return []
      })

      const result = sm.getSummary({ path: '/path/to/project' })
      expect(result.specrailsCommands).toBe(3)
      expect(result.opsxCommands).toBe(0)
      expect(result).not.toHaveProperty('commands')
    })

    it('counts .md files in commands/opsx/ as opsxCommands', () => {
      vi.mocked(existsSync).mockImplementation((p: any) =>
        String(p).includes('commands/opsx')
      )
      vi.mocked(readdirSync).mockImplementation((p: any) => {
        if (String(p).includes('commands/opsx')) {
          return ['deploy.md', 'rollback.md'] as any
        }
        return []
      })

      const result = sm.getSummary({ path: '/path/to/project' })
      expect(result.opsxCommands).toBe(2)
      expect(result.specrailsCommands).toBe(0)
    })

    it('does not count non-.md files in commands/specrails/', () => {
      vi.mocked(existsSync).mockImplementation((p: any) =>
        String(p).includes('commands/specrails')
      )
      vi.mocked(readdirSync).mockImplementation((p: any) => {
        if (String(p).includes('commands/specrails')) {
          return ['implement.md', 'README.txt', '.DS_Store'] as any
        }
        return []
      })

      const result = sm.getSummary({ path: '/path/to/project' })
      expect(result.specrailsCommands).toBe(1)
    })

    it('returns zeros and does not throw when readdirSync throws', () => {
      vi.mocked(existsSync).mockReturnValue(true)
      vi.mocked(readdirSync).mockImplementation(() => {
        throw new Error('EACCES: permission denied')
      })

      expect(() => sm.getSummary({ path: '/path/to/project' })).not.toThrow()
      const result = sm.getSummary({ path: '/path/to/project' })
      expect(result).toMatchObject({ agents: 0, personas: 0, specrailsCommands: 0, opsxCommands: 0 })
    })

    it('counts all categories together', () => {
      vi.mocked(existsSync).mockReturnValue(true)
      vi.mocked(readdirSync).mockImplementation((p: any) => {
        const s = String(p)
        if (s.endsWith('.claude/agents')) return ['sr-architect.md', 'sr-developer.md'] as any
        if (s.includes('agents/personas')) return ['the-builder.md'] as any
        if (s.includes('commands/specrails')) return ['implement.md', 'batch-implement.md'] as any
        if (s.includes('commands/opsx')) return ['deploy.md'] as any
        return []
      })

      const result = sm.getSummary({ path: '/path/to/project' })
      expect(result).toMatchObject({ agents: 2, personas: 1, specrailsCommands: 2, opsxCommands: 1 })
    })

    it('reads Kimi artefacts from the relocated workspace after a project is reopened', () => {
      vi.spyOn(workspaceResolution, 'resolveProjectExecution').mockReturnValue({
        relocated: true,
        cwd: '/workspace/project-one',
        repoDir: '/repos/project-one',
        workspaceDir: '/workspace/project-one',
        env: { SPECRAILS_REPO_DIR: '/repos/project-one' },
      } as any)
      vi.mocked(readFileSync).mockReturnValue(
        'version: 1\nprovider: kimi\ntier: quick\nagents:\n  selected: [sr-architect]\n',
      )

      const probed: string[] = []
      vi.mocked(existsSync).mockImplementation((p: any) => {
        const candidate = String(p)
        probed.push(candidate)
        return candidate === '/workspace/project-one/.kimi-code/skills'
          || candidate === '/workspace/project-one/.kimi-code/skills/sr-architect/SKILL.md'
          || candidate === '/workspace/project-one/.kimi-code/skills/specrails-implement/SKILL.md'
      })
      vi.mocked(readdirSync).mockImplementation((p: any) =>
        String(p) === '/workspace/project-one/.kimi-code/skills'
          ? ['sr-architect', 'specrails-implement'] as any
          : [] as any
      )

      const result = sm.getSummary({
        slug: 'project-one',
        path: '/repos/project-one',
      })

      expect(result).toMatchObject({
        provider: 'kimi',
        tier: 'quick',
        agents: 1,
        specrailsCommands: 1,
      })
      expect(probed.some((candidate) =>
        candidate.startsWith('/workspace/project-one/.kimi-code/'),
      )).toBe(true)
      expect(probed.some((candidate) =>
        candidate.startsWith('/repos/project-one/.kimi-code/'),
      )).toBe(false)
    })
  })

  // ─── computeSummary (unit tests for new shape) ─────────────────────────────

  describe('computeSummary', () => {
    it('returns specrailsCommands > 0 and opsxCommands === 0 when only specrails/ exists', () => {
      vi.mocked(existsSync).mockImplementation((p: any) =>
        String(p).includes('commands/specrails')
      )
      vi.mocked(readdirSync).mockImplementation((p: any) => {
        if (String(p).includes('commands/specrails')) {
          return ['implement.md', 'propose-spec.md', 'batch.md'] as any
        }
        return []
      })

      const result = computeSummary('/path/to/project', 'quick')
      expect(result.specrailsCommands).toBeGreaterThan(0)
      expect(result.opsxCommands).toBe(0)
      expect(result).not.toHaveProperty('commands')
    })

    it('returns both namespace counts when both directories exist, and commands field is absent', () => {
      vi.mocked(existsSync).mockImplementation((p: any) => {
        const s = String(p)
        return s.includes('commands/specrails') || s.includes('commands/opsx')
      })
      vi.mocked(readdirSync).mockImplementation((p: any) => {
        const s = String(p)
        if (s.includes('commands/specrails')) return ['implement.md', 'why.md'] as any
        if (s.includes('commands/opsx')) return ['deploy.md', 'rollback.md', 'status.md'] as any
        return []
      })

      const result = computeSummary('/path/to/project', 'full')
      expect(result.specrailsCommands).toBe(2)
      expect(result.opsxCommands).toBe(3)
      expect(result).not.toHaveProperty('commands')
    })

    it('carries the tier parameter through to the summary', () => {
      vi.mocked(existsSync).mockReturnValue(false)
      vi.mocked(readdirSync).mockReturnValue([])

      expect(computeSummary('/path', 'quick').tier).toBe('quick')
      expect(computeSummary('/path', 'full').tier).toBe('full')
    })

    // Gemini installs into `.gemini/` and ships TOML slash commands — the summary
    // must probe that layout, not the hardcoded `.claude/` + `.md` one.
    it('reads the .gemini/ layout and counts .toml commands for gemini', () => {
      vi.mocked(existsSync).mockImplementation((p: any) => {
        const s = String(p)
        if (s.endsWith('personas')) return false
        return s.includes('.gemini/agents') ||
          s.includes('.gemini/commands/specrails') ||
          s.includes('.gemini/commands/opsx')
      })
      vi.mocked(readdirSync).mockImplementation((p: any) => {
        const s = String(p)
        if (s.includes('.gemini/agents')) return ['sr-architect.md', 'sr-developer.md', 'sr-reviewer.md'] as any
        if (s.includes('.gemini/commands/specrails')) return ['implement.toml', 'propose-spec.toml'] as any
        if (s.includes('.gemini/commands/opsx')) return ['apply.toml'] as any
        return []
      })

      const result = computeSummary('/path/to/project', 'quick', 'gemini')
      expect(result.agents).toBe(3)
      expect(result.specrailsCommands).toBe(2)
      expect(result.opsxCommands).toBe(1)
      expect(result.provider).toBe('gemini')
    })

    it('counts only TOML files in gemini command dirs — ignores stray .md', () => {
      vi.mocked(existsSync).mockImplementation((p: any) => String(p).includes('.gemini/commands/specrails'))
      vi.mocked(readdirSync).mockImplementation((p: any) =>
        String(p).includes('.gemini/commands/specrails') ? ['a.toml', 'b.toml', 'README.md'] as any : []
      )

      expect(computeSummary('/path', 'quick', 'gemini').specrailsCommands).toBe(2)
    })

    it('does NOT fall back to the .claude/ layout for a gemini install (regression)', () => {
      // Only `.claude/` artefacts exist on disk. A gemini install must report 0,
      // never surface claude's counts — the bug this fix addresses.
      vi.mocked(existsSync).mockImplementation((p: any) => String(p).includes('.claude'))
      vi.mocked(readdirSync).mockImplementation((p: any) =>
        String(p).includes('.claude') ? ['sr-architect.md', 'sr-developer.md'] as any : []
      )

      const result = computeSummary('/path', 'quick', 'gemini')
      expect(result.agents).toBe(0)
      expect(result.specrailsCommands).toBe(0)
      expect(result.opsxCommands).toBe(0)
    })

    it('counts Kimi direct-child skills and provider-local VPC personas', () => {
      vi.mocked(existsSync).mockImplementation((p: any) => {
        const s = String(p)
        return s.endsWith('.kimi-code/skills')
          || s.endsWith('.kimi-code/personas')
          || s.endsWith('/sr-architect/SKILL.md')
          || s.endsWith('/specrails-enrich/SKILL.md')
          || s.endsWith('/openspec-apply-change/SKILL.md')
      })
      vi.mocked(readdirSync).mockImplementation((p: any) => {
        const s = String(p)
        if (s.endsWith('.kimi-code/skills')) {
          return ['sr-architect', 'specrails-enrich', 'openspec-apply-change'] as any
        }
        if (s.endsWith('.kimi-code/personas')) {
          return ['the-builder.md', 'the-maintainer.md', 'README.txt'] as any
        }
        return [] as any
      })

      expect(computeSummary('/path', 'full', 'kimi')).toMatchObject({
        provider: 'kimi',
        tier: 'full',
        agents: 1,
        personas: 2,
        specrailsCommands: 1,
        opsxCommands: 1,
      })
    })
  })

  // ─── sweepLegacySrCommands ─────────────────────────────────────────────────

  describe('sweepLegacySrCommands', () => {
    it('returns the count of .md files and removes the sr/ directory', () => {
      vi.mocked(existsSync).mockImplementation((p: any) =>
        String(p).includes('commands/sr')
      )
      vi.mocked(readdirSync).mockImplementation((p: any) => {
        if (String(p).includes('commands/sr')) return ['a.md', 'b.md'] as any
        return []
      })

      const count = sweepLegacySrCommands('/path/to/project')
      expect(count).toBe(2)
      expect(vi.mocked(rmSync)).toHaveBeenCalledWith(
        expect.stringContaining('commands/sr'),
        { recursive: true, force: true }
      )
    })

    it('returns 0 and does not call rmSync when sr/ does not exist', () => {
      vi.mocked(existsSync).mockReturnValue(false)

      const count = sweepLegacySrCommands('/path/to/project')
      expect(count).toBe(0)
      expect(vi.mocked(rmSync)).not.toHaveBeenCalled()
    })

    it('returns 0 and does not throw when rmSync throws a permission error', () => {
      vi.mocked(existsSync).mockImplementation((p: any) =>
        String(p).includes('commands/sr')
      )
      vi.mocked(readdirSync).mockImplementation((p: any) => {
        if (String(p).includes('commands/sr')) return ['a.md'] as any
        return []
      })
      vi.mocked(rmSync).mockImplementation(() => { throw new Error('EACCES: permission denied') })

      expect(() => sweepLegacySrCommands('/path/to/project')).not.toThrow()
      const count = sweepLegacySrCommands('/path/to/project')
      expect(count).toBe(0)
    })
  })

  // ─── setup_install_done includes summary ────────────────────────────────────

  describe('setup_install_done includes summary (regression: was hardcoded zeros)', () => {
    it('startInstall broadcasts setup_install_done with summary field', async () => {
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      // Simulate 3 agents installed
      vi.mocked(existsSync).mockImplementation((p: any) =>
        String(p).includes('.claude/agents')
      )
      vi.mocked(readdirSync).mockImplementation((p: any) => {
        if (String(p).endsWith('.claude/agents'))
          return ['sr-architect.md', 'sr-developer.md', 'sr-reviewer.md'] as any
        return []
      })

      sm.startInstall('p1', '/path/to/project')
      await finishProcess(child, 0)

      const done = getBroadcastedByType(broadcast, 'setup_install_done')
      expect(done).toHaveLength(1)
      expect(done[0]).toHaveProperty('summary')
      expect(done[0].summary).toMatchObject({
        agents: expect.any(Number),
        personas: expect.any(Number),
        specrailsCommands: expect.any(Number),
        opsxCommands: expect.any(Number),
      })
      expect(done[0].summary).not.toHaveProperty('commands')
      // Crucially: agents should be non-zero (not the old hardcoded 0)
      expect(done[0].summary.agents).toBe(3)
    })

    it('startEnrich broadcasts setup_complete with summary field (enrich done)', async () => {
      // startEnrich emits 'setup_complete' (not 'setup_install_done') when Claude finishes.
      // setup_complete is gated on hasAgents && hasCommands being true.
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(existsSync).mockReturnValue(true)
      vi.mocked(readdirSync).mockImplementation((p: any) => {
        const s = String(p)
        if (s.endsWith('.claude/agents')) return ['sr-architect.md', 'sr-developer.md'] as any
        if (s.includes('agents/personas')) return ['the-builder.md'] as any
        if (s.includes('commands/sr')) return ['implement.md'] as any
        return []
      })

      sm.startEnrich('p1', '/path/to/project')
      await finishProcess(child, 0)

      const complete = getBroadcastedByType(broadcast, 'setup_complete')
      expect(complete).toHaveLength(1)
      expect(complete[0]).toHaveProperty('summary')
      expect(complete[0].summary).toMatchObject({ agents: 2, personas: 1 })
      expect(complete[0].summary).not.toHaveProperty('commands')
    })

    it('startEnrich broadcasts setup_complete when commands are in commands/specrails/ (regression: wizard was stuck)', async () => {
      // Regression test for SPEA-751: specrails-core installs commands in commands/specrails/
      // but the completion check was only looking at commands/sr/ → setup_turn_done was sent
      // instead of setup_complete → wizard stayed stuck on the enriching step.
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(existsSync).mockImplementation((p: any) => {
        const s = String(p)
        return s.includes('.claude/agents') || s.includes('commands/specrails')
      })
      vi.mocked(readdirSync).mockImplementation((p: any) => {
        const s = String(p)
        if (s.endsWith('.claude/agents')) return ['sr-architect.md', 'sr-developer.md'] as any
        if (s.includes('commands/specrails')) return ['implement.md', 'propose-spec.md'] as any
        return []
      })

      sm.startEnrich('p1', '/path/to/project')
      await finishProcess(child, 0)

      const complete = getBroadcastedByType(broadcast, 'setup_complete')
      expect(complete).toHaveLength(1)
      expect(complete[0].summary).toMatchObject({ agents: 2, personas: 0, specrailsCommands: 2, opsxCommands: 0 })
      expect(complete[0].summary).not.toHaveProperty('commands')
      // Should NOT have emitted setup_turn_done (which would leave wizard stuck)
      const turnDone = getBroadcastedByType(broadcast, 'setup_turn_done')
      expect(turnDone).toHaveLength(0)
    })

    it('summary falls back to zeros when agents dir does not exist', async () => {
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(existsSync).mockReturnValue(false)
      vi.mocked(readdirSync).mockReturnValue([])

      sm.startInstall('p1', '/path/to/project')
      await finishProcess(child, 0)

      const done = getBroadcastedByType(broadcast, 'setup_install_done')
      expect(done[0].summary).toMatchObject({ agents: 0, personas: 0, specrailsCommands: 0, opsxCommands: 0 })
      expect(done[0].summary).not.toHaveProperty('commands')
    })
  })

  // ─── Quick-tier post-install behaviour ───────────────────────────────────────

  describe('quick-tier post-install behaviour', () => {
    const quickConfig = [
      'version: 1',
      'tier: quick',
      'agents:',
      '  selected: [sr-architect, sr-developer]',
    ].join('\n')

    it('startInstall reads tier from config but leaves quick-tier placement to specrails-core', async () => {
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(existsSync).mockImplementation((p) => {
        const s = String(p)
        if (s.includes('install-config.yaml')) return true
        if (s.includes('setup-templates/agents')) return true
        if (s.includes('setup-templates/personas')) return false
        if (s.includes('setup-templates/commands/specrails')) return false
        return false
      })
      vi.mocked(readFileSync).mockReturnValue(quickConfig)
      vi.mocked(readdirSync).mockImplementation((p) => {
        const s = String(p)
        if (s.includes('setup-templates/agents')) return ['sr-architect.md', 'sr-developer.md'] as any
        return []
      })

      sm.startInstall('p1', '/path/to/project')
      await finishProcess(child, 0)

      expect(vi.mocked(copyFileSync).mock.calls).toHaveLength(0)
    })

    it('startInstall does not re-copy templates for full tier (enrich handles it)', async () => {
      const fullConfig = 'version: 1\ntier: full\nagents:\n  selected: [sr-architect]'
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)
      vi.mocked(existsSync).mockImplementation((p) => {
        const s = String(p)
        if (s.includes('install-config.yaml')) return true
        return false
      })
      vi.mocked(readFileSync).mockReturnValue(fullConfig)

      sm.startInstall('p1', '/path/to/project')
      await finishProcess(child, 0)

      const copyCalls = vi.mocked(copyFileSync).mock.calls
      expect(copyCalls).toHaveLength(0)
    })
  })

  // ─── ai_invocations recording (COST-ACCOUNTING-AUDIT LOW-2) ──────────────────

  describe('setup AI turn recording (surface=setup)', () => {
    let db: DbInstance
    let smRec: SetupManager

    function assistantUsageLine(text: string, usage: Record<string, number>, model = 'claude-sonnet-4-6', id = 'msg-1') {
      return JSON.stringify({
        type: 'assistant',
        message: { id, model, usage, content: [{ type: 'text', text }] },
      })
    }
    function resultCostLine(sessionId: string, opts: Record<string, unknown>) {
      return JSON.stringify({ type: 'result', session_id: sessionId, ...opts })
    }
    function rows() {
      return db.prepare('SELECT * FROM ai_invocations ORDER BY started_at ASC').all() as Array<Record<string, unknown>>
    }

    beforeEach(() => {
      vi.mocked(detectCLISync).mockReturnValue('claude')
      db = initDb(':memory:')
      // Accessor resolves the per-project DB lazily at record time.
      smRec = new SetupManager(broadcast, undefined, undefined, () => db)
    })

    it('records a success row with native cost on a clean enrich turn', async () => {
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      smRec.startEnrich('p1', '/path/to/project')
      pushLine(child, assistantUsageLine('enriching', { input_tokens: 100, output_tokens: 50 }))
      pushLine(child, resultCostLine('sess-1', { total_cost_usd: 0.75, usage: { input_tokens: 100, output_tokens: 50 } }))
      await finishProcess(child, 0)

      const r = rows()
      expect(r).toHaveLength(1)
      expect(r[0].surface).toBe('setup')
      expect(r[0].surface_ref_id).toBe('p1')
      expect(r[0].status).toBe('success')
      expect(r[0].total_cost_usd).toBe(0.75)
      expect(r[0].total_cost_usd_estimated).toBe(0)
      expect(getBroadcastedByType(broadcast, 'spending.invalidated')).toHaveLength(1)
    })

    it('records an estimated-cost failed row on non-zero exit (no result event)', async () => {
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      smRec.startEnrich('p1', '/path/to/project')
      pushLine(child, assistantUsageLine('working', { input_tokens: 3000, output_tokens: 1500 }))
      await finishProcess(child, 1)

      const r = rows()
      expect(r).toHaveLength(1)
      expect(r[0].status).toBe('failed')
      expect(r[0].total_cost_usd_estimated).toBe(1)
      expect(r[0].total_cost_usd as number).toBeGreaterThan(0)
    })

    it('records nothing when no DB accessor is supplied (byte-identical)', async () => {
      const smNoDb = new SetupManager(broadcast)
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      smNoDb.startEnrich('p1', '/path/to/project')
      pushLine(child, resultCostLine('sess-1', { total_cost_usd: 0.75 }))
      await finishProcess(child, 0)

      expect(rows()).toHaveLength(0)
    })

    it('records nothing when the accessor returns null (DB not created yet)', async () => {
      const smNullDb = new SetupManager(broadcast, undefined, undefined, () => null)
      const child = createMockChildProcess()
      vi.mocked(mockSpawn).mockReturnValue(child as any)

      smNullDb.startEnrich('p1', '/path/to/project')
      pushLine(child, resultCostLine('sess-1', { total_cost_usd: 0.75 }))
      await finishProcess(child, 0)

      expect(rows()).toHaveLength(0)
    })
  })
})

// ─────────────────────────────────────────────────────────────────
// detectCheckpointFromText — stdout regex contract.
// Locks down the matchers that translate specrails-core stdout into
// setup-wizard checkpoint advancement. Both the retired bash phrasing
// AND the Node installer (≥ 4.2.0) phrasing must hit; regressing
// either side breaks the live setup wizard progress UI silently.
// ─────────────────────────────────────────────────────────────────

import { detectCheckpointFromText } from './setup-manager'

describe('detectCheckpointFromText', () => {
  const keys = (line: string): string[] =>
    detectCheckpointFromText(line).map((h) => h.key)

  it('matches the Node installer "Loaded install config" sentinel → config_written', () => {
    expect(keys('  → Loaded install config from /tmp/repo/.specrails/install-config.yaml'))
      .toContain('config_written')
  })

  it('matches the retired bash "✓ config loaded" line → config_written', () => {
    expect(keys('  ✓ config loaded')).toContain('config_written')
  })

  it('matches the Node installer "Phase 2 & 3" header → agent_generation', () => {
    expect(keys('Phase 2 & 3: Installing specrails artifacts'))
      .toContain('agent_generation')
  })

  it('matches "Placing agents and commands" (quick tier) → agent_generation', () => {
    expect(keys('Phase 3c: Placing agents and commands (quick install)'))
      .toContain('agent_generation')
  })

  it('matches the "Writing manifest" Node step → command_generation', () => {
    expect(keys('Phase 3b: Writing manifest')).toContain('command_generation')
  })

  it('matches "Wrote ...specrails-manifest.json" path log → command_generation', () => {
    expect(keys('  ✓ Wrote .specrails/specrails-manifest.json'))
      .toContain('command_generation')
  })

  it('matches the Node installer terminal "init complete" sentinel → quick_complete', () => {
    expect(keys('  ✓ init complete')).toContain('quick_complete')
  })

  it('matches the Node installer terminal "update complete" sentinel → quick_complete', () => {
    expect(keys('  ✓ update complete')).toContain('quick_complete')
  })

  it('matches the retired bash "installation complete" line → quick_complete', () => {
    expect(keys('Installation complete')).toContain('quick_complete')
  })

  it('matches enrich phase 1 / codebase analysis → codebase_analysis', () => {
    expect(keys('Phase 1: codebase analysis')).toContain('codebase_analysis')
  })

  it('matches the .specrails/specrails-version path log → base_install', () => {
    expect(keys('  ✓ Wrote .specrails/specrails-version')).toContain('base_install')
  })

  it('matches a Kimi direct-child rail skill → agent_generation', () => {
    expect(keys('Writing .kimi-code/skills/sr-reviewer/SKILL.md'))
      .toContain('agent_generation')
  })

  it('matches a Kimi command skill → command_generation', () => {
    expect(keys('Writing .kimi-code/skills/specrails-doctor/SKILL.md'))
      .toContain('command_generation')
  })

  it('returns no hits on unrelated noise', () => {
    expect(detectCheckpointFromText('hello world this is not specrails')).toEqual([])
  })
})
