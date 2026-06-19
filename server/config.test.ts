import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import { execSync, execFileSync } from 'child_process'

// Mock child_process execSync/execFileSync to avoid real CLI calls.
// Detection commands (which/auth status/git remote) go through execSync; the
// issue-fetch path goes through execFileSync (argv form, no shell — H-12).
vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process')
  return {
    ...actual,
    execSync: vi.fn(),
    execFileSync: vi.fn(),
  }
})

import { getConfig, fetchIssues, __resetTrackerDetectionCacheForTest } from './config'

const mockExecSync = execSync as ReturnType<typeof vi.fn>
const mockExecFileSync = execFileSync as ReturnType<typeof vi.fn>

// Spy references — typed as any to avoid overloaded-signature inference conflicts
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let existsSyncSpy: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let readdirSyncSpy: any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let readFileSyncSpy: any

describe('getConfig', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    __resetTrackerDetectionCacheForTest()
    mockExecSync.mockReturnValue(Buffer.from(''))
    existsSyncSpy = vi.spyOn(fs, 'existsSync').mockReturnValue(false)
    readdirSyncSpy = vi.spyOn(fs, 'readdirSync').mockReturnValue([])
    readFileSyncSpy = vi.spyOn(fs, 'readFileSync').mockReturnValue('')
  })

  afterEach(() => {
    existsSyncSpy.mockRestore()
    readdirSyncSpy.mockRestore()
    readFileSyncSpy.mockRestore()
  })

  it('returns config structure with all required fields', () => {
    const config = getConfig('/some/project/specrails/web-manager')

    expect(config).toHaveProperty('project')
    expect(config).toHaveProperty('issueTracker')
    expect(config).toHaveProperty('commands')
    expect(config.issueTracker).toHaveProperty('github')
    expect(config.issueTracker).toHaveProperty('jira')
    expect(config.issueTracker).toHaveProperty('active')
    expect(config.issueTracker).toHaveProperty('labelFilter')
  })

  it('detects gh as available when which gh succeeds', () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd === 'which gh') return Buffer.from('/usr/bin/gh')
      if (cmd === 'gh auth status') return Buffer.from('Logged in to github.com')
      return Buffer.from('')
    })

    const config = getConfig('/some/project/specrails/web-manager')

    expect(config.issueTracker.github.available).toBe(true)
    expect(config.issueTracker.github.authenticated).toBe(true)
  })

  it('reports gh as unavailable when which gh fails', () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd === 'which gh') throw new Error('not found')
      return Buffer.from('')
    })

    const config = getConfig('/some/project/specrails/web-manager')

    expect(config.issueTracker.github.available).toBe(false)
    expect(config.issueTracker.github.authenticated).toBe(false)
  })

  it('scans command files from .claude/commands/sr/ directory', () => {
    mockExecSync.mockReturnValue(Buffer.from(''))
    existsSyncSpy.mockReturnValue(true)
    readdirSyncSpy.mockReturnValue(['implement.md', 'batch-implement.md'] as unknown as fs.Dirent[])
    readFileSyncSpy.mockImplementation((filePath: unknown) => {
      if (String(filePath).includes('implement.md') && !String(filePath).includes('batch')) {
        return `---\nname: Implement\ndescription: Implement a feature from an issue\n---\n# Content`
      }
      if (String(filePath).includes('batch-implement.md')) {
        return `---\nname: Batch Implement\ndescription: Implement multiple features\n---\n# Content`
      }
      return ''
    })

    const config = getConfig('/some/project/specrails/web-manager')

    expect(config.commands).toHaveLength(2)
    expect(config.commands[0].name).toBe('Implement')
    expect(config.commands[0].description).toBe('Implement a feature from an issue')
    expect(config.commands[1].name).toBe('Batch Implement')
  })

  it('relocate-artifacts: scans commands from the commandsRoot override (workspace)', () => {
    mockExecSync.mockReturnValue(Buffer.from(''))
    // The repo (cwd) has a `.claude` so projectRoot === cwd, but commands are
    // materialized into the WORKSPACE — scanning the repo would find none.
    existsSyncSpy.mockImplementation((p: unknown) => {
      const s = String(p)
      // repo .claude exists (project-root detection) AND the workspace commands dir
      return s.endsWith('.claude') || s.includes('/workspace/.claude/commands/sr')
    })
    readdirSyncSpy.mockImplementation((p: unknown) => {
      // Only the WORKSPACE commands dir yields files; the repo's would be empty.
      if (String(p).includes('/workspace/.claude/commands/sr')) {
        return ['implement.md'] as unknown as fs.Dirent[]
      }
      return [] as unknown as fs.Dirent[]
    })
    readFileSyncSpy.mockReturnValue('---\nname: Implement\ndescription: D\n---\n# C')

    const repo = '/repo'
    const workspace = '/home/.specrails/projects/repo/workspace'
    const withWs = getConfig(repo, undefined, undefined, workspace)
    expect(withWs.commands).toHaveLength(1)
    expect(withWs.commands[0].name).toBe('Implement')

    // Without the override (legacy), the repo commands dir is empty.
    const legacy = getConfig(repo)
    expect(legacy.commands).toHaveLength(0)
  })

  it('falls back to filename-derived name when frontmatter is missing', () => {
    mockExecSync.mockReturnValue(Buffer.from(''))
    existsSyncSpy.mockReturnValue(true)
    readdirSyncSpy.mockReturnValue(['health-check.md'] as unknown as fs.Dirent[])
    readFileSyncSpy.mockReturnValue('# No frontmatter here\nJust content')

    const config = getConfig('/some/project/specrails/web-manager')

    expect(config.commands).toHaveLength(1)
    expect(config.commands[0].id).toBe('health-check')
    expect(config.commands[0].name).toBe('health-check')
  })

  it('extracts repo name from git remote HTTPS URL', () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd === 'git remote get-url origin') return Buffer.from('https://github.com/owner/myrepo.git')
      return Buffer.from('')
    })

    const config = getConfig('/some/project/specrails/web-manager')

    expect(config.project.repo).toBe('owner/myrepo')
  })

  it('extracts repo name from git remote SSH URL', () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd === 'git remote get-url origin') return Buffer.from('git@github.com:owner/myrepo.git')
      return Buffer.from('')
    })

    const config = getConfig('/some/project/specrails/web-manager')

    expect(config.project.repo).toBe('owner/myrepo')
  })

  it('returns null repo when git remote is not github', () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd === 'git remote get-url origin') return Buffer.from('https://gitlab.com/owner/repo.git')
      return Buffer.from('')
    })

    const config = getConfig('/some/project/specrails/web-manager')

    expect(config.project.repo).toBe(null)
  })

  it('auto-detects github as active when authenticated', () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd === 'which gh') return Buffer.from('/usr/bin/gh')
      if (cmd === 'gh auth status') return Buffer.from('Logged in')
      if (cmd === 'which jira') throw new Error('not found')
      return Buffer.from('')
    })

    const config = getConfig('/some/project/specrails/web-manager')

    expect(config.issueTracker.active).toBe('github')
  })

  it('uses Super mode when .claude directory exists at cwd', () => {
    existsSyncSpy.mockImplementation((p: unknown) => String(p).endsWith('.claude'))
    readdirSyncSpy.mockReturnValue([])

    const config = getConfig('/my/project', undefined, 'MyProject')

    expect(config.project.name).toBe('MyProject')
  })

  it('accepts custom projectName parameter', () => {
    const config = getConfig('/some/project/specrails/web-manager', undefined, 'CustomName')

    expect(config.project.name).toBe('CustomName')
  })
})

