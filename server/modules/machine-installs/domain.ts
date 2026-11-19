/**
 * Machine-wide installs a run asks the person for (Core capability `machineInstalls`): pure rules.
 *
 * A run never installs anything machine-wide itself (the agent policy denies it). When only such an
 * install provides a missing tool, Core pauses the run on ONE question interrupt that names the exact
 * command (`data: { kind: 'machine-install', command, tool }`). The host runs an approved command
 * itself, outside the run, and answers `installed`.
 *
 * The host runs ONLY a command this parser accepts: one installer from a fixed allowlist of shapes,
 * plain package names, no shell (argv is spawned directly), no metacharacters, no scripts, no sudo.
 * A shape that needs an administrator password (system package managers, `sudo …`) is the person's
 * to run; anything else is refused. Approvals are remembered by the normalized command.
 */

/** Core's answer vocabulary (contract 5.17 `machineInstalls`). Only `installed` lets the run go on. */
export const INSTALL_ANSWERS = { installed: 'installed', declined: 'declined', failed: 'failed', refused: 'refused' } as const
/** The structured option ids the question carries. */
export const INSTALL_OPTION = { install: 'install', self: 'self' } as const

export type ParsedInstall =
  | { ok: true; command: string; argv: string[]; manager: string; tool: string }
  | { ok: false; reason: 'unsafe' | 'needs-admin' | 'unsupported'; detail: string }

/** The machine-install question a pending Core interrupt carries, or null for any other interrupt. */
export interface InstallQuestion { command: string; tool: string }

export function installQuestionOf(interrupt: { kind?: unknown; value?: unknown } | null | undefined): InstallQuestion | null {
  if (!interrupt || interrupt.kind !== 'question' || !interrupt.value || typeof interrupt.value !== 'object') return null
  const data = (interrupt.value as { data?: unknown }).data
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  const record = data as Record<string, unknown>
  if (record.kind !== 'machine-install' || typeof record.command !== 'string' || !record.command.trim()) return null
  const tool = typeof record.tool === 'string' && record.tool.trim() ? record.tool.trim().slice(0, 120) : ''
  return { command: record.command.trim().slice(0, 300), tool }
}

// Characters a shell would interpret. None may appear outside quotes; inside quotes only `;`
// (an Android SDK package id, `"platforms;android-34"`) is allowed.
const META = new Set([';', '&', '|', '<', '>', '$', '`', '\\', '(', ')', '{', '}', '*', '?', '!', '#', '\n', '\r', '\t', '\0', '\'', '"'])

/** Split one command line into words, or null when it holds anything a shell would interpret. */
export function splitCommand(text: string): Array<{ text: string; quoted: boolean }> | null {
  const words: Array<{ text: string; quoted: boolean }> = []
  let current = '', quoted = false, quote: string | null = null, started = false
  for (const char of text.trim()) {
    if (quote) {
      if (char === quote) { quote = null; continue }
      if (char !== ';' && META.has(char)) return null
      current += char
      continue
    }
    if (char === ' ') {
      if (started) words.push({ text: current, quoted })
      current = ''; quoted = false; started = false
      continue
    }
    if ((char === '"' || char === '\'') && !started) { quote = char; quoted = true; started = true; continue }
    if (META.has(char)) return null
    current += char; started = true
  }
  if (quote) return null
  if (started) words.push({ text: current, quoted })
  return words.length ? words : null
}

const PACKAGE = /^[A-Za-z0-9@][A-Za-z0-9@._+/=~^-]{0,199}$/
const SDK_PACKAGE = /^[A-Za-z0-9._-]+(?:;[A-Za-z0-9._-]+)*$/
const MAX_PACKAGES = 10
/** Package managers that write system directories: always the person's, with their password. */
const ADMIN_MANAGERS = new Set(['apt', 'apt-get', 'dnf', 'yum', 'pacman', 'zypper', 'apk', 'snap', 'port', 'choco', 'flatpak', 'softwareupdate', 'xcode-select'])

const isPackage = (word: { text: string; quoted: boolean }): boolean =>
  !word.quoted && PACKAGE.test(word.text) && !word.text.includes('..') && !word.text.includes('//') && !word.text.endsWith('/')

interface Shape {
  /** Words that must open the command, in order (after the program). */
  verbs: string[][]
  /** Flags the shape accepts anywhere after the verbs; `required` must appear once. */
  flags?: string[]
  required?: string[]
  /** How a package reads to the person. */
  tool?: (name: string) => string
  /** Each package must also match this. */
  package?: (word: { text: string; quoted: boolean }) => boolean
}

const lastSegment = (name: string): string => name.split('/').pop()!.replace(/@[^@]*$/, '') || name
const GLOBAL = ['-g', '--global']

