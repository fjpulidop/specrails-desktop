import { bold, dim, red, cliError } from './output'
import { detectWebManager, httpGet, httpPost } from './desktop-client'

/**
 * `specrails-desktop mcp connect|status|disconnect`: register the Specrails MCP
 * server with Claude Code or Codex in one command.
 *
 * The running app does the work (`/api/mcp-admin/connect`, loopback + master
 * token): it knows its bundled Node and bridge paths and edits only the
 * client's documented config, with a backup, then verifies with a real
 * `initialize` + `tools/list` round trip through the registered entry. No token
 * is passed on the command line or written to a config file: the bridge reads
 * `~/.specrails/mcp.token` itself.
 */

export type McpClientArg = 'claude' | 'codex'

export interface McpConnectOptions {
  sub: 'connect' | 'disconnect' | 'status' | 'help'
  clients: McpClientArg[] | 'all' | null
  scope: 'user' | 'project'
  dryRun: boolean
  force: boolean
  verify: boolean
  json: boolean
}

const CLIENT_NAMES: Record<McpClientArg, string> = { claude: 'Claude Code', codex: 'Codex' }

export const MCP_HELP = `${bold('specrails-desktop mcp')} — connect Claude Code or Codex to Specrails

  specrails-desktop mcp connect --client claude|codex|all [--scope user|project]
                                [--dry-run] [--force] [--no-verify] [--json]
  specrails-desktop mcp disconnect --client claude|codex|all [--scope user|project]
  specrails-desktop mcp status                    Installed clients and their connection

  Specrails must be running. Connect edits only the client's own config
  (${dim('~/.claude.json or .mcp.json; $CODEX_HOME/config.toml or .codex/config.toml')}),
  backs it up first, never writes a token, and verifies with tools/list.
  --scope project writes the config of the current directory.
  --force replaces a "specrails" entry that is not the Specrails bridge.
`

/** Parses the words after `mcp`; throws a usage message on bad input. */
export function parseMcpArgs(argv: string[]): McpConnectOptions {
  const args = [...argv]
  const first = args[0]
  const sub = first === undefined || first === 'help' || first === '--help' || first === '-h' ? 'help'
    : first === 'connect' || first === 'disconnect' || first === 'status' ? first : null
  if (sub === null) throw new Error(`Unknown mcp command "${first}". Try: specrails-desktop mcp connect --client claude`)
  const options: McpConnectOptions = { sub, clients: null, scope: 'user', dryRun: false, force: false, verify: true, json: false }
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!
    const [flag, inline] = arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined]
    const value = () => {
      const next = inline ?? args[++i]
      if (next === undefined || next.startsWith('--')) throw new Error(`${flag} needs a value.`)
      return next
    }
    if (flag === '--client') {
      const raw = value().toLowerCase()
      if (raw === 'all') options.clients = 'all'
      else {
        const list = raw.split(',').map((part) => part.trim()).filter(Boolean)
        for (const name of list) if (name !== 'claude' && name !== 'codex') throw new Error(`Unknown client "${name}". Use claude, codex or all.`)
        options.clients = [...new Set(list)] as McpClientArg[]
      }
    } else if (flag === '--scope') {
      const scope = value()
      if (scope !== 'user' && scope !== 'project') throw new Error('--scope is user or project.')
      options.scope = scope
    } else if (flag === '--dry-run') options.dryRun = true
    else if (flag === '--force') options.force = true
    else if (flag === '--no-verify') options.verify = false
    else if (flag === '--json') options.json = true
    else if (flag === '--remove') options.sub = 'disconnect'
    else throw new Error(`Unknown option ${arg}.`)
  }
  if ((options.sub === 'connect' || options.sub === 'disconnect') && options.clients === null) {
    throw new Error('Choose a client: --client claude, --client codex or --client all.')
  }
  return options
}

interface Detection { client: McpClientArg; installed: boolean; configPath: string; state: string; command: string | null }
interface ConnectBody {
  client: McpClientArg; scope: string; file: string; outcome: string; written: boolean; backup: string | null
  dryRun: boolean; command: string; warnings?: string[]; mcpEnabled?: boolean; error?: string; code?: string
  verify?: { ok: boolean; toolCount?: number; approxTokens?: number; overview?: string; error?: string; instructions?: boolean }
}

const STATE_WORDS: Record<string, string> = { connected: 'connected', outdated: 'connected to an older path (run connect again)', not_connected: 'not connected', conflict: 'has a "specrails" entry that is not this app' }

function tokensLabel(n: number | undefined): string {
  return n === undefined ? '' : n >= 1000 ? ` · ≈${(n / 1000).toFixed(1)}k tokens` : ` · ≈${n} tokens`
}

function nextStep(client: McpClientArg): string {
  return client === 'claude' ? 'Start a new Claude Code session (or run /mcp) to load Specrails.' : 'Start a new Codex session to load Specrails.'
}

