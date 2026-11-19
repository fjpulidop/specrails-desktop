import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { gitInvocationEnv } from '../../../util/git-invocation'

/** A verification command Desktop can propose for a repository without any model call. */
export interface VerificationSuggestion {
  repositoryId: string
  command: string
  args: string[]
  /** What was detected, for the settings UI. */
  reason: string
  cwd?: string
}

interface Repository { id: string; path: string; workspacePaths?: string[]; workspacePath?: string }
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
  const declared = readJson(path.join(root, 'package.json'))?.packageManager
  const named = typeof declared === 'string' ? /^(npm|pnpm|yarn|bun)@/.exec(declared.trim())?.[1] as PackageManager | undefined : undefined
  if (exists(root, 'pnpm-lock.yaml')) return 'pnpm'
  if (exists(root, 'yarn.lock')) return 'yarn'
  if (exists(root, 'bun.lockb') || exists(root, 'bun.lock')) return 'bun'
  return named ?? 'npm'
}
/**
 * The command that runs the repository's package manager. A manager the
 * repository uses (its lockfile, or `packageManager`) but the host does not
 * have on PATH (no global yarn, no corepack on Node 25) runs through `npx`
 * at the version the repository pins, so verification works instead of
 * ending in `spawn yarn ENOENT`. Nothing is installed globally.
 */
function managerCommand(manager: PackageManager, pkg: Record<string, unknown>, findExecutable: (name: string) => string | null): { command: string; prefix: string[] } {
  if (manager === 'npm' || findExecutable(process.platform === 'win32' ? `${manager}.cmd` : manager) || findExecutable(manager)) return { command: manager, prefix: [] }
  const pinned = typeof pkg.packageManager === 'string' ? /^(yarn|pnpm|bun)@([0-9][^+\s]*)/.exec(pkg.packageManager.trim()) : null
  const version = pinned && pinned[1] === manager ? pinned[2] : manager === 'yarn' ? '1' : 'latest'
  return { command: 'npx', prefix: ['--yes', `${manager}@${version}`] }
}
function runScript(manager: PackageManager, script: string, invocation: { command: string; prefix: string[] } = { command: manager, prefix: [] }): { command: string; args: string[] } {
  // `npm test` and `npm run <x>` are the portable forms; on Windows the npm
  // shim is resolved by Core's verification runner, never through a shell.
  if (script === 'test') return { command: invocation.command, args: [...invocation.prefix, 'test'] }
  return { command: invocation.command, args: [...invocation.prefix, 'run', script] }
}
function nodeSuggestions(repository: Repository, findExecutable: (name: string) => string | null = defaultProbe.findExecutable): VerificationSuggestion[] {
  const pkg = readJson(path.join(repository.path, 'package.json'))
  if (!pkg) return []
  const scripts = pkg.scripts && typeof pkg.scripts === 'object' && !Array.isArray(pkg.scripts) ? pkg.scripts as Record<string, unknown> : {}
  const manager = packageManager(repository.path)
  const invocation = managerCommand(manager, pkg, findExecutable)
  const out: VerificationSuggestion[] = []
  for (const candidate of SCRIPT_CANDIDATES) {
    const name = candidate.names.find((script) => typeof scripts[script] === 'string' && String(scripts[script]).trim() && !NPM_TEST_PLACEHOLDER.test(String(scripts[script])))
    if (name) out.push({ repositoryId: repository.id, ...runScript(manager, name, invocation), reason: `package.json ${candidate.label} "${name}"` })
  }
  if (!out.length) {
    const build = BUILD_SCRIPTS.find((script) => typeof scripts[script] === 'string' && String(scripts[script]).trim())
    if (build) out.push({ repositoryId: repository.id, ...runScript(manager, build, invocation), reason: `package.json build script "${build}" (no test or type check script found)` })
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
export function suggestVerificationCommands(repositories: Repository[], findExecutable: (name: string) => string | null = defaultProbe.findExecutable): VerificationSuggestion[] {
  const out: VerificationSuggestion[] = []
  for (const repository of repositories) {
    const workspaces = repository.workspacePaths ?? (repository.workspacePath ? [repository.workspacePath] : [repository.path])
    for (const workspace of workspaces) {
      if (!workspace || !fs.existsSync(workspace)) continue
      const member = { ...repository, path: workspace }
      const node = nodeSuggestions(member, findExecutable)
      const checks = node.length ? node : otherSuggestions(member)
      const cwd = path.relative(repository.path, workspace).split(path.sep).join('/')
      out.push(...checks.map(check => cwd ? { ...check, cwd, reason: `${cwd}: ${check.reason}` } : check))
    }
  }
  return out
}

/** A host command for `setup` or `verification` (the settings entry shape). */
export interface PlannedHostCommand { repositoryId: string; command: string; args: string[]; cwd?: string; key?: string; label?: string }
/** Setup that builds a project virtual environment with the pinned interpreter, and checks that run in it. */
export interface PythonEnvironmentPlan { version: string; setup: PlannedHostCommand[]; verification: PlannedHostCommand[]; reason: string }
export interface PythonEnvironmentProbe {
  /** Absolute path of an executable on the host PATH, or null. */
  findExecutable(name: string): string | null
  /** True when Git ignores the path in the repository (a venv must never be committed). */
  ignored(root: string, relative: string): boolean
}

const defaultProbe: PythonEnvironmentProbe = {
  findExecutable(name) {
    for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
      if (!dir) continue
      const file = path.join(dir, name)
      try { fs.accessSync(file, fs.constants.X_OK); if (fs.statSync(file).isFile()) return file } catch { /* not here */ }
    }
    return null
  },
  ignored(root, relative) {
    const result = spawnSync('git', ['check-ignore', '-q', '--', relative], { cwd: root, env: gitInvocationEnv(undefined, ['check-ignore']), timeout: 5000, windowsHide: true, stdio: 'ignore' })
    return result.status === 0
  },
}

/** The Python version the project pins: its image (`FROM python:3.11-slim`) or a version file. Ranges are not pins. */
export function pinnedPythonVersion(root: string): { version: string; source: string } | null {
  const read = (relative: string): string => { try { return fs.readFileSync(path.join(root, relative), 'utf8') } catch { return '' } }
  const dockerfiles: string[] = []
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.isFile() && /^Dockerfile(?:\.[\w.-]+)?$/.test(entry.name)) dockerfiles.push(entry.name)
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
        try { for (const child of fs.readdirSync(path.join(root, entry.name))) if (/^Dockerfile(?:\.[\w.-]+)?$/.test(child)) dockerfiles.push(`${entry.name}/${child}`) } catch { /* unreadable */ }
      }
    }
  } catch { return null }
  for (const file of dockerfiles.sort()) {
    const match = /^\s*FROM\s+(?:--platform=\S+\s+)?(?:[\w.-]+\/)*python:(\d+\.\d+)/im.exec(read(file))
    if (match) return { version: match[1]!, source: `${file} FROM python:${match[1]}` }
  }
  const pinned = /^(\d+\.\d+)/.exec(read('.python-version').trim()) ?? /python-(\d+\.\d+)/.exec(read('runtime.txt')) ?? /^\s*python\s+(\d+\.\d+)/m.exec(read('.tool-versions'))
  return pinned ? { version: pinned[1]!, source: '.python-version / runtime.txt / .tool-versions' } : null
}

