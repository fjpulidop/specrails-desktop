import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { agentEnvAllowlist, buildAgentEnv, matchesEnvPattern, minimalAgentEnvNames } from '..'

const SOURCE: NodeJS.ProcessEnv = {
  PATH: '/usr/bin:/bin',
  HOME: '/Users/dev',
  USER: 'dev',
  LANG: 'en_US.UTF-8',
  LC_ALL: 'en_US.UTF-8',
  TMPDIR: '/tmp/',
  https_proxy: 'http://proxy:3128',
  NO_PROXY: 'localhost',
  NODE_EXTRA_CA_CERTS: '/certs/ca.pem',
  SPECRAILS_BUNDLED_CORE_PATH: '/bundle/core',
  ANTHROPIC_API_KEY: 'sk-ant-fixture',
  OPENAI_API_KEY: 'sk-openai-fixture',
  AWS_SECRET_ACCESS_KEY: 'aws-fixture',
  GITHUB_TOKEN: 'ghp-fixture',
  DATABASE_URL: 'postgres://fixture',
}

describe('matchesEnvPattern', () => {
  it('matches exact names and trailing-* prefixes', () => {
    expect(matchesEnvPattern('LC_ALL', 'LC_*')).toBe(true)
    expect(matchesEnvPattern('LCX', 'LC_*')).toBe(false)
    expect(matchesEnvPattern('PATH', 'PATH')).toBe(true)
    expect(matchesEnvPattern('PATHX', 'PATH')).toBe(false)
    expect(matchesEnvPattern('Path', 'PATH')).toBe(false)
    expect(matchesEnvPattern('Path', 'PATH', true)).toBe(true)
  })
})

describe('buildAgentEnv — inherit', () => {
  it('returns the same source object when there is no passthrough (identical to today)', () => {
    expect(buildAgentEnv({ mode: 'inherit', sourceEnv: SOURCE, passthrough: {} })).toBe(SOURCE)
  })

  it('overlays passthrough values exactly like applyWorktreeEnvPassthrough', () => {
    const env = buildAgentEnv({ mode: 'inherit', sourceEnv: SOURCE, passthrough: { NODE_AUTH_TOKEN: 'npm-fixture' } })
    expect(env).toEqual({ ...SOURCE, NODE_AUTH_TOKEN: 'npm-fixture' })
    expect(env).not.toBe(SOURCE)
  })
})

