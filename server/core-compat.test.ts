import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import path from 'path'
import os from 'os'
import fs from 'fs'

// Mock child_process before importing the module under test
vi.mock('child_process', () => ({ execSync: vi.fn() }))

import {
  checkCoreCompat,
  coreCompatSupportsProvider,
  findCoreContract,
  detectCLI,
  detectCLISync,
  getCLIStatus,
} from './core-compat'
import { execSync } from 'child_process'

// Minimal valid contract matching app constants
const COMPATIBLE_CONTRACT = {
  schemaVersion: '1',
  coreVersion: '1.0.0',
  minimumHubVersion: '1.0.0', // legacy field name frozen in the specrails-core contract
  cli: { initArgs: [], updateArgs: [] },
  checkpoints: [
    'base_install',
    'agent_selection',
    'codebase_analysis',
    'vpc_discovery',
    'agent_generation',
    'persona_synthesis',
    'command_generation',
  ],
  commands: [
    'implement',
    'batch-implement',
    'why',
    'product-backlog',
    'update-product-driven-backlog',
    'refactor-recommender',
    'health-check',
    'compat-check',
    'enrich',
  ],
}

/**
 * Write contract JSON to a temp dir as `<tmpDir>/specrails-core/integration-contract.json`
 * and mock execSync to return tmpDir (simulating `npm root -g`).
 */
function setupContractInTmpDir(contract: object, tmpDir: string): string {
  const coreDir = path.join(tmpDir, 'specrails-core')
  fs.mkdirSync(coreDir, { recursive: true })
  const contractPath = path.join(coreDir, 'integration-contract.json')
  fs.writeFileSync(contractPath, JSON.stringify(contract))
  vi.mocked(execSync).mockReturnValue(tmpDir as any)
  return contractPath
}

describe('checkCoreCompat', () => {
  let tmpDir: string

  beforeEach(() => {
    vi.restoreAllMocks()
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-compat-test-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns compatible=true and contractFound=false when core is not installed', async () => {
    vi.mocked(execSync).mockImplementation(() => { throw new Error('not found') })

    const result = await checkCoreCompat()

    expect(result.compatible).toBe(true)
    expect(result.contractFound).toBe(false)
    expect(result.coreVersion).toBeNull()
    expect(result.missingCheckpoints).toEqual([])
    expect(result.missingCommands).toEqual([])
  })

  it('returns compatible=true when contract exactly matches app constants', async () => {
    setupContractInTmpDir(COMPATIBLE_CONTRACT, tmpDir)

    const result = await checkCoreCompat()

    expect(result.compatible).toBe(true)
    expect(result.contractFound).toBe(true)
    expect(result.coreVersion).toBe('1.0.0')
    expect(result.missingCheckpoints).toEqual([])
    expect(result.extraCheckpoints).toEqual([])
    expect(result.missingCommands).toEqual([])
    expect(result.extraCommands).toEqual([])
  })

  it('exposes provider rendering support from the Core contract', async () => {
    setupContractInTmpDir({
      ...COMPATIBLE_CONTRACT,
      providers: { claude: {}, codex: {}, kimi: { enrichCommand: '/skill:specrails-enrich' } },
    }, tmpDir)
    const result = await checkCoreCompat()
    expect(result.supportedProviders).toEqual(['claude', 'codex', 'kimi'])
    expect(coreCompatSupportsProvider(result, 'kimi')).toBe(true)
    expect(coreCompatSupportsProvider(result, 'gemini')).toBe(false)
  })

  it('does not treat a missing/legacy contract provider entry as Kimi support', () => {
    expect(coreCompatSupportsProvider({
      contractFound: false,
      supportedProviders: [],
    }, 'kimi')).toBe(false)
    expect(coreCompatSupportsProvider({
      contractFound: true,
      supportedProviders: [],
    }, 'kimi')).toBe(false)
  })

  it('detects drift when core adds a new checkpoint phase', async () => {
    const driftedContract = {
      ...COMPATIBLE_CONTRACT,
      checkpoints: [...COMPATIBLE_CONTRACT.checkpoints, 'new_phase_v2'],
    }
    setupContractInTmpDir(driftedContract, tmpDir)

    const result = await checkCoreCompat()

    expect(result.compatible).toBe(false)
    expect(result.contractFound).toBe(true)
    expect(result.missingCheckpoints).toContain('new_phase_v2')
    expect(result.extraCheckpoints).toEqual([])
    expect(result.missingCommands).toEqual([])
  })

  it('detects drift when the app has a checkpoint that core dropped', async () => {
    const driftedContract = {
      ...COMPATIBLE_CONTRACT,
      checkpoints: COMPATIBLE_CONTRACT.checkpoints.filter((c) => c !== 'command_generation'),
    }
    setupContractInTmpDir(driftedContract, tmpDir)

    const result = await checkCoreCompat()

    expect(result.compatible).toBe(false)
    expect(result.extraCheckpoints).toContain('command_generation')
    expect(result.missingCheckpoints).toEqual([])
  })

  it('detects drift when core adds a new command verb', async () => {
    const driftedContract = {
      ...COMPATIBLE_CONTRACT,
      commands: [...COMPATIBLE_CONTRACT.commands, 'new-command'],
    }
    setupContractInTmpDir(driftedContract, tmpDir)

    const result = await checkCoreCompat()

    expect(result.compatible).toBe(false)
    expect(result.missingCommands).toContain('new-command')
    expect(result.extraCommands).toEqual([])
  })

  it('detects drift when the app has a command that core dropped', async () => {
    const driftedContract = {
      ...COMPATIBLE_CONTRACT,
      commands: COMPATIBLE_CONTRACT.commands.filter((c) => c !== 'health-check'),
    }
    setupContractInTmpDir(driftedContract, tmpDir)

    const result = await checkCoreCompat()

    expect(result.compatible).toBe(false)
    expect(result.extraCommands).toContain('health-check')
    expect(result.missingCommands).toEqual([])
  })

  it('reports desktopVersion from package.json', async () => {
    vi.mocked(execSync).mockImplementation(() => { throw new Error('not found') })

    const result = await checkCoreCompat()

    expect(result.desktopVersion).toMatch(/^\d+\.\d+\.\d+$/)
  })
})

