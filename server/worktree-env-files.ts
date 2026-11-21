/**
 * Opt-in copy of a project's gitignored environment files (`.env`,
 * `.env.local`, `.env.test`, `.env.<name>`) from the person's checkout into a
 * run worktree, so a repository whose tests need them (a Laravel `APP_KEY`)
 * does not always stop on an environment blocker. Project setting
 * `worktreeEnvFiles` (off by default); the delivery core calls
 * {@link syncWorktreeEnvFiles} on every materialization.
 *
 * What is copied, per repository (never anything else):
 * - a regular file (never a link, never a directory) directly in the
 *   repository root whose name is `.env` or `.env.<name>`, except the
 *   templates (`.env.example`, `.env.sample`, `.env.template`);
 * - at most {@link MAX_ENV_FILE_BYTES} bytes;
 * - not tracked by Git, neither in the person's checkout nor in the worktree;
 * - ignored by Git in the run worktree. A file the repository does not
 *   ignore is added, by exact root-anchored path, to a marked Specrails block
 *   of `info/exclude` (never to a `.gitignore`). Git reads that file from the
 *   common directory, so the person's checkout ignores the same paths too —
 *   the same mechanism as the never-stage block (`ensurePrNeverStageExcludes`).
 *   If the exclusion cannot be written or does not take, the file is skipped.
 *   Ignored files are never staged (`git add -A`), shown in status/diffs or
 *   committed.
 *
 * Copies are written atomically with mode 0600. Their worktree-relative paths
 * are recorded in a small manifest inside the worktree's private Git
 * directory; release/retention/recovery read it ({@link copiedEnvFilePaths})
 * so the copies are deleted with the worktree (never archived) and never
 * count as the run's own ignored output. Turning the setting off removes the
 * copies at the next materialization.
 */
import { randomBytes } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import type { GitRunner } from './worktree-manager'
import { checkoutSubdirectory } from './util/checkout-path'
import { getProjectRepositories, type RepositoryProject } from './project-repositories'

/** Largest env file that is copied. Bigger files are not configuration. */
export const MAX_ENV_FILE_BYTES = 256 * 1024
/** Manifest of the copies, inside the worktree's private Git directory. */
export const ENV_FILES_MANIFEST = 'specrails-env-files.json'

const ENV_NAME = /^\.env(?:\.[A-Za-z0-9_-][A-Za-z0-9_.-]*)?$/
const TEMPLATE_SEGMENTS = new Set(['example', 'sample', 'template'])

/** `.env` / `.env.<name>`, never a template (`.env.example`, `.env.sample.local`, …). */
export function isCopyableEnvFileName(name: string): boolean {
  if (!ENV_NAME.test(name) || name.length > 128) return false
  return !name.split('.').slice(2).some((segment) => TEMPLATE_SEGMENTS.has(segment.toLowerCase()))
}

export type EnvFileSkipReason = 'tracked' | 'not-ignored' | 'symlink' | 'not-a-file' | 'too-large' | 'unreadable' | 'destination-occupied'

export interface EnvFilesSyncResult {
  /** Worktree-relative paths written by this pass. */
  copied: string[]
  /** Worktree-relative paths removed (stale copies, or the setting is off). */
  removed: string[]
  skipped: Array<{ path: string; reason: EnvFileSkipReason }>
  /** Value-free degradation notes for the run log. */
  warnings: string[]
}

/** Absolute private Git directory of a linked worktree (`.git` is a file). */
function linkedGitDir(worktreePath: string): string | null {
  try {
    const dotGit = path.join(worktreePath, '.git')
    const stat = fs.lstatSync(dotGit)
    if (stat.isDirectory()) return dotGit
    if (!stat.isFile()) return null
    const match = /^gitdir:\s*(.+)\s*$/m.exec(fs.readFileSync(dotGit, 'utf8'))
    return match ? path.resolve(worktreePath, match[1]!.trim()) : null
  } catch {
    return null
  }
}

function safeRelative(value: unknown): string | null {
  if (typeof value !== 'string' || !value || value.includes('\0') || value.includes('\\') || path.posix.isAbsolute(value)) return null
  const parts = value.split('/')
  if (parts.some((part) => !part || part === '.' || part === '..')) return null
  return isCopyableEnvFileName(parts[parts.length - 1]!) ? value : null
}

