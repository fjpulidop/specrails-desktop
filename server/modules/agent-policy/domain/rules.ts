/**
 * The in-turn agent policy: which tool calls a Claude agent may not make,
 * whatever its permission mode. Evaluated by the PreToolUse hook script
 * (`../hook/policy-hook.ts`) before the tool runs.
 *
 * Deny list (and nothing else — everything not listed is left to the run's
 * own permission mode):
 * - `git-force-push`      any force push (flags, `+refspec`, `--mirror`)
 * - `git-push-protected`  a push to the integration/default branch, `main` or `master`
 * - `git-push-delete`     deleting a remote branch
 * - `git-reset-hard`      `git reset --hard` anywhere except on the run's own branch inside the run directory
 * - `git-branch-delete`   deleting a protected branch, the run's own branch, or any branch outside the run directory
 * - `gh-pr-merge`         merging a PR from inside a turn (PRs are merged by a person)
 * - `rm-outside-run`      recursive deletion (`rm -r`, `rimraf`, `find -delete`, `git clean -f`) outside the run directory or a temp dir
 * - `secret-access`       reading or writing ~/.ssh, ~/.aws, ~/.gnupg, keychains, or the Specrails secret store
 * - `policy-tamper`       writing the policy hook's own files
 * - `machine-install`     installing or changing a tool machine-wide (`brew install`, `npm i -g`,
 *                         `cargo install`, `rustup target add`, …): every project shares it, so the
 *                         run reports a toolchain blocker with the install; the host asks the person once
 *
 * Git rules come from `server/git-guardrails.ts` (single source of truth with
 * the app's own push path). Pure apart from the injected `facts` readers.
 */
import {
  branchDeleteTargets, isForcePush, isHardReset, pushDeletesRemoteBranch, pushDestinations,
} from '../../../git-guardrails'
import { joinPath, readScript, type ShellWord, type SimpleCommand } from './shell'

export const POLICY_RULES = [
  'git-force-push',
  'git-push-protected',
  'git-push-delete',
  'git-reset-hard',
  'git-branch-delete',
  'gh-pr-merge',
  'rm-outside-run',
  'secret-access',
  'policy-tamper',
  'machine-install',
  'policy-error',
] as const
export type PolicyRule = typeof POLICY_RULES[number]

export function isPolicyRule(value: unknown): value is PolicyRule {
  return typeof value === 'string' && (POLICY_RULES as readonly string[]).includes(value)
}

export interface PolicyDecision {
  rule: PolicyRule
  /** One sentence for the agent and the person: what was blocked and why. */
  reason: string
}

export interface GitFacts {
  /** Current branch of the repository containing `dir` (null: detached, unknown or not a repo). */
  branch: string | null
  /** The repository's default branch (`origin/HEAD`), when known. */
  defaultBranch: string | null
}

export interface PolicyFacts {
  /** The user's home (for `~`, ~/.ssh …). */
  home: string
  /** The directory that contains `.specrails/` (Specrails' own home override aware). */
  specrailsHome: string
  /** The run directory: Claude's project dir (worktree or the app-owned mission cwd). */
  projectDir: string
  /** The session's current working directory. */
  cwd: string
  /** Temp roots where recursive deletes are always fine. */
  tempDirs: readonly string[]
  /** Git facts for a directory. Must not throw. */
  git: (dir: string) => GitFacts
  /** Resolve symlinks of an existing prefix, keep the rest. Must not throw. */
  realpath: (p: string) => string
}

const ALWAYS_PROTECTED = ['main', 'master']
const SECRET_DIRS = ['.ssh', '.aws', '.gnupg', 'Library/Keychains']
const SECRET_STORE_FILES = ['jira-secret.key', 'desktop.token', 'hub.token', 'mcp.token']
const KEYCHAIN_SECRET_COMMANDS = new Set(['find-generic-password', 'find-internet-password', 'dump-keychain', 'export', 'unlock-keychain'])
const DYNAMIC_SECRET_HINT = /(^|\/)\.(ssh|aws|gnupg)(\/|$)|Library\/Keychains|jira-secret\.key|(^|\/)(desktop|hub|mcp)\.token$/
const PATH_TOOLS = new Set(['read', 'write', 'edit', 'multiedit', 'notebookedit', 'notebookread', 'grep', 'glob', 'ls'])
const WRITE_TOOLS = new Set(['write', 'edit', 'multiedit', 'notebookedit'])