describe('detectCLISync', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('returns claude when claude binary is found', () => {
    vi.mocked(execSync).mockImplementation((cmd: any) => {
      if (String(cmd).includes('claude')) return '' as any
      throw new Error('not found')
    })
    expect(detectCLISync()).toBe('claude')
  })

  it('returns codex when only codex binary is found', () => {
    vi.mocked(execSync).mockImplementation((cmd: any) => {
      if (String(cmd).includes('codex')) return '' as any
      throw new Error('not found')
    })
    expect(detectCLISync()).toBe('codex')
  })

  it('prefers claude over codex when both are present', () => {
    vi.mocked(execSync).mockReturnValue('' as any)
    expect(detectCLISync()).toBe('claude')
  })

  it('returns null when neither CLI is found', () => {
    vi.mocked(execSync).mockImplementation(() => { throw new Error('not found') })
    expect(detectCLISync()).toBeNull()
  })
})

describe('detectCLI', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('resolves to claude when claude binary is found', async () => {
    vi.mocked(execSync).mockImplementation((cmd: any) => {
      if (String(cmd).includes('claude')) return '' as any
      throw new Error('not found')
    })
    await expect(detectCLI()).resolves.toBe('claude')
  })

  it('resolves to null when no CLI is found', async () => {
    vi.mocked(execSync).mockImplementation(() => { throw new Error('not found') })
    await expect(detectCLI()).resolves.toBeNull()
  })
})

describe('getCLIStatus', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('returns provider and parsed semver version when claude is found', () => {
    vi.mocked(execSync).mockImplementation((cmd: any) => {
      const c = String(cmd)
      if (c.includes('which claude')) return '' as any
      if (c.includes('claude --version')) return 'Claude Code 1.2.3\n' as any
      throw new Error('not found')
    })
    const result = getCLIStatus()
    expect(result.provider).toBe('claude')
    expect(result.version).toBe('1.2.3')
  })

  it('returns provider and version null when version command fails', () => {
    vi.mocked(execSync).mockImplementation((cmd: any) => {
      if (String(cmd).includes('which claude')) return '' as any
      throw new Error('version cmd failed')
    })
    const result = getCLIStatus()
    expect(result.provider).toBe('claude')
    expect(result.version).toBeNull()
  })

  it('returns null provider and null version when no CLI found', () => {
    vi.mocked(execSync).mockImplementation(() => { throw new Error('not found') })
    const result = getCLIStatus()
    expect(result.provider).toBeNull()
    expect(result.version).toBeNull()
  })

  it('returns codex provider when only codex is found', () => {
    vi.mocked(execSync).mockImplementation((cmd: any) => {
      const c = String(cmd)
      if (c.includes('which codex')) return '' as any
      if (c.includes('codex --version')) return '0.1.5\n' as any
      throw new Error('not found')
    })
    const result = getCLIStatus()
    expect(result.provider).toBe('codex')
    expect(result.version).toBe('0.1.5')
  })
})

describe('findCoreContract', () => {
  let tmpDir: string

  beforeEach(() => {
    vi.restoreAllMocks()
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-compat-test-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns null when core is not installed anywhere', async () => {
    vi.mocked(execSync).mockImplementation(() => { throw new Error('not found') })

    const result = await findCoreContract()
    expect(result).toBeNull()
  })

  it('finds contract via npm root -g strategy', async () => {
    const coreDir = path.join(tmpDir, 'specrails-core')
    fs.mkdirSync(coreDir, { recursive: true })
    const contractPath = path.join(coreDir, 'integration-contract.json')
    fs.writeFileSync(contractPath, '{}')
    vi.mocked(execSync).mockReturnValue(tmpDir as any)

    const result = await findCoreContract()
    expect(result).toBe(contractPath)
  })

  it('prefers the packaged bundled Core contract', async () => {
    const previous = process.env.SPECRAILS_BUNDLED_CORE_PATH
    const bundledRoot = path.join(tmpDir, 'bundled-core')
    fs.mkdirSync(bundledRoot, { recursive: true })
    const contractPath = path.join(bundledRoot, 'integration-contract.json')
    fs.writeFileSync(contractPath, '{}')
    process.env.SPECRAILS_BUNDLED_CORE_PATH = bundledRoot
    vi.mocked(execSync).mockImplementation(() => { throw new Error('global lookup must not run') })
    vi.mocked(execSync).mockClear()
    try {
      await expect(findCoreContract()).resolves.toBe(contractPath)
      expect(execSync).not.toHaveBeenCalled()
    } finally {
      if (previous === undefined) delete process.env.SPECRAILS_BUNDLED_CORE_PATH
      else process.env.SPECRAILS_BUNDLED_CORE_PATH = previous
    }
  })
})