describe('getConfig with db parameter', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    __resetTrackerDetectionCacheForTest()
    mockExecSync.mockReturnValue(Buffer.from(''))
    existsSyncSpy = vi.spyOn(fs, 'existsSync').mockReturnValue(false)
    readdirSyncSpy = vi.spyOn(fs, 'readdirSync').mockReturnValue([])
    readFileSyncSpy = vi.spyOn(fs, 'readFileSync').mockReturnValue('')
  })

  afterEach(() => {
    existsSyncSpy.mockRestore()
    readdirSyncSpy.mockRestore()
    readFileSyncSpy.mockRestore()
  })

  it('uses persisted active tracker from db', () => {
    const mockDb = {
      prepare: vi.fn((sql: string) => ({
        get: vi.fn(() => {
          if (sql.includes('active_tracker')) return { value: 'jira' }
          if (sql.includes('label_filter')) return { value: 'my-label' }
          return undefined
        }),
      })),
    }

    const config = getConfig('/some/project/specrails/web-manager', mockDb)

    expect(config.issueTracker.active).toBe('jira')
    expect(config.issueTracker.labelFilter).toBe('my-label')
  })

  it('uses persisted labelFilter from db when active_tracker is null', () => {
    const mockDb = {
      prepare: vi.fn((sql: string) => ({
        get: vi.fn(() => {
          if (sql.includes('label_filter')) return { value: 'bug' }
          return undefined
        }),
      })),
    }

    const config = getConfig('/some/project/specrails/web-manager', mockDb)

    expect(config.issueTracker.labelFilter).toBe('bug')
  })

  it('falls back gracefully when db.prepare throws', () => {
    const mockDb = {
      prepare: vi.fn(() => { throw new Error('DB error') }),
    }

    const config = getConfig('/some/project/specrails/web-manager', mockDb)

    expect(config.issueTracker.active).toBeNull()
    expect(config.issueTracker.labelFilter).toBe('')
  })
})