function readManifest(worktreePath: string): string[] {
  const gitDir = linkedGitDir(worktreePath)
  if (!gitDir) return []
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(gitDir, ENV_FILES_MANIFEST), 'utf8')) as { paths?: unknown }
    return Array.isArray(parsed.paths) ? [...new Set(parsed.paths.map(safeRelative).filter((value): value is string => !!value))] : []
  } catch {
    return []
  }
}

function writeManifest(worktreePath: string, paths: readonly string[]): void {
  const gitDir = linkedGitDir(worktreePath)
  if (!gitDir) throw new Error('the worktree has no private Git directory')
  const target = path.join(gitDir, ENV_FILES_MANIFEST)
  if (paths.length === 0) { fs.rmSync(target, { force: true }); return }
  const tmp = `${target}.${randomBytes(6).toString('hex')}.tmp`
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, paths: [...paths].sort() }), { mode: 0o600, flag: 'wx' })
  fs.renameSync(tmp, target)
}

/** Every directory between the worktree and `rel` is a real directory. */
function reachedWithoutLinks(worktreePath: string, rel: string): boolean {
  let current = worktreePath
  for (const part of rel.split('/').slice(0, -1)) {
    current = path.join(current, part)
    try {
      const stat = fs.lstatSync(current)
      if (stat.isSymbolicLink() || !stat.isDirectory()) return false
    } catch {
      return false
    }
  }
  return true
}

/**
 * Worktree-relative paths of the env-file copies Specrails made that are
 * still regular files there. Used by release (delete, never archive),
 * retained-worktree evaluation and recovery (not the run's own output).
 */
export function copiedEnvFilePaths(worktreePath: string): string[] {
  return readManifest(worktreePath).filter((rel) => {
    if (!reachedWithoutLinks(worktreePath, rel)) return false
    try { return fs.lstatSync(path.join(worktreePath, ...rel.split('/'))).isFile() } catch { return false }
  })
}

/** Candidate names directly in `dir` (no Git, no reads of the contents). */
function candidateNames(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter(isCopyableEnvFileName).sort()
  } catch {
    return []
  }
}

async function gitList(git: GitRunner, cwd: string, args: string[]): Promise<Set<string> | null> {
  try {
    const result = await git.run(args, cwd)
    // check-ignore answers 1 when nothing matched.
    const checkIgnore = args.includes('check-ignore')
    if (result.code !== 0 && !(checkIgnore && result.code === 1)) return null
    // check-ignore has no -z without --stdin; the names are plain (see ENV_NAME) and quotePath is off.
    return new Set(result.stdout.split(checkIgnore ? '\n' : '\0').map((entry) => entry.trim()).filter(Boolean))
  } catch {
    return null
  }
}

/** Read one source file without following a link; null when it is not a small regular file. */
export const ENV_EXCLUDE_MARKER_BEGIN = '# >>> specrails env files (copied into run worktrees; never committed) >>>'
export const ENV_EXCLUDE_MARKER_END = '# <<< specrails env files <<<'

/** Root-anchored, glob-escaped exclude pattern for one worktree-relative path. */
function excludePattern(rel: string): string {
  return `/${rel.replace(/[\\*?[\]!#]/g, (char) => `\\${char}`)}`
}

/**
 * Add exact paths to the Specrails env block of the repository's
 * `info/exclude` (kept across runs; other entries untouched).
 */
async function excludeEnvPaths(git: GitRunner, worktreePath: string, rels: readonly string[]): Promise<boolean> {
  try {
    const resolved = await git.run(['rev-parse', '--git-path', 'info/exclude'], worktreePath)
    const raw = resolved.code === 0 ? resolved.stdout.trim() : ''
    if (!raw) return false
    const file = path.isAbsolute(raw) ? raw : path.join(worktreePath, raw)
    await fs.promises.mkdir(path.dirname(file), { recursive: true })
    const current = await fs.promises.readFile(file, 'utf8').catch(() => '')
    const begin = current.indexOf(ENV_EXCLUDE_MARKER_BEGIN)
    const end = begin >= 0 ? current.indexOf(ENV_EXCLUDE_MARKER_END, begin) : -1
    const existing = begin >= 0 && end > begin
      ? current.slice(begin + ENV_EXCLUDE_MARKER_BEGIN.length, end).split('\n').map((line) => line.trim()).filter(Boolean)
      : []
    const entries = [...new Set([...existing, ...rels.map(excludePattern)])].sort()
    const block = [ENV_EXCLUDE_MARKER_BEGIN, ...entries, ENV_EXCLUDE_MARKER_END].join('\n')
    // Replace the block in place (other managed blocks move themselves); else append it.
    const trimmed = current.replace(/\s+$/, '')
    const next = begin >= 0 && end > begin
      ? current.slice(0, begin) + block + current.slice(end + ENV_EXCLUDE_MARKER_END.length)
      : `${trimmed}${trimmed ? '\n\n' : ''}${block}\n`
    if (next !== current) await fs.promises.writeFile(file, next)
    return true
  } catch {
    return false
  }
}