/** Raw-text shapes of the deny list, used only when evaluation itself failed. */
export const DENY_LIST_HINT = /\bpush\b[^\n]*(--force|--mirror|\s-[a-zA-Z]*f\b|\s\+)|reset\s+--hard|branch\s+(-[a-zA-Z]*[dD]\b|--delete)|\brm\b[^\n]*\s-[a-zA-Z]*[rR]|--recursive|rimraf|-delete\b|\.ssh\b|\.aws\b|\.gnupg\b|Keychains|jira-secret|(desktop|hub|mcp)\.token|gh\s+pr\s+merge|agent-policy/

function within(child: string, parent: string): boolean {
  const p = parent.endsWith('/') ? parent : `${parent}/`
  return child === parent || child.startsWith(p)
}

function strictlyWithin(child: string, parent: string): boolean {
  return child !== parent && within(child, parent)
}

function policyDir(facts: PolicyFacts): string {
  return joinPath(facts.specrailsHome, '.specrails/agent-policy')
}

/** Absolute, normalised; null when unknowable. */
function resolveWord(word: ShellWord, cwd: string | null): string | null {
  if (word.dynamic) return null
  if (word.text.startsWith('/')) return joinPath('/', word.text)
  if (cwd === null) return null
  return joinPath(cwd, word.text)
}

function isSecretPath(abs: string, facts: PolicyFacts): boolean {
  const candidates = [abs, facts.realpath(abs)]
  for (const candidate of candidates) {
    for (const dir of SECRET_DIRS) if (within(candidate, joinPath(facts.home, dir))) return true
    if (within(candidate, '/Library/Keychains')) return true
    for (const file of SECRET_STORE_FILES) if (candidate === joinPath(facts.specrailsHome, `.specrails/${file}`)) return true
  }
  return false
}

function isPolicyPath(abs: string, facts: PolicyFacts): boolean {
  const dir = policyDir(facts)
  return within(abs, dir) || within(facts.realpath(abs), dir)
}

function protectedBranches(facts: PolicyFacts, dir: string | null): Set<string> {
  const set = new Set(ALWAYS_PROTECTED)
  const root = facts.git(facts.projectDir).defaultBranch
  if (root) set.add(root)
  if (dir) {
    const own = facts.git(dir).defaultBranch
    if (own) set.add(own)
  }
  return set
}

// ─── Git ─────────────────────────────────────────────────────────────────────

const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env'])

/** Split `git [global options] <sub> …` into the target dir and the subcommand args. */
function gitInvocation(command: SimpleCommand): { dir: string | null; args: string[]; uncertainDir: boolean } {
  const words = command.words.slice(1)
  let dir = command.cwd
  let uncertainDir = command.cwd === null
  let i = 0
  while (i < words.length) {
    const w = words[i]!
    if (!w.text.startsWith('-')) break
    if (w.text === '-C') {
      const target = words[i + 1]
      const resolved = target ? resolveWord(target, dir) : null
      if (resolved === null) uncertainDir = true
      dir = resolved
      i += 2
      continue
    }
    if (w.text.startsWith('--git-dir') || w.text.startsWith('--work-tree')) uncertainDir = true
    if (GIT_VALUE_OPTIONS.has(w.text)) { i += 2; continue }
    i++
  }
  return { dir, args: words.slice(i).map((w) => w.text), uncertainDir }
}

