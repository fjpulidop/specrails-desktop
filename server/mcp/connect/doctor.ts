import fs from 'fs'
import path from 'path'
import { execFile } from 'child_process'
import { readClaudeEntry, readCodexEntry, type BridgeEntry, type ConnectClient, type ReadEntry, type RegisteredEntry } from './client-config'
import { configPathFor, detectClients, findOnPath, type ConnectEnv } from './connect'
import { isVersionedNodePath, type StableNode } from './node-path'
import { VERIFY_PROTOCOL, type VerifyResult } from './verify'

/**
 * `specrails-desktop mcp doctor` (`GET /api/mcp-admin/doctor`): diagnose an
 * external client's connection end to end and say what to do about each
 * problem. Read-only: it reads the client configs and the token file, runs the
 * registered entries once over stdio, and never writes anything.
 *
 * Every path and process seam is injectable (`DoctorInput`), so tests never
 * read the person's real ~/.claude.json, ~/.codex or ~/.specrails.
 */

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'skip'

export interface DoctorCheck {
  id: string
  status: CheckStatus
  title: string
  detail?: string
  /** What to do, when the status is warn or fail. */
  fix?: string
}

export interface DoctorVersions {
  app: string
  /** The MCP protocol version verify asks for, and the one the server answered. */
  protocol: string
  negotiatedProtocol?: string
  /** The catalog new external sessions get. */
  catalog: 'v1' | 'v2'
  advertisedTools: number
  node?: string
  /** The server version a connection test reached (the app, through the bridge). */
  server?: string
}

export interface DoctorReport {
  ok: boolean
  port: number
  checks: DoctorCheck[]
  versions: DoctorVersions
}

export interface DoctorFs {
  /** File text; null when it does not exist; throws when it cannot be read. */
  readText(file: string): string | null
  /** Permission bits, or null when missing. */
  mode(file: string): number | null
  isExecutable(file: string): boolean
  exists(file: string): boolean
}

export interface DoctorInput {
  cenv: ConnectEnv
  port: number
  /** Also check this directory's project-scope configs (and Claude's local scope for it). */
  projectDir?: string
  mcpEnabled: boolean
  /** The entry connect would write now; null when the bridge is not available. */
  expected: BridgeEntry | null
  /** How the expected entry's Node was chosen (source checkouts). */
  nodeSource?: StableNode
  tokenFile: string
  /** True when `value` is the token the running app accepts (compare in constant time). */
  tokenMatches: (value: string) => boolean
  versions: { app: string; catalog: 'v1' | 'v2'; advertisedTools: number }
  nodeVersion?: (command: string) => Promise<string | null>
  /** Omit to skip the stdio round trip. */
  verify?: (entry: BridgeEntry) => Promise<VerifyResult>
  fs?: DoctorFs
}

const CLIENT_NAMES: Record<ConnectClient, string> = { claude: 'Claude Code', codex: 'Codex' }
const MIN_NODE_MAJOR = 18
/** `specrails_wait` blocks up to 45 s; a shorter per-call timeout cuts it off. */
const MIN_CODEX_TIMEOUT_SEC = 50
const MAX_VERIFIED_ENTRIES = 3

export const defaultDoctorFs: DoctorFs = {
  readText(file) {
    try { return fs.readFileSync(file, 'utf8') } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
  },
  mode(file) { try { return fs.statSync(file).mode & 0o777 } catch { return null } },
  isExecutable(file) {
    try {
      const stat = fs.statSync(file)
      return stat.isFile() && (process.platform === 'win32' || (stat.mode & 0o111) !== 0)
    } catch { return false }
  },
  exists(file) { try { return fs.existsSync(file) } catch { return false } },
}

/** `node --version` of a command (absolute, or a name on PATH). */
export function defaultNodeVersion(command: string): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(command, ['--version'], { timeout: 5000, windowsHide: true }, (err, stdout) => resolve(err ? null : String(stdout).trim() || null))
    } catch { resolve(null) }
  })
}

const RANK: Record<CheckStatus, number> = { skip: 0, pass: 1, warn: 2, fail: 3 }
const worst = (statuses: CheckStatus[]): CheckStatus => statuses.reduce<CheckStatus>((a, b) => (RANK[b] > RANK[a] ? b : a), 'pass')

function bridgeScriptOf(args: readonly string[]): string | null {
  return args.find((arg) => /(^|[\\/])specrails-mcp(\.js)?$/i.test(arg.trim())) ?? null
}

function connectCommand(client: ConnectClient, scope: 'user' | 'project'): string {
  return `specrails-desktop mcp connect --client ${client}${scope === 'project' ? ' --scope project' : ''}`
}

