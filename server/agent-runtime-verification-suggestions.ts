import fs from 'node:fs'
import path from 'node:path'

/** A verification command Desktop can propose for a repository without any model call. */
export interface VerificationSuggestion {
  repositoryId: string
  command: string
  args: string[]
  /** What was detected, for the settings UI. */
  reason: string
}

interface Repository { id: string; path: string }
type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun'

const NPM_TEST_PLACEHOLDER = /no test specified/i
/** Script names worth running as verification, in priority order. Only scripts
 *  that exist in the repository are proposed; nothing is invented. */
const SCRIPT_CANDIDATES: Array<{ names: string[]; label: string }> = [
  { names: ['test', 'test:unit', 'test:ci'], label: 'test script' },
  { names: ['typecheck', 'type-check', 'types', 'check-types'], label: 'type check script' },
  { names: ['lint'], label: 'lint script' },
]
const BUILD_SCRIPTS = ['build', 'compile']

function exists(root: string, ...parts: string[]): boolean {
  try { return fs.existsSync(path.join(root, ...parts)) } catch { return false }
}
function readJson(file: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined
  } catch { return undefined }
}
function packageManager(root: string): PackageManager {
  if (exists(root, 'pnpm-lock.yaml')) return 'pnpm'
  if (exists(root, 'yarn.lock')) return 'yarn'
  if (exists(root, 'bun.lockb') || exists(root, 'bun.lock')) return 'bun'
  return 'npm'
}
function runScript(manager: PackageManager, script: string): { command: string; args: string[] } {
  // `npm test` and `npm run <x>` are the portable forms; on Windows the npm
  // shim is resolved by Core's verification runner, never through a shell.
  if (script === 'test') return { command: manager, args: ['test'] }
  return { command: manager, args: ['run', script] }
}
function nodeSuggestions(repository: Repository): VerificationSuggestion[] {
  const pkg = readJson(path.join(repository.path, 'package.json'))
  if (!pkg) return []
  const scripts = pkg.scripts && typeof pkg.scripts === 'object' && !Array.isArray(pkg.scripts) ? pkg.scripts as Record<string, unknown> : {}
  const manager = packageManager(repository.path)
  const out: VerificationSuggestion[] = []
  for (const candidate of SCRIPT_CANDIDATES) {
    const name = candidate.names.find((script) => typeof scripts[script] === 'string' && String(scripts[script]).trim() && !NPM_TEST_PLACEHOLDER.test(String(scripts[script])))
    if (name) out.push({ repositoryId: repository.id, ...runScript(manager, name), reason: `package.json ${candidate.label} "${name}"` })
  }
  if (!out.length) {
    const build = BUILD_SCRIPTS.find((script) => typeof scripts[script] === 'string' && String(scripts[script]).trim())
    if (build) out.push({ repositoryId: repository.id, ...runScript(manager, build), reason: `package.json build script "${build}" (no test or type check script found)` })
  }
  return out
}
function otherSuggestions(repository: Repository): VerificationSuggestion[] {
  const root = repository.path
  const windows = process.platform === 'win32'
  const out: VerificationSuggestion[] = []
  const add = (command: string, args: string[], reason: string) => out.push({ repositoryId: repository.id, command, args, reason })
  if (exists(root, 'Cargo.toml')) add('cargo', ['test'], 'Cargo.toml')
  if (exists(root, 'go.mod')) add('go', ['test', './...'], 'go.mod')
  if (exists(root, 'pyproject.toml') || exists(root, 'pytest.ini') || exists(root, 'setup.cfg') || exists(root, 'tox.ini')) {
    if (exists(root, 'tests') || exists(root, 'test') || exists(root, 'pytest.ini')) add(windows ? 'python' : 'python3', ['-m', 'pytest'], 'Python project with a tests directory')
  }
  if (exists(root, 'mix.exs')) add('mix', ['test'], 'mix.exs')
  if (exists(root, 'Package.swift')) add('swift', ['test'], 'Package.swift')
  if (exists(root, 'Gemfile') && exists(root, 'spec')) add('bundle', ['exec', 'rspec'], 'Gemfile with a spec directory')
  if (exists(root, 'pom.xml')) add(exists(root, windows ? 'mvnw.cmd' : 'mvnw') ? (windows ? 'mvnw.cmd' : './mvnw') : 'mvn', ['-q', 'test'], 'pom.xml')
  if (exists(root, 'build.gradle') || exists(root, 'build.gradle.kts')) add(exists(root, windows ? 'gradlew.bat' : 'gradlew') ? (windows ? 'gradlew.bat' : './gradlew') : 'gradle', ['test'], 'Gradle build')
  try {
    if (fs.readdirSync(root).some((name) => /\.(sln|csproj|fsproj)$/i.test(name))) add('dotnet', ['test'], '.NET solution or project')
  } catch { /* unreadable root: nothing to suggest */ }
  if (!out.length && !windows && exists(root, 'Makefile')) {
    try { if (/^test\s*:/m.test(fs.readFileSync(path.join(root, 'Makefile'), 'utf8'))) add('make', ['test'], 'Makefile test target') } catch { /* ignore */ }
  }
  return out
}

/** Deterministic, offline detection of a repository's own checks. Repositories
 *  with nothing recognisable produce no entry: the architect proposes commands
 *  at run time, and Core admits repositories that have no automated check. */
export function suggestVerificationCommands(repositories: Repository[]): VerificationSuggestion[] {
  const out: VerificationSuggestion[] = []
  for (const repository of repositories) {
    if (!repository.path || !fs.existsSync(repository.path)) continue
    const node = nodeSuggestions(repository)
    out.push(...(node.length ? node : otherSuggestions(repository)))
  }
  return out
}