describe('getConfig with phases in command frontmatter', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    __resetTrackerDetectionCacheForTest()
    mockExecSync.mockReturnValue(Buffer.from(''))
    existsSyncSpy = vi.spyOn(fs, 'existsSync').mockReturnValue(true)
    readdirSyncSpy = vi.spyOn(fs, 'readdirSync').mockReturnValue(['implement.md'] as unknown as fs.Dirent[])
    readFileSyncSpy = vi.spyOn(fs, 'readFileSync').mockReturnValue(
      `---\nname: Implement\ndescription: Run implementation\nphases:\n  - key: architect\n    label: Architect\n    description: Plan the work\n  - key: developer\n    label: Developer\n    description: Build the feature\n---\n# Content`
    )
  })

  afterEach(() => {
    existsSyncSpy.mockRestore()
    readdirSyncSpy.mockRestore()
    readFileSyncSpy.mockRestore()
  })

  it('parses phases from command frontmatter', () => {
    const config = getConfig('/some/project/specrails/web-manager')

    expect(config.commands).toHaveLength(1)
    expect(config.commands[0].phases).toHaveLength(2)
    expect(config.commands[0].phases[0].key).toBe('architect')
    expect(config.commands[0].phases[0].label).toBe('Architect')
    expect(config.commands[0].phases[1].key).toBe('developer')
  })
})

describe('tracker detection memo (H19)', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    __resetTrackerDetectionCacheForTest()
    existsSyncSpy = vi.spyOn(fs, 'existsSync').mockReturnValue(false)
    readdirSyncSpy = vi.spyOn(fs, 'readdirSync').mockReturnValue([])
    readFileSyncSpy = vi.spyOn(fs, 'readFileSync').mockReturnValue('')
  })

  afterEach(() => {
    existsSyncSpy.mockRestore()
    readdirSyncSpy.mockRestore()
    readFileSyncSpy.mockRestore()
    vi.useRealTimers()
  })

  function mockTrackerProbes(counters: { gh: number; jira: number }) {
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd === 'which gh') { counters.gh++; return Buffer.from('/usr/bin/gh') }
      if (cmd === 'gh auth status') return Buffer.from('Logged in')
      if (cmd === 'which jira') { counters.jira++; throw new Error('not found') }
      return Buffer.from('')
    })
  }

  it('probes gh/jira once and reuses the result across getConfig calls within the TTL', () => {
    const counters = { gh: 0, jira: 0 }
    mockTrackerProbes(counters)

    const first = getConfig('/project/one')
    const second = getConfig('/project/two')

    expect(counters.gh).toBe(1)
    expect(counters.jira).toBe(1)
    expect(second.issueTracker.github).toEqual(first.issueTracker.github)
    expect(second.issueTracker.github.authenticated).toBe(true)
  })

  it('still probes the project-dependent git remote on every call', () => {
    const counters = { gh: 0, jira: 0 }
    let gitCalls = 0
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd === 'which gh') { counters.gh++; return Buffer.from('/usr/bin/gh') }
      if (cmd === 'gh auth status') return Buffer.from('Logged in')
      if (cmd === 'which jira') throw new Error('not found')
      if (cmd === 'git remote get-url origin') { gitCalls++; return Buffer.from('https://github.com/o/r.git') }
      return Buffer.from('')
    })

    getConfig('/project/one')
    getConfig('/project/two')

    expect(counters.gh).toBe(1)
    expect(gitCalls).toBe(2)
  })

  it('re-probes after the TTL expires', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const counters = { gh: 0, jira: 0 }
    mockTrackerProbes(counters)

    getConfig('/project/one')
    expect(counters.gh).toBe(1)

    // Within TTL — cached.
    vi.setSystemTime(new Date('2026-01-01T00:00:30Z'))
    getConfig('/project/one')
    expect(counters.gh).toBe(1)

    // Past TTL — re-probed.
    vi.setSystemTime(new Date('2026-01-01T00:01:01Z'))
    getConfig('/project/one')
    expect(counters.gh).toBe(2)
  })

  it('re-probes after an explicit cache reset', () => {
    const counters = { gh: 0, jira: 0 }
    mockTrackerProbes(counters)

    getConfig('/project/one')
    __resetTrackerDetectionCacheForTest()
    getConfig('/project/one')

    expect(counters.gh).toBe(2)
  })
})

