/**
 * Classify a `git` argv as read-only and derive the spawn environment for it.
 *
 * Why: a read such as `git status` or `git diff` refreshes the index as a side
 * effect and, to write that refresh back, takes `index.lock`. Specrails polls
 * status in user checkouts (git bar, checkout preflight) and in run worktrees
 * while an agent is working there (non-convergence fingerprint, settlement and
 * release checks). Each of those reads could make the agent's own
 * `git add`/`git commit` fail with "index.lock: File exists". Git's
 * `GIT_OPTIONAL_LOCKS=0` tells it to skip exactly those optional lock-taking
 * sub-operations; the requested read still completes and returns the same
 * answer. Writes are never affected: they keep their mandatory locks.
 *
 * Every Specrails git spawn routes its environment through
 * {@link gitInvocationEnv} so the rule lives in one place (the bounded exec,
 * the delivery `GitRunner`, the review/Changes reader, the git bar, the
 * diagnostics and the code explorer).
 *
 * The classifier is deliberately conservative: an unknown subcommand, or a
 * known one used in a form that can write (`branch -D`, `config <k> <v>`,
 * `symbolic-ref HEAD <ref>`), counts as a write and keeps Git's defaults.
 */
import * as path from 'path'

/** Global options that consume the FOLLOWING argv entry as their value. */
const GLOBAL_OPTIONS_WITH_VALUE = new Set(['-c', '-C', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env', '--super-prefix', '--list-cmds', '--attr-source'])

/** Subcommands that never write refs, the index or the working tree. */
const READ_ONLY_SUBCOMMANDS = new Set([
  'status', 'diff', 'diff-tree', 'diff-index', 'diff-files', 'log', 'show', 'whatchanged', 'shortlog',
  'rev-parse', 'rev-list', 'merge-base', 'cat-file', 'ls-files', 'ls-tree', 'ls-remote',
  'for-each-ref', 'show-ref', 'name-rev', 'describe', 'blame', 'annotate', 'grep',
  'check-ignore', 'check-attr', 'check-ref-format', 'check-mailmap', 'var', 'version', 'help',
  'count-objects', 'cherry', 'range-diff', 'verify-commit', 'verify-tag', 'fsck',
  // Writes loose objects (no refs, no index). Run against a disposable object
  // store by its callers; for lock purposes it is a read of the repository.
  'merge-tree',
])

/** `branch` flags that only list. Any other flag or a positional argument can write. */
const BRANCH_LIST_FLAGS = new Set(['--list', '-l', '-a', '--all', '-r', '--remotes', '-v', '-vv', '--verbose', '--show-current', '--no-color', '--color', '--column', '--no-column', '-i', '--ignore-case', '--omit-empty', '-q', '--quiet', '--no-abbrev'])
const BRANCH_LIST_FLAGS_WITH_VALUE = new Set(['--contains', '--no-contains', '--merged', '--no-merged', '--points-at', '--sort', '--format', '--abbrev'])

const CONFIG_READ_FLAGS = new Set(['--get', '--get-all', '--get-regexp', '--get-urlmatch', '--get-color', '--get-colorbool', '--list', '-l'])

export interface GitSubcommand {
  name: string
  /** Arguments after the subcommand. */
  rest: readonly string[]
}

/** The subcommand of a git argv, skipping global options (`-c k=v`, `-C dir`,
 *  `--literal-pathspecs`, `--git-dir=…`, …). Null when there is none. */
export function gitSubcommand(args: readonly string[]): GitSubcommand | null {
  let i = 0
  while (i < args.length) {
    const arg = args[i]
    if (!arg.startsWith('-')) return { name: arg, rest: args.slice(i + 1) }
    if (arg === '--') return null
    const eq = arg.indexOf('=')
    const flag = eq === -1 ? arg : arg.slice(0, eq)
    // `-cfoo=bar` / `-Cdir` glued forms take no separate value.
    const glued = (arg.startsWith('-c') || arg.startsWith('-C')) && !arg.startsWith('--') && arg.length > 2
    i += GLOBAL_OPTIONS_WITH_VALUE.has(flag) && eq === -1 && !glued ? 2 : 1
  }
  return null
}

function positionals(rest: readonly string[], valueFlags: ReadonlySet<string> = new Set()): { flags: string[]; positional: string[] } {
  const flags: string[] = []
  const positional: string[] = []
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]
    if (arg === '--') { positional.push(...rest.slice(i + 1)); break }
    if (arg.startsWith('-')) {
      const flag = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg
      flags.push(flag)
      if (valueFlags.has(flag) && !arg.includes('=')) i++
      continue
    }
    positional.push(arg)
  }
  return { flags, positional }
}