/**
 * When a Python project pins an interpreter, run its checks in a project venv built from that
 * interpreter instead of the system python3 (which may be several versions newer and refuse
 * installs under PEP 668). Proposed only when the pinned interpreter is on the host PATH and Git
 * ignores `.venv`, so the environment is never committed. Null when that does not hold.
 */
export function pythonEnvironmentPlan(repository: { id: string; path: string }, probe: PythonEnvironmentProbe = defaultProbe): PythonEnvironmentPlan | null {
  const root = repository.path
  if (process.platform === 'win32') return null
  const python = exists(root, 'pyproject.toml') || exists(root, 'requirements.txt') || exists(root, 'setup.py')
  const tests = exists(root, 'tests') || exists(root, 'test') || exists(root, 'pytest.ini')
  if (!python || !tests) return null
  const pin = pinnedPythonVersion(root)
  if (!pin) return null
  const interpreter = `python${pin.version}`
  if (!probe.findExecutable(interpreter) || !probe.ignored(root, '.venv')) return null
  const requirements: string[] = []
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.isFile() && /^requirements(?:[-_.][\w-]+)?\.txt$/.test(entry.name)) requirements.push(entry.name)
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
        try { for (const child of fs.readdirSync(path.join(root, entry.name))) if (/^requirements(?:[-_.][\w-]+)?\.txt$/.test(child)) requirements.push(`${entry.name}/${child}`) } catch { /* unreadable */ }
      }
    }
  } catch { return null }
  const install = requirements.length ? requirements.sort().flatMap(file => ['-r', file]) : exists(root, 'pyproject.toml') ? ['-e', '.'] : null
  if (!install) return null
  const id = repository.id
  return {
    version: pin.version,
    reason: `${pin.source}; Python ${pin.version} venv (.venv is git-ignored)`,
    setup: [
      { repositoryId: id, label: `Create the project venv (Python ${pin.version})`, command: interpreter, args: ['-m', 'venv', '.venv'] },
      { repositoryId: id, label: 'Install Python dependencies into the venv', command: '.venv/bin/python', args: ['-m', 'pip', 'install', '-q', ...install] },
    ],
    verification: [{ repositoryId: id, label: `pytest (Python ${pin.version} venv)`, command: '.venv/bin/python', args: ['-m', 'pytest'] }],
  }
}

type HostCommandLike = { repositoryId: string; command: string; args: string[]; cwd?: string }
const sameCommand = (a: HostCommandLike, b: HostCommandLike): boolean => a.repositoryId === b.repositoryId && a.command === b.command && JSON.stringify(a.args) === JSON.stringify(b.args) && (a.cwd ?? '') === (b.cwd ?? '')
/** A bare system-interpreter pytest the venv plan replaces (anything else the person configured stays). */
const barePytest = (check: HostCommandLike): boolean => /^python(?:3)?$/.test(check.command) && JSON.stringify(check.args) === JSON.stringify(['-m', 'pytest']) && !check.cwd

/** True when the project settings already carry the plan (its setup and its checks). */
export function environmentPlanApplied(config: { setup?: HostCommandLike[]; verification: HostCommandLike[] }, plan: PythonEnvironmentPlan): boolean {
  return plan.setup.every(command => config.setup?.some(item => sameCommand(item, command)))
    && plan.verification.every(command => config.verification.some(item => sameCommand(item, command)))
}

/**
 * Settings with the plan merged: its setup appended once, a bare `python3 -m pytest` for that
 * repository replaced by the venv check, every other configured command kept as it was.
 */
export function mergeEnvironmentPlan<T extends { setup?: HostCommandLike[]; verification: HostCommandLike[] }>(config: T, plan: PythonEnvironmentPlan): T {
  const repositoryId = plan.verification[0]?.repositoryId
  const setup = [...(config.setup ?? []), ...plan.setup.filter(command => !config.setup?.some(item => sameCommand(item, command)))]
  const kept = config.verification.filter(check => !(check.repositoryId === repositoryId && barePytest(check)))
  const verification = [...kept, ...plan.verification.filter(command => !kept.some(item => sameCommand(item, command)))]
  return { ...config, setup, verification }
}