function evaluateGit(command: SimpleCommand, facts: PolicyFacts): PolicyDecision | null {
  const { dir, args, uncertainDir } = gitInvocation(command)
  const sub = args[0]
  if (!sub) return null
  if (sub === 'push') {
    if (isForcePush(args)) {
      return { rule: 'git-force-push', reason: 'Force-pushing rewrites shared history; Specrails never lets an agent force-push.' }
    }
    if (pushDeletesRemoteBranch(args)) {
      return { rule: 'git-push-delete', reason: 'Deleting a remote branch from inside a turn is not allowed.' }
    }
    const branch = dir && !uncertainDir ? facts.git(dir).branch : null
    const destinations = pushDestinations(args, branch)
    if (destinations.length === 0) {
      return { rule: 'git-push-protected', reason: 'Specrails could not tell which branch this push writes, so it was blocked. Push the run branch by name.' }
    }
    const protectedSet = protectedBranches(facts, uncertainDir ? null : dir)
    const hit = destinations.find((d) => protectedSet.has(d))
    if (hit) {
      return { rule: 'git-push-protected', reason: `Pushing to the integration branch "${hit}" is not allowed; work reaches it only through a pull request a person merges.` }
    }
    return null
  }
  if (sub === 'reset' && isHardReset(args)) {
    if (uncertainDir || dir === null || !within(dir, facts.projectDir)) {
      return { rule: 'git-reset-hard', reason: 'git reset --hard outside the run directory is not allowed.' }
    }
    const own = facts.git(facts.projectDir).branch
    const here = facts.git(dir).branch
    if (!own || here !== own || protectedBranches(facts, dir).has(own)) {
      return { rule: 'git-reset-hard', reason: 'git reset --hard is only allowed on the run\'s own branch.' }
    }
    return null
  }
  if (sub === 'branch') {
    const targets = branchDeleteTargets(args)
    if (targets.length === 0) return null
    if (uncertainDir || dir === null || !within(dir, facts.projectDir)) {
      return { rule: 'git-branch-delete', reason: 'Deleting branches outside the run directory is not allowed.' }
    }
    const protectedSet = protectedBranches(facts, dir)
    const own = facts.git(facts.projectDir).branch
    const hit = targets.find((t) => protectedSet.has(t.replace(/^origin\//, '')) || (own !== null && t === own))
    if (hit) return { rule: 'git-branch-delete', reason: `Deleting the branch "${hit}" is not allowed.` }
    return null
  }
  if (sub === 'clean' && args.slice(1).some((a) => a === '--force' || /^-[a-zA-Z]*f/.test(a))) {
    if (uncertainDir || dir === null || !within(dir, facts.projectDir)) {
      return { rule: 'rm-outside-run', reason: 'git clean outside the run directory is not allowed.' }
    }
  }
  return null
}

// ─── Recursive deletion ──────────────────────────────────────────────────────

function deletionAllowed(word: ShellWord, cwd: string | null, facts: PolicyFacts): boolean {
  if (word.dynamic) return false
  const text = word.text
  let target: string | null
  let globbed = false
  if (word.globAt !== -1) {
    globbed = true
    const prefix = text.slice(0, word.globAt)
    const staticDir = prefix.endsWith('/') ? prefix : prefix.includes('/') ? prefix.slice(0, prefix.lastIndexOf('/') + 1) : '.'
    target = resolveWord({ text: staticDir || '/', dynamic: false, globAt: -1 }, cwd)
  } else {
    target = resolveWord(word, cwd)
  }
  if (target === null) return false
  // Lexical AND resolved (a trailing slash follows a symlinked operand; a
  // plain operand is the link itself, so only its parent is resolved).
  const followsLink = globbed || text.endsWith('/') || text.endsWith('/.')
  const real = followsLink ? facts.realpath(target) : joinPath(facts.realpath(joinPath(target, '..')), target.split('/').pop() ?? '')
  const roots = [facts.projectDir, facts.realpath(facts.projectDir)]
  const temps = facts.tempDirs.flatMap((t) => [t, facts.realpath(t)])
  const ok = (p: string) => roots.some((root) => (globbed ? within(p, root) : strictlyWithin(p, root))) || temps.some((t) => (globbed ? within(p, t) && p !== t : strictlyWithin(p, t)))
  return ok(target) && ok(real)
}

function recursiveRmOperands(words: ShellWord[]): ShellWord[] | null {
  let recursive = false
  const operands: ShellWord[] = []
  let endOfFlags = false
  for (const w of words.slice(1)) {
    if (!endOfFlags && w.text === '--') { endOfFlags = true; continue }
    if (!endOfFlags && w.text.startsWith('-') && w.text.length > 1) {
      if (w.text === '--recursive' || (/^-[a-zA-Z]+$/.test(w.text) && /[rR]/.test(w.text))) recursive = true
      continue
    }
    operands.push(w)
  }
  return recursive ? operands : null
}

function evaluateDeletion(command: SimpleCommand, facts: PolicyFacts): PolicyDecision | null {
  const head = command.words[0]?.text
  let operands: ShellWord[] | null = null
  if (head === 'rm') operands = recursiveRmOperands(command.words)
  else if (head === 'rimraf') operands = command.words.slice(1).filter((w) => !w.text.startsWith('-'))
  else if (head === 'npx' && command.words[1]?.text === 'rimraf') operands = command.words.slice(2).filter((w) => !w.text.startsWith('-'))
  else if (head === 'find') {
    const texts = command.words.map((w) => w.text)
    const deletes = texts.includes('-delete') || texts.some((t, i) => (t === '-exec' || t === '-execdir') && /(^|\/)rm$/.test(texts[i + 1] ?? ''))
    if (!deletes) return null
    const paths: ShellWord[] = []
    for (const w of command.words.slice(1)) {
      if (w.text.startsWith('-') || w.text === '!' || w.text === '(') break
      paths.push(w)
    }
    operands = paths.length ? paths : [{ text: '.', dynamic: false, globAt: -1 }]
    // A find root is searched, not removed itself: its contents must be inside.
    operands = operands.map((w) => {
      if (w.globAt !== -1 || w.dynamic) return w
      const text = w.text.endsWith('/') ? `${w.text}*` : `${w.text}/*`
      return { ...w, text, globAt: text.length - 1 }
    })
  }
  if (operands === null) return null
  if (command.viaXargs) {
    return { rule: 'rm-outside-run', reason: 'A recursive delete whose targets come from xargs cannot be checked; delete explicit paths inside the run directory instead.' }
  }
  const bad = operands.find((w) => !deletionAllowed(w, command.cwd, facts))
  if (!bad) return null
  return { rule: 'rm-outside-run', reason: `Recursive deletion outside the run directory is not allowed (${bad.text || 'unknown path'}).` }
}

// ─── Secrets and tampering ───────────────────────────────────────────────────

function wordSecretHit(word: ShellWord, cwd: string | null, facts: PolicyFacts): 'secret' | 'policy' | null {
  if (word.dynamic) return DYNAMIC_SECRET_HINT.test(word.text) ? 'secret' : null
  // `--key-file=~/.ssh/id`: the value after `=` is a path too.
  const eq = word.text.indexOf('=')
  if (eq > 0 && eq < word.text.length - 1) {
    const value = expandTilde(word.text.slice(eq + 1), facts.home)
    const hit = wordSecretHit({ text: value, dynamic: false, globAt: -1 }, cwd, facts)
    if (hit) return hit
  }
  const abs = resolveWord(word, cwd)
  if (abs === null) return DYNAMIC_SECRET_HINT.test(word.text) ? 'secret' : null
  if (isSecretPath(abs, facts)) return 'secret'
  if (isPolicyPath(abs, facts)) return 'policy'
  return null
}

function evaluateSecrets(command: SimpleCommand, facts: PolicyFacts): PolicyDecision | null {
  const head = command.words[0]?.text
  if (head === 'security' && KEYCHAIN_SECRET_COMMANDS.has(command.words[1]?.text ?? '')) {
    return { rule: 'secret-access', reason: 'Reading the keychain is not allowed from an agent turn.' }
  }
  for (const word of [...command.words.slice(1), ...command.redirects]) {
    const hit = wordSecretHit(word, command.cwd, facts)
    if (hit === 'secret') return { rule: 'secret-access', reason: 'Credentials (~/.ssh, ~/.aws, ~/.gnupg, keychains, the Specrails secret store) are off limits to agents.' }
    if (hit === 'policy') return { rule: 'policy-tamper', reason: 'The Specrails policy hook files cannot be changed from an agent turn.' }
  }
  return null
}

// ─── Machine-wide installs ───────────────────────────────────────────────────

const PACKAGE_MANAGERS = new Set(['brew', 'apt', 'apt-get', 'dnf', 'yum', 'pacman', 'zypper', 'apk', 'port', 'choco', 'winget', 'scoop', 'snap', 'flatpak'])
const PACKAGE_MANAGER_VERBS = new Set(['install', 'reinstall', 'upgrade', 'uninstall', 'remove', 'update', 'tap', 'link', 'unlink', 'add', 'dist-upgrade'])
const GLOBAL_FLAGS = new Set(['-g', '--global', '--location=global'])
const VERSION_MANAGERS = new Set(['nvm', 'fnm', 'volta', 'asdf', 'mise', 'rtx', 'pyenv', 'rbenv', 'goenv', 'sdk', 'jenv', 'n'])
const VERSION_MANAGER_VERBS = new Set(['install', 'uninstall', 'global', 'default', 'alias', 'use', 'plugin', 'pin'])

/** A `gem install` with an explicit install dir stays out of the system gems. */
function gemIsLocal(command: SimpleCommand): boolean {
  return command.words.some((w) => w.text === '--install-dir' || w.text.startsWith('--install-dir=') || w.text === '-i')
}

function machineInstall(command: SimpleCommand): string | null {
  const words = command.words.map((w) => w.text)
  const [head, verb] = words
  if (!head) return null
  const tail = words.slice(1)
  if (PACKAGE_MANAGERS.has(head) && verb && PACKAGE_MANAGER_VERBS.has(verb)) return `${head} ${verb}`
  if (['npm', 'pnpm', 'bun'].includes(head) && tail.some((w) => GLOBAL_FLAGS.has(w)) && tail.some((w) => ['install', 'i', 'add', 'uninstall', 'remove', 'rm', 'update', 'link'].includes(w))) return `${head} ${verb} -g`
  if (head === 'yarn' && verb === 'global') return 'yarn global'
  if (head === 'cargo' && (verb === 'install' || verb === 'uninstall')) return `cargo ${verb}`
  if (head === 'go' && verb === 'install') return 'go install'
  if (head === 'gem' && (verb === 'install' || verb === 'uninstall' || verb === 'update') && !gemIsLocal(command)) return `gem ${verb}`
  if (head === 'pipx' && verb && ['install', 'uninstall', 'upgrade', 'inject', 'ensurepath'].includes(verb)) return `pipx ${verb}`
  if ((head === 'pip' || head === 'pip3') && verb === 'install' && tail.some((w) => w === '--user' || w === '--break-system-packages')) return `${head} install ${tail.includes('--user') ? '--user' : '--break-system-packages'}`
  if (head === 'rustup' && verb && (['update', 'default', 'self'].includes(verb) || (['target', 'toolchain', 'component'].includes(verb) && ['add', 'install', 'remove', 'uninstall'].includes(words[2] ?? '')))) return `rustup ${words.slice(1, verb === 'update' || verb === 'default' ? 2 : 3).join(' ')}`
  if (head === 'corepack' && (verb === 'enable' || verb === 'disable' || verb === 'install')) return `corepack ${verb}`
  if (VERSION_MANAGERS.has(head) && verb && VERSION_MANAGER_VERBS.has(verb) && !(head === 'n' && words.length < 3)) return `${head} ${verb}`
  if (head === 'dotnet' && ((verb === 'tool' && tail.some((w) => GLOBAL_FLAGS.has(w))) || verb === 'workload')) return `dotnet ${verb}`
  if (head === 'xcode-select' && tail.some((w) => w === '--install' || w === '-s' || w === '--switch')) return 'xcode-select'
  if (head === 'softwareupdate' || head === 'sdkmanager') return head
  return null
}

function evaluateMachineInstall(command: SimpleCommand): PolicyDecision | null {
  const what = machineInstall(command)
  if (!what) return null
  return {
    rule: 'machine-install',
    reason: `\`${what}\` changes this machine for every project, so a run never does it. Keep the work done, leave the task unticked and report a toolchain blocker with the exact install command (as \`install\` when the blocker has it): the host asks the person once and installs it outside the run.`,
  }
}

function evaluateCommand(command: SimpleCommand, facts: PolicyFacts): PolicyDecision | null {
  if (command.words.length === 0 && command.redirects.length === 0) return null
  const secret = evaluateSecrets(command, facts)
  if (secret) return secret
  const head = command.words[0]?.text
  if (head === 'git') return evaluateGit(command, facts)
  if (head === 'gh' && command.words[1]?.text === 'pr' && command.words[2]?.text === 'merge') {
    return { rule: 'gh-pr-merge', reason: 'Pull requests are merged by a person, not from inside an agent turn.' }
  }
  return evaluateMachineInstall(command) ?? evaluateDeletion(command, facts)
}

/** Evaluate a Bash command line. */
export function evaluateShell(script: string, facts: PolicyFacts): PolicyDecision | null {
  for (const command of readScript(script, { cwd: facts.cwd, home: facts.home })) {
    const decision = evaluateCommand(command, facts)
    if (decision) return decision
  }
  return null
}

function pathFields(input: Record<string, unknown>, tool: string): string[] {
  const out: string[] = []
  for (const key of ['file_path', 'path', 'notebook_path']) {
    const value = input[key]
    if (typeof value === 'string' && value.trim()) out.push(value)
  }
  // A Glob/Grep pattern that is itself a path (`~/.ssh/*`, `/Users/x/.aws/**`).
  if ((tool === 'glob' || tool === 'grep') && typeof input.pattern === 'string' && /^(~|\/)/.test(input.pattern)) out.push(input.pattern)
  return out
}

function expandTilde(p: string, home: string): string {
  if (p === '~') return home
  if (p.startsWith('~/')) return `${home}${p.slice(1)}`
  return p
}

/**
 * The decision for one tool call, or null to leave it to the permission mode.
 * `toolInput` is Claude's `tool_input` object.
 */
export function evaluateToolCall(toolName: string, toolInput: unknown, facts: PolicyFacts): PolicyDecision | null {
  const input = toolInput && typeof toolInput === 'object' && !Array.isArray(toolInput) ? toolInput as Record<string, unknown> : {}
  const tool = toolName.trim().toLowerCase()
  if (tool === 'bash') {
    const command = typeof input.command === 'string' ? input.command : ''
    return command ? evaluateShell(command, facts) : null
  }
  if (!PATH_TOOLS.has(tool)) return null
  for (const raw of pathFields(input, tool)) {
    const expanded = expandTilde(raw, facts.home)
    const globAt = expanded.search(/[*?[]/)
    const staticPart = globAt === -1 ? expanded : expanded.slice(0, globAt)
    const abs = staticPart.startsWith('/') ? joinPath('/', staticPart) : joinPath(facts.cwd, staticPart)
    if (isSecretPath(abs, facts) || (globAt !== -1 && DYNAMIC_SECRET_HINT.test(expanded))) {
      return { rule: 'secret-access', reason: 'Credentials (~/.ssh, ~/.aws, ~/.gnupg, keychains, the Specrails secret store) are off limits to agents.' }
    }
    if (WRITE_TOOLS.has(tool) && isPolicyPath(abs, facts)) {
      return { rule: 'policy-tamper', reason: 'The Specrails policy hook files cannot be changed from an agent turn.' }
    }
  }
  return null
}