function isReadOnlyBranch(rest: readonly string[]): boolean {
  const { flags, positional } = positionals(rest, BRANCH_LIST_FLAGS_WITH_VALUE)
  if (!flags.every((flag) => BRANCH_LIST_FLAGS.has(flag) || BRANCH_LIST_FLAGS_WITH_VALUE.has(flag))) return false
  // `git branch --list <pattern>` filters; a bare positional creates a branch.
  return positional.length === 0 || flags.includes('--list') || flags.includes('-l')
}

function isReadOnlyConfig(rest: readonly string[]): boolean {
  const { flags, positional } = positionals(rest, new Set(['--file', '-f', '--blob', '--type', '--default']))
  if (flags.some((flag) => CONFIG_READ_FLAGS.has(flag))) return true
  // Git ≥ 2.46 subcommand form: `git config get <key>` / `git config list`.
  if (positional[0] === 'get' || positional[0] === 'list') return true
  // `git config <key>` with no value reads; `git config <key> <value>` writes.
  return positional.length === 1 && flags.every((flag) => ['--file', '-f', '--blob', '--type', '--default', '--global', '--system', '--local', '--worktree', '-z', '--null', '--show-origin', '--show-scope', '--name-only', '--includes', '--no-includes', '--bool', '--int', '--path'].includes(flag))
}

/** True when this git argv cannot change refs, the index or the working tree. */
export function isReadOnlyGitInvocation(args: readonly string[]): boolean {
  const sub = gitSubcommand(args)
  if (!sub) return false
  const { name, rest } = sub
  if (READ_ONLY_SUBCOMMANDS.has(name)) return true
  const first = rest.find((arg) => !arg.startsWith('-'))
  switch (name) {
    case 'worktree': return first === 'list'
    case 'branch': return isReadOnlyBranch(rest)
    case 'tag': {
      const { flags, positional } = positionals(rest, new Set(['--contains', '--no-contains', '--merged', '--no-merged', '--points-at', '--sort', '--format']))
      return flags.includes('-l') || flags.includes('--list') || (positional.length === 0 && !flags.some((flag) => ['-d', '--delete', '-a', '-s', '-u', '-f', '--force', '-m', '-F'].includes(flag)))
    }
    case 'remote': return first === undefined || first === 'get-url' || first === 'show'
    case 'config': return isReadOnlyConfig(rest)
    // `stash create` builds a commit object without touching refs or the index.
    case 'stash': return first === 'list' || first === 'show' || first === 'create'
    case 'symbolic-ref': {
      const { flags, positional } = positionals(rest, new Set(['-m']))
      return positional.length === 1 && !flags.includes('-d') && !flags.includes('--delete') && !flags.includes('-m')
    }
    case 'notes': return first === 'list' || first === 'show'
    case 'reflog': return first === undefined || first === 'show' || first === 'exists'
    default: return false
  }
}

/** True when `command` names the git executable (`git`, `/usr/bin/git`, `git.exe`). */
export function isGitCommand(command: string): boolean {
  const base = path.basename(command).toLowerCase()
  return base === 'git' || base === 'git.exe'
}

/**
 * The environment for spawning `git <args>`: the caller's base env unchanged
 * for a write, plus `GIT_OPTIONAL_LOCKS=0` for a read. `base` undefined means
 * "inherit process.env" (what child_process does with no env); the returned
 * env is then a copy only when something had to be added.
 */
export function gitInvocationEnv(base: NodeJS.ProcessEnv | undefined, args: readonly string[]): NodeJS.ProcessEnv | undefined {
  if (!isReadOnlyGitInvocation(args)) return base
  return { ...(base ?? process.env), GIT_OPTIONAL_LOCKS: '0' }
}