async function readRegularFile(source: string): Promise<{ data: Buffer } | { skip: EnvFileSkipReason }> {
  let stat: fs.Stats
  try { stat = await fs.promises.lstat(source) } catch { return { skip: 'unreadable' } }
  if (stat.isSymbolicLink()) return { skip: 'symlink' }
  if (!stat.isFile()) return { skip: 'not-a-file' }
  if (stat.size > MAX_ENV_FILE_BYTES) return { skip: 'too-large' }
  let handle: fs.promises.FileHandle | null = null
  try {
    handle = await fs.promises.open(source, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
    const opened = await handle.stat()
    if (!opened.isFile() || opened.ino !== stat.ino) return { skip: 'unreadable' }
    if (opened.size > MAX_ENV_FILE_BYTES) return { skip: 'too-large' }
    const data = await handle.readFile()
    return data.length > MAX_ENV_FILE_BYTES ? { skip: 'too-large' } : { data }
  } catch {
    return { skip: 'unreadable' }
  } finally {
    await handle?.close().catch(() => {})
  }
}

async function removeCopy(worktreePath: string, rel: string): Promise<boolean> {
  if (!reachedWithoutLinks(worktreePath, rel)) return false
  const target = path.join(worktreePath, ...rel.split('/'))
  try {
    if (!(await fs.promises.lstat(target)).isFile()) return false
    await fs.promises.unlink(target)
    return true
  } catch {
    return false
  }
}

export interface SyncWorktreeEnvFilesInput {
  git: GitRunner
  /** The person's checkout (the project repository path). Only read. */
  repoDir: string
  worktreePath: string
  /** The project's `worktreeEnvFiles` setting. Off: remove earlier copies only. */
  enabled: boolean
}

/**
 * Bring the worktree's env-file copies in line with the setting and the
 * person's checkout: copy (or recopy) every eligible file, remove copies
 * whose source is gone, or remove all of them when the setting is off.
 * Never throws; failures are warnings and the run proceeds without the file.
 */
export async function syncWorktreeEnvFiles(input: SyncWorktreeEnvFilesInput): Promise<EnvFilesSyncResult> {
  const result: EnvFilesSyncResult = { copied: [], removed: [], skipped: [], warnings: [] }
  const previous = readManifest(input.worktreePath)
  const keep = new Set<string>()
  try {
    if (input.enabled) await copyEligible(input, result, keep)
    for (const rel of previous) {
      if (keep.has(rel)) continue
      if (await removeCopy(input.worktreePath, rel)) result.removed.push(rel)
    }
    if (previous.length > 0 || keep.size > 0) writeManifest(input.worktreePath, [...keep])
  } catch (err) {
    result.warnings.push(`Environment files: ${err instanceof Error ? err.message : String(err)}`)
  }
  return result
}

async function copyEligible(input: SyncWorktreeEnvFilesInput, result: EnvFilesSyncResult, keep: Set<string>): Promise<void> {
  const names = candidateNames(input.repoDir)
  if (names.length === 0) return
  // A project inside a larger checkout keeps its subdirectory in the worktree.
  const prefix = checkoutSubdirectory(input.repoDir)
  const rel = (name: string) => (prefix ? `${prefix}/${name}` : name)
  const destDir = path.join(input.worktreePath, ...(prefix ? prefix.split('/') : []))
  if (prefix && !reachedWithoutLinks(input.worktreePath, `${prefix}/x`)) {
    result.warnings.push('Environment files were not copied: the project folder is missing in the worktree.')
    return
  }
  const trackedHere = await gitList(input.git, input.repoDir, ['ls-files', '-z', '--', ...names])
  const trackedThere = await gitList(input.git, input.worktreePath, ['ls-files', '-z', '--', ...names.map(rel)])
  const ignored = await gitList(input.git, input.worktreePath, ['-c', 'core.quotePath=false', 'check-ignore', '--', ...names.map(rel)])
  if (!trackedHere || !trackedThere || !ignored) {
    result.warnings.push('Environment files were not copied: Git could not tell which ones are ignored.')
    return
  }
  // Untracked but not ignored by the repository: exclude exactly those paths, then re-check.
  const unignored = names.map(rel).filter((target, index) => !ignored.has(target) && !trackedHere.has(names[index]!) && !trackedThere.has(target))
  if (unignored.length > 0 && await excludeEnvPaths(input.git, input.worktreePath, unignored)) {
    const now = await gitList(input.git, input.worktreePath, ['-c', 'core.quotePath=false', 'check-ignore', '--', ...unignored])
    for (const target of now ?? []) ignored.add(target)
  }
  for (const name of names) {
    const target = rel(name)
    if (trackedHere.has(name) || trackedThere.has(target)) { result.skipped.push({ path: target, reason: 'tracked' }); continue }
    if (!ignored.has(target)) {
      result.skipped.push({ path: target, reason: 'not-ignored' })
      result.warnings.push(`${target} was not copied into the run: Git could not be made to ignore it, so it could be committed.`)
      continue
    }
    const source = await readRegularFile(path.join(input.repoDir, name))
    if ('skip' in source) { result.skipped.push({ path: target, reason: source.skip }); continue }
    const destination = path.join(destDir, name)
    try {
      const existing = await fs.promises.lstat(destination).catch(() => null)
      if (existing && !existing.isFile()) { result.skipped.push({ path: target, reason: 'destination-occupied' }); continue }
      const tmp = path.join(destDir, `.sr-env-${randomBytes(6).toString('hex')}.tmp`)
      try {
        await fs.promises.writeFile(tmp, source.data, { mode: 0o600, flag: 'wx' })
        await fs.promises.chmod(tmp, 0o600)
        await fs.promises.rename(tmp, destination)
      } finally {
        await fs.promises.rm(tmp, { force: true }).catch(() => {})
      }
      result.copied.push(target)
      keep.add(target)
    } catch (err) {
      result.warnings.push(`${target} could not be copied into the run: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

const ENV_LINE = /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_.-]*\s*=\s*(.*)$/
/** Shorter values are too common to replace literally ("true", "local"). */
export const MIN_ENV_SECRET_LENGTH = 8

/** The values assigned in a dotenv text (quotes and inline comments removed). */
export function envFileValues(text: string): string[] {
  const values: string[] = []
  for (const line of text.split(/\r?\n/)) {
    const match = ENV_LINE.exec(line)
    if (!match) continue
    let value = match[1]!.trim()
    const quote = value[0]
    if ((quote === '"' || quote === "'" || quote === '`') && value.indexOf(quote, 1) > 0) value = value.slice(1, value.indexOf(quote, 1))
    else value = value.replace(/\s+#.*$/, '').trim()
    if (value.length >= MIN_ENV_SECRET_LENGTH) values.push(value)
  }
  return values
}

/**
 * The values in the env files of these repository roots (the same files a
 * run would receive, without the Git checks: redacting more is harmless).
 * Used to redact problem reports and failure-analysis uploads. Sync, bounded.
 */
export function readEnvFileSecretValues(repoDirs: readonly string[]): string[] {
  const values = new Set<string>()
  for (const dir of repoDirs) {
    for (const name of candidateNames(dir)) {
      try {
        const file = path.join(dir, name)
        const stat = fs.lstatSync(file)
        if (!stat.isFile() || stat.size > MAX_ENV_FILE_BYTES) continue
        for (const value of envFileValues(fs.readFileSync(file, 'utf8'))) values.add(value)
      } catch { /* unreadable: nothing to redact */ }
    }
  }
  return [...values].sort((a, b) => b.length - a.length)
}

/** Replace every known env value in `text`. */
export function redactEnvValues(text: string, values: readonly string[]): string {
  let out = text
  for (const value of values) if (value.length >= MIN_ENV_SECRET_LENGTH) out = out.split(value).join('[redacted]')
  return out
}

/**
 * The env values of a project that copies its env files into runs (setting
 * `worktreeEnvFiles`), for redaction; empty when the setting is off.
 */
export function projectEnvFileSecretValues(project: RepositoryProject, enabled: boolean): string[] {
  if (!enabled) return []
  return readEnvFileSecretValues(getProjectRepositories(project).filter((repo) => repo.kind === 'git').map((repo) => repo.path))
}