/** Human lines for one connect/disconnect answer. */
export function describeConnect(body: ConnectBody, remove: boolean): string[] {
  const name = `${CLIENT_NAMES[body.client]} (${body.scope})`
  const lines: string[] = []
  const what: Record<string, string> = remove
    ? { remove: `disconnected — removed "specrails" from ${body.file}`, absent: `was not connected (${body.file})` }
    : { create: `connected — added "specrails" to ${body.file}`, update: `connected — updated "specrails" in ${body.file}`, unchanged: `already connected (${body.file})` }
  const verb = body.dryRun && body.outcome !== 'unchanged' && body.outcome !== 'absent' ? `would be ${what[body.outcome] ?? body.outcome} ${dim('(dry run, nothing written)')}` : what[body.outcome] ?? body.outcome
  lines.push(`${bold(name)}: ${verb}`)
  if (body.backup) lines.push(dim(`  backup: ${body.backup}`))
  for (const warning of body.warnings ?? []) lines.push(red(`  warning: ${warning}`))
  if (body.verify) {
    lines.push(body.verify.ok
      ? `  verified: ${body.verify.toolCount} tools${tokensLabel(body.verify.approxTokens)}${body.verify.overview ? ` · ${body.verify.overview}` : ''}`
      : red(`  verify failed: ${body.verify.error ?? 'no answer'}`))
  } else if (!remove && !body.dryRun && body.mcpEnabled === false) {
    lines.push(red('  The MCP server is off: turn it on in Settings ▸ MCP, then run this again to verify.'))
  }
  if (!remove && !body.dryRun && (body.outcome === 'create' || body.outcome === 'update')) lines.push(dim(`  ${nextStep(body.client)}`))
  return lines
}

type Out = (line: string) => void

/** Runs `mcp …` against the app on `port`; returns the exit code. */
export async function handleMcp(argv: string[], port: number, io: { out?: Out; err?: Out; cwd?: string } = {}): Promise<number> {
  const out = io.out ?? ((line: string) => process.stdout.write(`${line}\n`))
  const err = io.err ?? ((line: string) => cliError(line))
  let options: McpConnectOptions
  try { options = parseMcpArgs(argv) } catch (e) {
    err((e as Error).message)
    return 2
  }
  if (options.sub === 'help') { out(MCP_HELP); return 0 }
  const detection = await detectWebManager(port)
  if (!detection.running) {
    err(`Specrails is not running on port ${port}. Open the Specrails app (or run specrails-desktop start), then try again.`)
    return 1
  }
  const base = detection.baseUrl
  const status = await httpGet(`${base}/api/mcp-admin/connect`)
  if (status.status === 401 || status.status === 403) {
    err('Specrails refused the request: run this as the same user as the app (it reads ~/.specrails/desktop.token).')
    return 1
  }
  if (status.status !== 200) { err(`Specrails answered ${status.status}: ${status.body.slice(0, 200)}`); return 1 }
  const state = JSON.parse(status.body) as { available: boolean; clients: Detection[] }

  if (options.sub === 'status') {
    if (options.json) { out(JSON.stringify(state, null, 2)); return 0 }
    for (const row of state.clients) {
      out(`${bold(CLIENT_NAMES[row.client])}: ${row.installed ? STATE_WORDS[row.state] ?? row.state : 'not installed'} ${dim(row.configPath)}`)
    }
    if (!state.available) out(red('The MCP bridge is not bundled with this installation.'))
    return 0
  }

  const remove = options.sub === 'disconnect'
  const targets: McpClientArg[] = options.clients === 'all'
    ? state.clients.filter((row) => row.installed || (remove && row.state !== 'not_connected')).map((row) => row.client)
    : options.clients!
  if (!targets.length) {
    err('Neither Claude Code nor Codex was found on this machine. Install one, or name it with --client.')
    return 1
  }
  let code = 0
  const results: ConnectBody[] = []
  for (const client of targets) {
    const row = state.clients.find((candidate) => candidate.client === client)
    if (!remove && !options.json && options.clients !== 'all' && row && !row.installed) out(dim(`${CLIENT_NAMES[client]} was not found on PATH; writing its config anyway.`))
    const res = await httpPost(`${base}/api/mcp-admin/connect`, {
      client, scope: options.scope, remove, dryRun: options.dryRun, force: options.force, verify: options.verify,
      ...(options.scope === 'project' ? { projectDir: io.cwd ?? process.cwd() } : {}),
    }, 60_000)
    let body: ConnectBody
    try { body = JSON.parse(res.body) as ConnectBody } catch { body = { error: res.body } as ConnectBody }
    results.push(body)
    if (res.status !== 200) {
      code = 1
      if (!options.json) err(`${CLIENT_NAMES[client]}: ${body.error ?? `HTTP ${res.status}`}`)
      continue
    }
    if (body.verify && !body.verify.ok) code = 1
    if (!options.json) describeConnect(body, remove).forEach(out)
  }
  if (options.json) out(JSON.stringify(results.length === 1 ? results[0] : results, null, 2))
  return code
}