const SHAPES: Record<string, Shape> = {
  brew: { verbs: [['install'], ['upgrade']], flags: ['--cask', '--formula'], tool: lastSegment },
  npm: { verbs: [['install'], ['i']], flags: GLOBAL, required: GLOBAL, tool: name => name.replace(/(.)@.*$/, '$1') },
  pnpm: { verbs: [['add'], ['install'], ['i']], flags: GLOBAL, required: GLOBAL, tool: name => name.replace(/(.)@.*$/, '$1') },
  bun: { verbs: [['add'], ['install'], ['i']], flags: GLOBAL, required: GLOBAL, tool: name => name.replace(/(.)@.*$/, '$1') },
  yarn: { verbs: [['global', 'add']], tool: name => name.replace(/(.)@.*$/, '$1') },
  cargo: { verbs: [['install']], flags: ['--locked'], tool: name => name.replace(/@.*$/, '') },
  go: { verbs: [['install']], tool: lastSegment, package: word => /^[a-z0-9.-]+\.[a-z]{2,}\/[^@]+@[A-Za-z0-9._+-]+$/i.test(word.text) },
  gem: { verbs: [['install']], flags: ['--user-install', '--no-document'] },
  pipx: { verbs: [['install']] },
  pip: { verbs: [['install']], flags: ['--user'], required: ['--user'], tool: name => name.replace(/[=<>~].*$/, '') },
  pip3: { verbs: [['install']], flags: ['--user'], required: ['--user'], tool: name => name.replace(/[=<>~].*$/, '') },
  rustup: { verbs: [['target', 'add'], ['component', 'add'], ['toolchain', 'install']] },
  dotnet: { verbs: [['tool', 'install']], flags: GLOBAL, required: GLOBAL },
  scoop: { verbs: [['install']] },
  winget: { verbs: [['install']], flags: ['--exact', '-e'] },
  sdkmanager: { verbs: [[]], package: word => SDK_PACKAGE.test(word.text) },
}

/**
 * Parse an install the run asked for. `ok` means the host may run `argv` (no shell) once the
 * person approved it; otherwise `reason` says why it stays the person's.
 */
export function parseInstallCommand(raw: string): ParsedInstall {
  const text = raw.trim().replace(/^`+|`+$/g, '').trim()
  if (!text || text.length > 300) return { ok: false, reason: 'unsupported', detail: 'the install command is empty or too long' }
  const words = splitCommand(text)
  if (!words) return { ok: false, reason: 'unsafe', detail: 'the command contains characters a shell would interpret' }
  const head = words[0]!
  if (head.quoted || !/^[a-z][a-z0-9.-]*$/.test(head.text)) return { ok: false, reason: 'unsupported', detail: `\`${head.text}\` is not an installer Specrails runs` }
  if (head.text === 'sudo' || head.text === 'doas') return { ok: false, reason: 'needs-admin', detail: 'it needs an administrator password' }
  if (ADMIN_MANAGERS.has(head.text)) return { ok: false, reason: 'needs-admin', detail: `${head.text} installs need an administrator password` }
  const shape = SHAPES[head.text]
  if (!shape) return { ok: false, reason: 'unsupported', detail: `\`${head.text}\` is not an installer Specrails runs` }
  const rest = words.slice(1)
  const verbs = shape.verbs.find(candidate => candidate.every((verb, index) => !rest[index]?.quoted && rest[index]?.text === verb))
  if (!verbs) return { ok: false, reason: 'unsupported', detail: `only ${shape.verbs.map(verb => [head.text, ...verb].join(' ')).join(', ')} can be run for you` }
  const flags: string[] = [], packages: Array<{ text: string; quoted: boolean }> = []
  for (const word of rest.slice(verbs.length)) {
    if (!word.quoted && word.text.startsWith('-')) {
      if (!shape.flags?.includes(word.text)) return { ok: false, reason: 'unsupported', detail: `the option ${word.text} is not one Specrails runs` }
      if (!flags.includes(word.text)) flags.push(word.text)
      continue
    }
    if (!(shape.package ? shape.package(word) : isPackage(word))) return { ok: false, reason: 'unsupported', detail: `\`${word.text}\` is not a plain package name` }
    packages.push(word)
  }
  if (!packages.length || packages.length > MAX_PACKAGES) return { ok: false, reason: 'unsupported', detail: 'the command names no package, or too many' }
  if (shape.required && !flags.some(flag => shape.required!.includes(flag))) return { ok: false, reason: 'unsupported', detail: 'the command does not say where it installs' }
  const argv = [head.text, ...verbs, ...flags, ...packages.map(word => word.text)]
  const command = [head.text, ...verbs, ...flags, ...packages.map(word => word.text.includes(';') ? `"${word.text}"` : word.text)].join(' ')
  const tool = packages.map(word => (shape.tool ?? ((name: string) => name))(word.text)).join(', ')
  return { ok: true, command, argv, manager: head.text, tool }
}

/** The answer Core receives for a finished host install. */
export function installAnswer(outcome: { ok: true } | { ok: false; detail: string }): string {
  return outcome.ok ? INSTALL_ANSWERS.installed : `${INSTALL_ANSWERS.failed}: ${outcome.detail.replace(/\s+/g, ' ').trim().slice(0, 400)}`
}

/** The answer for an install the host does not run (it would need a password or is not on the allowlist). */
export function refusedAnswer(parsed: Extract<ParsedInstall, { ok: false }>): string {
  return `${INSTALL_ANSWERS.refused}: ${parsed.detail}`
}
