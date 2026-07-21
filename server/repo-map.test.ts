import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  buildRepoMap, formatRepoMap, ensureRepoMapFile, injectRepoMapEnv,
  isRepoMapEnabled, _clearRepoMapCache,
} from './repo-map'

let repo: string

function write(rel: string, content = ''): void {
  const p = path.join(repo, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content)
}

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-map-'))
  _clearRepoMapCache()
})

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true })
  delete process.env.SPECRAILS_REPO_MAP
})

describe('buildRepoMap', () => {
  it('detects the root package, ecosystems, and README', () => {
    write('package.json', JSON.stringify({ name: 'my-app' }))
    write('README.md', '# My App\nDoes things.')
    write('api/pyproject.toml', '[project]\nname = "api"')
    write('worker/go.mod', 'module worker')
    write('node_modules/leaked/package.json', '{}')
    write('.hidden/package.json', '{}')

    const map = buildRepoMap(repo)
    const dirs = map.services.map((s) => s.dir)
    expect(dirs).toContain('')
    expect(dirs).toContain('api')
    expect(dirs).toContain('worker')
    expect(dirs).not.toContain('node_modules/leaked')
    expect(dirs).not.toContain('.hidden')

    const root = map.services.find((s) => s.dir === '')!
    expect(root.name).toBe('my-app')
    expect(root.ecosystem).toBe('node')
    expect(root.hasReadme).toBe(true)
    expect(map.readmeExcerpt).toContain('# My App')
    expect(map.services.find((s) => s.dir === 'api')!.ecosystem).toBe('python')
    expect(map.services.find((s) => s.dir === 'worker')!.ecosystem).toBe('go')
  })

  it('resolves npm workspaces (literal + trailing /*) one level below the top scan', () => {
    write('package.json', JSON.stringify({ name: 'root', workspaces: ['packages/*', 'tools/cli'] }))
    write('packages/a/package.json', JSON.stringify({ name: '@x/a' }))
    write('packages/b/package.json', JSON.stringify({ name: '@x/b' }))
    write('tools/cli/package.json', JSON.stringify({ name: '@x/cli' }))

    const map = buildRepoMap(repo)
    const dirs = map.services.map((s) => s.dir)
    expect(dirs).toContain(path.join('packages', 'a'))
    expect(dirs).toContain(path.join('packages', 'b'))
    expect(dirs).toContain(path.join('tools', 'cli'))
  })

  it('handles an unreadable/empty repo without throwing', () => {
    const map = buildRepoMap(path.join(repo, 'does-not-exist'))
    expect(map.services).toEqual([])
    expect(map.readmeExcerpt).toBeNull()
  })
})

describe('formatRepoMap', () => {
  it('renders one line per package and the orientation note', () => {
    write('package.json', JSON.stringify({ name: 'app' }))
    const text = formatRepoMap(buildRepoMap(repo))
    expect(text).toContain('# Repository map')
    expect(text).toContain('- `./` — app (node, small, no README)')
    expect(text).toContain('orient exploration')
  })

  it('states when no manifests were found', () => {
    const text = formatRepoMap(buildRepoMap(repo))
    expect(text).toContain('no recognized package manifests')
  })
})

describe('ensureRepoMapFile / injectRepoMapEnv', () => {
  let home: string
  beforeEach(() => {
    // SPECRAILS_REGISTRY_HOME is pinned to a tmp dir by vitest-setup; assert
    // the map lands under it, never the real home.
    home = process.env.SPECRAILS_REGISTRY_HOME!
  })

  it('writes the map under <home>/.specrails/repo-maps and reuses the cache', () => {
    write('package.json', JSON.stringify({ name: 'app' }))
    const p1 = ensureRepoMapFile(repo)!
    expect(p1.startsWith(path.join(home, '.specrails', 'repo-maps'))).toBe(true)
    expect(fs.readFileSync(p1, 'utf8')).toContain('app (node')
    const p2 = ensureRepoMapFile(repo)
    expect(p2).toBe(p1)
  })

  it('returns null for a missing repo dir', () => {
    expect(ensureRepoMapFile(path.join(repo, 'nope'))).toBeNull()
  })

  it('injects SPECRAILS_REPO_MAP_PATH into the env', () => {
    write('package.json', JSON.stringify({ name: 'app' }))
    const env = injectRepoMapEnv({ FOO: '1' }, repo)
    expect(env.FOO).toBe('1')
    expect(env.SPECRAILS_REPO_MAP_PATH).toBeTruthy()
    expect(fs.existsSync(env.SPECRAILS_REPO_MAP_PATH!)).toBe(true)
  })

  it('is a no-op without a repoDir or with the kill switch', () => {
    const base = { FOO: '1' }
    expect(injectRepoMapEnv(base, undefined)).toBe(base)
    process.env.SPECRAILS_REPO_MAP = 'false'
    expect(isRepoMapEnabled()).toBe(false)
    expect(injectRepoMapEnv(base, repo)).toBe(base)
  })
})