describe('fetchIssues', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockExecSync.mockReturnValue(Buffer.from(''))
    mockExecFileSync.mockReturnValue(Buffer.from(''))
  })

  it('returns structured issues from gh issue list output', () => {
    const mockOutput = JSON.stringify([
      { number: 42, title: 'Fix the bug', labels: [{ name: 'bug' }], body: 'Description', url: 'https://github.com/...' },
      { number: 43, title: 'Add feature', labels: [], body: '', url: 'https://github.com/...' },
    ])
    mockExecFileSync.mockReturnValue(Buffer.from(mockOutput))

    const issues = fetchIssues('github', {})

    expect(issues).toHaveLength(2)
    expect(issues[0].number).toBe(42)
    expect(issues[0].title).toBe('Fix the bug')
    expect(issues[0].labels).toEqual(['bug'])
  })

  it('returns empty array when gh command fails', () => {
    mockExecFileSync.mockImplementation(() => { throw new Error('gh not found') })

    const issues = fetchIssues('github', {})

    expect(issues).toEqual([])
  })

  it('passes repo and label args to gh as a literal argv array (no shell)', () => {
    mockExecFileSync.mockReturnValue(Buffer.from('[]'))

    fetchIssues('github', { repo: 'owner/repo', label: 'bug', search: 'auth' })

    // execFileSync(file, args, opts) — file is the program, args is the argv.
    const [file, argv] = mockExecFileSync.mock.calls[0]
    expect(file).toBe('gh')
    expect(argv).toEqual(expect.arrayContaining(['--repo', 'owner/repo', '--label', 'bug', '--search', 'auth']))
    // The whole thing is never collapsed into a single shell string.
    expect(typeof argv).not.toBe('string')
  })

  it('H-12: shell metacharacters in search are passed as one literal arg, not executed', () => {
    mockExecFileSync.mockReturnValue(Buffer.from('[]'))

    const malicious = '$(touch /tmp/pwned); rm -rf ~'
    fetchIssues('github', { search: malicious })

    const [file, argv] = mockExecFileSync.mock.calls[0]
    expect(file).toBe('gh')
    // The payload survives intact as a single argument — gh treats it as a
    // literal search term, the shell never sees it.
    const searchIdx = (argv as string[]).indexOf('--search')
    expect(searchIdx).toBeGreaterThanOrEqual(0)
    expect((argv as string[])[searchIdx + 1]).toBe(malicious)
  })

  it('returns issues from jira tracker', () => {
    const jiraOutput = `KEY\tSUMMARY\tLABELS\tSTATUS\nPROJ-1\tFix auth bug\tbug,urgent\tOpen\nPROJ-2\tAdd dashboard\t\tIn Progress`
    mockExecFileSync.mockReturnValue(Buffer.from(jiraOutput))

    const issues = fetchIssues('jira', {})

    expect(issues).toHaveLength(2)
    expect(issues[0].title).toBe('Fix auth bug')
    expect(issues[0].labels).toEqual(['bug', 'urgent'])
    expect(issues[1].title).toBe('Add dashboard')
    expect(issues[1].labels).toEqual([])
  })

  it('returns empty array when jira command fails', () => {
    mockExecFileSync.mockImplementation(() => { throw new Error('jira not found') })

    const issues = fetchIssues('jira', {})

    expect(issues).toEqual([])
  })

  it('passes search query to jira as a literal --jql argv element', () => {
    mockExecFileSync.mockReturnValue(Buffer.from('KEY\tSUMMARY\tLABELS\tSTATUS'))

    fetchIssues('jira', { search: 'auth' })

    const [file, argv] = mockExecFileSync.mock.calls[0]
    expect(file).toBe('jira')
    const jqlIdx = (argv as string[]).indexOf('--jql')
    expect(jqlIdx).toBeGreaterThanOrEqual(0)
    expect((argv as string[])[jqlIdx + 1]).toBe('summary ~ "auth"')
  })

  it('returns empty array for unsupported tracker', () => {
    const issues = fetchIssues('github', {})
    expect(Array.isArray(issues)).toBe(true)
  })
})