interface Problem { status: 'warn' | 'fail'; text: string }

/** What is wrong with a registered Specrails entry, compared with this app's. */
function entryProblems(entry: RegisteredEntry, input: DoctorInput, dfs: DoctorFs, client: ConnectClient): Problem[] {
  const problems: Problem[] = []
  const command = entry.command
  if (!command) problems.push({ status: 'fail', text: 'The entry has no command.' })
  else if (path.isAbsolute(command)) {
    if (!dfs.isExecutable(command)) problems.push({ status: 'fail', text: `Its Node (${command}) does not exist any more.` })
    else if (isVersionedNodePath(command)) problems.push({ status: 'warn', text: `Its Node (${command}) is one installed version; it breaks when that version is upgraded or removed.` })
  } else if (findOnPath(command, input.cenv) === null) {
    problems.push({ status: 'fail', text: `Its command "${command}" is not on PATH.` })
  } else problems.push({ status: 'warn', text: `It runs "${command}" from the client's PATH, which may be another Node than the one tested here.` })
  const script = bridgeScriptOf(entry.args)
  const expectedScript = input.expected ? bridgeScriptOf(input.expected.args) : null
  if (script && !dfs.exists(script)) problems.push({ status: 'fail', text: `Its bridge script (${script}) does not exist.` })
  else if (script && expectedScript && path.resolve(script) !== path.resolve(expectedScript)) {
    problems.push({ status: 'warn', text: `It points at another install's bridge (${script}); this app's is ${expectedScript}.` })
  }
  const port = Number(entry.env.SPECRAILS_MCP_PORT ?? entry.env.SPECRAILS_PORT ?? 4200)
  if (port !== input.port) problems.push({ status: 'fail', text: `It points at port ${port}; Specrails listens on ${input.port}.` })
  const home = input.expected?.env.SPECRAILS_REGISTRY_HOME
  if ((entry.env.SPECRAILS_REGISTRY_HOME ?? undefined) !== home) {
    problems.push({ status: 'warn', text: `Its SPECRAILS_REGISTRY_HOME (${entry.env.SPECRAILS_REGISTRY_HOME ?? 'unset'}) differs from this app's (${home ?? 'unset'}), so the bridge reads another token.` })
  }
  if (client === 'codex' && entry.toolTimeoutSec !== undefined && entry.toolTimeoutSec < MIN_CODEX_TIMEOUT_SEC) {
    problems.push({ status: 'warn', text: `tool_timeout_sec = ${entry.toolTimeoutSec} cuts off specrails_wait (up to 45 s).` })
  }
  return problems
}

interface ConfigSlot { id: string; client: ConnectClient; scope: 'user' | 'project'; label: string; file: string; read: (text: string | null) => ReadEntry; optional: boolean }

function configSlots(input: DoctorInput): ConfigSlot[] {
  const slots: ConfigSlot[] = []
  const claudeUser = configPathFor('claude', 'user', input.cenv)
  slots.push({ id: 'client:claude', client: 'claude', scope: 'user', label: 'Claude Code (user)', file: claudeUser, read: (text) => readClaudeEntry(text), optional: false })
  if (input.projectDir) {
    const dir = input.projectDir
    slots.push({ id: 'client:claude-local', client: 'claude', scope: 'project', label: 'Claude Code (local, this folder)', file: claudeUser, read: (text) => readClaudeEntry(text, { projectDir: dir }), optional: true })
    slots.push({ id: 'client:claude-project', client: 'claude', scope: 'project', label: 'Claude Code (project)', file: configPathFor('claude', 'project', input.cenv, dir), read: (text) => readClaudeEntry(text), optional: true })
  }
  slots.push({ id: 'client:codex', client: 'codex', scope: 'user', label: 'Codex (user)', file: configPathFor('codex', 'user', input.cenv), read: readCodexEntry, optional: false })
  if (input.projectDir) {
    slots.push({ id: 'client:codex-project', client: 'codex', scope: 'project', label: 'Codex (project)', file: configPathFor('codex', 'project', input.cenv, input.projectDir), read: readCodexEntry, optional: true })
  }
  return slots
}