describe('buildAgentEnv — minimal', () => {
  it('keeps only the shared allowlist, Specrails names and passthrough values', () => {
    const env = buildAgentEnv({ mode: 'minimal', sourceEnv: SOURCE, passthrough: { NODE_AUTH_TOKEN: 'npm-fixture' }, platform: 'darwin' })
    expect(Object.keys(env).sort()).toEqual([
      'HOME', 'LANG', 'LC_ALL', 'NODE_AUTH_TOKEN', 'NODE_EXTRA_CA_CERTS', 'NO_PROXY', 'PATH',
      'SPECRAILS_BUNDLED_CORE_PATH', 'TMPDIR', 'USER', 'https_proxy',
    ])
    expect(env.NODE_AUTH_TOKEN).toBe('npm-fixture')
    expect(env).not.toHaveProperty('AWS_SECRET_ACCESS_KEY')
    expect(env).not.toHaveProperty('GITHUB_TOKEN')
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY')
  })

  it('never mutates the source', () => {
    const source = { ...SOURCE }
    buildAgentEnv({ mode: 'minimal', sourceEnv: source, passthrough: {}, platform: 'darwin' })
    expect(source).toEqual(SOURCE)
  })

  it('adds only the provider names the adapter declares', () => {
    const claude = buildAgentEnv({ mode: 'minimal', sourceEnv: SOURCE, passthrough: {}, providerAllowlist: ['ANTHROPIC_*', 'CLAUDE_CONFIG_DIR'], platform: 'darwin' })
    expect(claude.ANTHROPIC_API_KEY).toBe('sk-ant-fixture')
    expect(claude).not.toHaveProperty('OPENAI_API_KEY')
    const codex = buildAgentEnv({ mode: 'minimal', sourceEnv: SOURCE, passthrough: {}, providerAllowlist: ['CODEX_*', 'OPENAI_API_KEY'], platform: 'darwin' })
    expect(codex.OPENAI_API_KEY).toBe('sk-openai-fixture')
    expect(codex).not.toHaveProperty('ANTHROPIC_API_KEY')
  })

  it('preserves Windows essentials case-insensitively on win32', () => {
    const source: NodeJS.ProcessEnv = {
      Path: 'C:\\Windows\\System32', SYSTEMROOT: 'C:\\Windows', ComSpec: 'C:\\Windows\\System32\\cmd.exe',
      PATHEXT: '.COM;.EXE;.CMD', USERPROFILE: 'C:\\Users\\dev', APPDATA: 'C:\\Users\\dev\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local', 'ProgramFiles(x86)': 'C:\\Program Files (x86)',
      NUMBER_OF_PROCESSORS: '8', windir: 'C:\\Windows', SECRET_TOKEN: 'fixture',
    }
    const env = buildAgentEnv({ mode: 'minimal', sourceEnv: source, passthrough: {}, platform: 'win32' })
    expect(Object.keys(env).sort()).toEqual(Object.keys(source).filter(key => key !== 'SECRET_TOKEN').sort())
  })

  it('does not match Windows names case-insensitively elsewhere', () => {
    const env = buildAgentEnv({ mode: 'minimal', sourceEnv: { Path: '/bin', PATH: '/usr/bin' }, passthrough: {}, platform: 'linux' })
    expect(env).toEqual({ PATH: '/usr/bin' })
  })

  it('reports the names it would pass, never values', () => {
    const names = minimalAgentEnvNames({ sourceEnv: SOURCE, passthrough: { NODE_AUTH_TOKEN: 'npm-fixture' }, providerAllowlist: ['ANTHROPIC_*'], platform: 'darwin' })
    expect(names).toContain('ANTHROPIC_API_KEY')
    expect(names).toContain('NODE_AUTH_TOKEN')
    expect(names.join(' ')).not.toContain('fixture')
  })

  it('deduplicates the effective allowlist', () => {
    const list = agentEnvAllowlist(['PATH', 'ANTHROPIC_*'])
    expect(list.filter(item => item === 'PATH')).toHaveLength(1)
    expect(list).toContain('SPECRAILS_*')
    expect(list).toContain('ANTHROPIC_*')
  })

  it('a child process started with the minimal env sees only allowlisted names', () => {
    const source: NodeJS.ProcessEnv = { ...process.env, SR_TEST_SECRET: 'fixture-secret', SR_TEST_ALLOWED: 'ok', ANTHROPIC_API_KEY: 'sk-ant-fixture', AWS_SECRET_ACCESS_KEY: 'aws-fixture' }
    const env = buildAgentEnv({ mode: 'minimal', sourceEnv: source, passthrough: { SR_TEST_ALLOWED: 'ok' }, providerAllowlist: ['ANTHROPIC_*'] })
    const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(Object.keys(process.env)))'], { env, encoding: 'utf8' })
    expect(child.status).toBe(0)
    const seen = JSON.parse(child.stdout) as string[]
    const allowed = new Set(Object.keys(env))
    // The OS may add its own bookkeeping names (macOS `__CF_USER_TEXT_ENCODING`).
    expect(seen.filter(name => !allowed.has(name) && !name.startsWith('__CF'))).toEqual([])
    expect(seen).toContain('SR_TEST_ALLOWED')
    expect(seen).toContain('ANTHROPIC_API_KEY')
    expect(seen).not.toContain('SR_TEST_SECRET')
    expect(seen).not.toContain('AWS_SECRET_ACCESS_KEY')
  })
})
