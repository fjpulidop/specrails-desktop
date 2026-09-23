import path from 'path'
import fs from 'fs'
import { bold, dim } from './output'
import { DEFAULT_PORT } from './args'



export function getVersion(): string {
  for (const rel of ['../package.json', '../../package.json']) {
    try {
      const pkgPath = path.join(__dirname, rel)
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version?: string }
      if (typeof pkg.version === 'string') return pkg.version
    } catch {
      // try next
    }
  }
  return 'unknown'
}


export function printVersion(): void {
  process.stdout.write(`specrails-desktop v${getVersion()}\n`)
}


export function printHelp(): void {
  const version = getVersion()
  process.stdout.write(`
${bold(`specrails-desktop v${version}`)} — specrails CLI bridge

${bold('Project Required:')}
  Every command runs in the context of a project registered for the current
  directory. Register your project once before running any commands:

    ${dim('# Register your project (run once per project):')}
    specrails-desktop add .

    ${dim('# Then run commands from that directory:')}
    specrails-desktop implement #42

${bold('Usage:')}
  specrails-desktop implement #42                Run a known specrails verb (prepends /specrails:)
  specrails-desktop batch-implement #40 #41      Batch implementation across issues
  specrails-desktop why                          Explain recent changes
  specrails-desktop get-backlog-specs            View prioritized spec backlog
  specrails-desktop auto-propose-backlog-specs   Generate new spec ideas
  specrails-desktop propose-spec                 Explore an idea and produce a spec
  specrails-desktop refactor-recommender        Find refactoring opportunities
  specrails-desktop health-check                Run codebase health check
  specrails-desktop compat-check                Check for breaking API changes
  specrails-desktop "any raw prompt"             Pass a raw prompt directly to claude
  specrails-desktop --status                     Print manager status and exit
  specrails-desktop --jobs                       Print recent job history and exit
  specrails-desktop start|stop|add|remove|list  Manage the server
  specrails-desktop --project <name|path>        Override project (default: current directory)
  specrails-desktop --port <n>                   Override default port (${DEFAULT_PORT})
  specrails-desktop --version, -v               Print version and exit
  specrails-desktop --help, -h                  Show this help text

${bold('Execution paths:')}
  Manager running → POST /api/spawn + stream logs via WebSocket
  Manager not running → spawn claude directly with stream-json output
`.trimStart())
}