export async function runDoctor(input: DoctorInput): Promise<DoctorReport> {
  const dfs = input.fs ?? defaultDoctorFs
  const checks: DoctorCheck[] = []
  const versions: DoctorVersions = {
    app: input.versions.app, protocol: VERIFY_PROTOCOL, catalog: input.versions.catalog, advertisedTools: input.versions.advertisedTools,
  }

  checks.push({ id: 'app', status: 'pass', title: 'Specrails is running', detail: `Version ${input.versions.app}, port ${input.port}.` })
  checks.push(input.mcpEnabled
    ? { id: 'mcp_enabled', status: 'pass', title: 'The MCP server is on', detail: `New client sessions get the ${input.versions.catalog} catalog (${input.versions.advertisedTools} tools).` }
    : { id: 'mcp_enabled', status: 'fail', title: 'The MCP server is off', fix: 'Turn it on in Settings ▸ MCP.' })

  // The token: present, private and the one the app accepts. Its value is never reported.
  try {
    const text = dfs.readText(input.tokenFile)
    const value = text?.trim() ?? ''
    if (text === null) checks.push({ id: 'token', status: 'fail', title: 'The MCP token file is missing', detail: input.tokenFile, fix: 'Open Settings ▸ MCP (the app writes it), or restart Specrails.' })
    else if (!value) checks.push({ id: 'token', status: 'fail', title: 'The MCP token file is empty', detail: input.tokenFile, fix: 'Regenerate the token in Settings ▸ MCP.' })
    else if (!input.tokenMatches(value)) checks.push({ id: 'token', status: 'fail', title: 'The MCP token file does not match the running app', detail: input.tokenFile, fix: 'Regenerate the token in Settings ▸ MCP (or restart Specrails); connected clients pick it up on their next session.' })
    else {
      const mode = input.cenv.platform === 'win32' ? null : dfs.mode(input.tokenFile)
      checks.push(mode !== null && (mode & 0o077) !== 0
        ? { id: 'token', status: 'warn', title: 'The MCP token file is readable by other users', detail: `${input.tokenFile} (mode ${mode.toString(8)})`, fix: `chmod 600 ${input.tokenFile}` }
        : { id: 'token', status: 'pass', title: 'The MCP token file is present and private', detail: input.tokenFile })
    }
  } catch (err) {
    checks.push({ id: 'token', status: 'fail', title: 'The MCP token file cannot be read', detail: `${input.tokenFile}: ${(err as Error).message}`, fix: 'Run the client as the same OS user as Specrails.' })
  }

  // The bridge and the Node connect registers.
  const expected = input.expected
  const expectedScript = expected ? bridgeScriptOf(expected.args) : null
  if (!expected || !expectedScript) {
    checks.push({ id: 'bridge', status: 'fail', title: 'The MCP bridge is not available', fix: 'Reinstall Specrails; in a source checkout run `npm run build --prefix mcp-bridge`.' })
  } else if (!dfs.exists(expectedScript)) {
    checks.push({ id: 'bridge', status: 'fail', title: 'The MCP bridge script is missing', detail: expectedScript, fix: 'Reinstall Specrails; in a source checkout run `npm run build --prefix mcp-bridge`.' })
  } else checks.push({ id: 'bridge', status: 'pass', title: 'The MCP bridge is in place', detail: expectedScript })

  if (expected) {
    const command = expected.command
    const exists = path.isAbsolute(command) ? dfs.isExecutable(command) : findOnPath(command, input.cenv) !== null
    const version = exists ? await (input.nodeVersion ?? defaultNodeVersion)(command) : null
    if (version) versions.node = version
    const major = version ? Number(/^v?(\d+)/.exec(version)?.[1]) : NaN
    if (!exists) checks.push({ id: 'node', status: 'fail', title: 'The Node that runs the bridge is missing', detail: command, fix: 'Reinstall Specrails, or install Node and connect again.' })
    else if (!version) checks.push({ id: 'node', status: 'fail', title: 'The Node that runs the bridge does not start', detail: command, fix: 'Reinstall Specrails, or install a working Node and connect again.' })
    else if (major < MIN_NODE_MAJOR) checks.push({ id: 'node', status: 'fail', title: `Node ${version} is too old for the bridge`, detail: command, fix: `Install Node ${MIN_NODE_MAJOR} or newer, then connect again.` })
    else if (input.nodeSource?.warning || isVersionedNodePath(command)) {
      checks.push({ id: 'node', status: 'warn', title: `Node ${version} is a versioned path`, detail: command, fix: input.nodeSource?.warning ?? 'Put a stable `node` on PATH (for example `brew link node`), then connect again.' })
    } else checks.push({ id: 'node', status: 'pass', title: `Node ${version} runs the bridge`, detail: `${command}${input.nodeSource?.source === 'stable_link' ? ' (a stable link to this server\'s Node)' : ''}` })
  }

  // Each client's registered entry.
  const installed = new Map(detectClients(expected, input.cenv).map((row) => [row.client, row.installed]))
  const toVerify: BridgeEntry[] = []
  for (const slot of configSlots(input)) {
    let read: ReadEntry
    try { read = slot.read(dfs.readText(slot.file)) } catch (err) {
      checks.push({ id: slot.id, status: 'fail', title: `${slot.label}: cannot read its config`, detail: `${slot.file}: ${(err as Error).message}`, fix: 'Check the file\'s permissions.' })
      continue
    }
    if (read.state === 'missing') {
      if (slot.optional) continue
      checks.push(installed.get(slot.client)
        ? { id: slot.id, status: 'warn', title: `${slot.label}: not connected`, detail: slot.file, fix: connectCommand(slot.client, slot.scope) }
        : { id: slot.id, status: 'skip', title: `${CLIENT_NAMES[slot.client]} is not installed` })
      continue
    }
    if (read.state === 'invalid') {
      checks.push({ id: slot.id, status: 'fail', title: `${slot.label}: the config does not parse, or defines "specrails" in a layout connect does not edit`, detail: slot.file, fix: 'Fix the file by hand (connect never resets it), then connect again.' })
      continue
    }
    const entry = read.entry
    if (!entry.ours) {
      checks.push({ id: slot.id, status: 'warn', title: `${slot.label}: a "specrails" server that is not the Specrails bridge`, detail: slot.file, fix: `Rename that entry, or replace it: ${connectCommand(slot.client, slot.scope)} --force` })
      continue
    }
    const problems = entryProblems(entry, input, dfs, slot.client)
    const status = problems.length ? worst(problems.map((problem) => problem.status)) : 'pass'
    checks.push({
      id: slot.id, status,
      title: status === 'pass' ? `${slot.label}: connected` : `${slot.label}: connected, with problems`,
      detail: problems.length ? `${slot.file}. ${problems.map((problem) => problem.text).join(' ')}` : slot.file,
      ...(problems.length ? { fix: `${connectCommand(slot.client, slot.scope)} (rewrites only the "specrails" entry, with a backup)` } : {}),
    })
    if (status !== 'fail' && entry.command && toVerify.length < MAX_VERIFIED_ENTRIES) {
      const candidate: BridgeEntry = { command: entry.command, args: entry.args, env: entry.env }
      if (!toVerify.some((seen) => JSON.stringify(seen) === JSON.stringify(candidate))) toVerify.push(candidate)
    }
  }

  // A real round trip: what a client gets when it starts the entry.
  if (!input.verify) checks.push({ id: 'verify', status: 'skip', title: 'Connection test skipped' })
  else if (!input.mcpEnabled) checks.push({ id: 'verify', status: 'skip', title: 'Connection test skipped: the MCP server is off' })
  else {
    if (!toVerify.length && expected) toVerify.push(expected)
    if (!toVerify.length) checks.push({ id: 'verify', status: 'skip', title: 'Connection test skipped: no entry to run' })
    for (const [index, entry] of toVerify.entries()) {
      const result = await input.verify(entry)
      const id = toVerify.length > 1 ? `verify:${index + 1}` : 'verify'
      const which = toVerify.length > 1 ? ` (${entry.command} ${bridgeScriptOf(entry.args) ?? ''})` : ''
      if (result.serverVersion && !versions.server) versions.server = result.serverVersion
      if (result.protocolVersion) versions.negotiatedProtocol = result.protocolVersion
      const detail = [`${result.toolCount} tools`, result.instructions ? 'v2 instructions' : null, result.serverVersion ? `server ${result.serverVersion}` : null, result.overview ?? null, `${result.ms} ms`].filter(Boolean).join(' · ')
      if (!result.ok) checks.push({ id, status: 'fail', title: `Connection test failed${which}`, detail: result.error, fix: verifyFix(result.error) })
      else if (result.serverVersion && result.serverVersion !== input.versions.app) {
        checks.push({ id, status: 'warn', title: `Connection test reached another Specrails (${result.serverVersion})${which}`, detail, fix: `This app is ${input.versions.app} on port ${input.port}: run specrails-desktop mcp connect again from it.` })
      } else checks.push({ id, status: 'pass', title: `Connection test passed${which}`, detail })
    }
  }

  return { ok: !checks.some((check) => check.status === 'fail'), port: input.port, checks, versions }
}

function verifyFix(error: string | undefined): string {
  const text = error ?? ''
  if (/401|token/i.test(text)) return 'Run the client as the same OS user as Specrails; after a token rotation start a new client session.'
  if (/ECONNREFUSED|not running|connect/i.test(text)) return 'Start Specrails (the bridge connects to the running app), then try again.'
  if (/ENOENT|spawn/i.test(text)) return 'The entry\'s Node or bridge path is gone: run specrails-desktop mcp connect again.'
  return 'Run specrails-desktop mcp connect again; if it keeps failing, use Help ▸ Report a problem.'
}
