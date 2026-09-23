



// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_PORT = 4200


export const KNOWN_VERBS = new Set([
  'implement',
  'batch-implement',
  'why',
  'get-backlog-specs',
  'auto-propose-backlog-specs',
  'propose-spec',
  'refactor-recommender',
  'health-check',
  'compat-check',
  'enrich',
])


// ---------------------------------------------------------------------------
// Argument parser
// ---------------------------------------------------------------------------

export type ParsedArgs =
  | { mode: 'help' }
  | { mode: 'version' }
  | { mode: 'status'; port: number }
  | { mode: 'jobs'; port: number }
  | { mode: 'desktop'; subArgs: string[]; port: number }
  | { mode: 'command'; resolved: string; port: number; projectOverride?: string }
  | { mode: 'raw'; resolved: string; port: number; projectOverride?: string }


export function parseArgs(argv: string[]): ParsedArgs {
  // argv is process.argv.slice(2)
  let port = DEFAULT_PORT
  let projectOverride: string | undefined
  const args = [...argv]

  // Extract --port <n> and --project <name|path> from any position
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && i + 1 < args.length) {
      const parsed = parseInt(args[i + 1], 10)
      if (!isNaN(parsed)) {
        port = parsed
      }
      args.splice(i, 2)
      i--
    } else if (args[i] === '--project' && i + 1 < args.length) {
      projectOverride = args[i + 1]
      args.splice(i, 2)
      i--
    }
  }

  if (args[0] === '--version' || args[0] === '-v') {
    return { mode: 'version' }
  }

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    return { mode: 'help' }
  }

  if (args[0] === '--status') {
    return { mode: 'status', port }
  }

  if (args[0] === '--jobs') {
    return { mode: 'jobs', port }
  }

  if (args[0] === 'desktop') {
    return { mode: 'desktop', subArgs: args.slice(1), port }
  }

  // Allow server-management subcommands directly without the 'desktop' prefix:
  //   specrails-desktop start  →  specrails-desktop desktop start
  //   specrails-desktop stop   →  specrails-desktop desktop stop
  //   specrails-desktop add    →  specrails-desktop desktop add
  //   etc.
  const DESKTOP_SUBCOMMANDS = new Set(['start', 'stop', 'status', 'add', 'remove', 'list'])
  if (DESKTOP_SUBCOMMANDS.has(args[0])) {
    return { mode: 'desktop', subArgs: args, port }
  }

  const first = args[0]

  // Slash-prefixed command: pass through unchanged
  if (first.startsWith('/')) {
    const resolved = args.join(' ')
    return { mode: 'raw', resolved, port, projectOverride }
  }

  // Known verb: inject /specrails: prefix
  if (KNOWN_VERBS.has(first)) {
    const resolved = `/specrails:${args.join(' ')}`
    return { mode: 'command', resolved, port, projectOverride }
  }

  // Unknown first token: treat as raw prompt
  const resolved = args.join(' ')
  return { mode: 'raw', resolved, port, projectOverride }
}
