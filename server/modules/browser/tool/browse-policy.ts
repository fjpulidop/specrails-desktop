/**
 * Pure rules of the run browser tool (`$SPECRAILS_BROWSE`): its arguments and
 * which addresses a run may open. No I/O; `main.ts` feeds the environment in.
 *
 * A run may open public web pages, files inside its own repositories, and
 * loopback addresses ONLY on the ports Specrails leased to that run (PORT and
 * SPECRAILS_RUN_PORT_RANGE_START.._END). Every other loopback or private
 * address (another run's dev server, the Specrails server, the LAN) is refused,
 * for the page and for every request it makes. The app's own browser panel
 * keeps its stricter rule (`isNavigableUrl`); this does not relax it.
 */
import * as path from 'path'

export interface BrowseViewport { width: number; height: number }

export type BrowseAction =
  | { kind: 'wait'; selector: string }
  | { kind: 'click'; selector: string }
  | { kind: 'type'; selector: string; text: string }
  | { kind: 'press'; key: string }
  | { kind: 'eval'; script: string }
  | { kind: 'sleep'; ms: number }

export interface BrowseOptions {
  url: string | null
  start: string | null
  startTimeoutMs: number
  viewports: BrowseViewport[]
  actions: BrowseAction[]
  out: string | null
  fullPage: boolean
  timeoutMs: number
  help: boolean
}

export const DEFAULT_VIEWPORTS: BrowseViewport[] = [{ width: 1440, height: 900 }, { width: 390, height: 844 }]
const MAX_VIEWPORTS = 6
const MAX_ACTIONS = 40

export class BrowseUsageError extends Error {}

function viewportOf(raw: string): BrowseViewport {
  const match = /^(\d{2,5})x(\d{2,5})$/i.exec(raw.trim())
  const width = match ? Number(match[1]) : NaN, height = match ? Number(match[2]) : NaN
  if (!match || width < 200 || height < 200 || width > 7680 || height > 7680) throw new BrowseUsageError(`--viewport expects WIDTHxHEIGHT between 200 and 7680, got "${raw}"`)
  return { width, height }
}

function millis(raw: string, flag: string, max: number): number {
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0 || value > max) throw new BrowseUsageError(`${flag} expects milliseconds between 0 and ${max}, got "${raw}"`)
  return value
}

/** Parse argv (without node and script). Actions run in the order given, once per viewport. */
export function parseBrowseArgs(argv: readonly string[]): BrowseOptions {
  const options: BrowseOptions = { url: null, start: null, startTimeoutMs: 90_000, viewports: [], actions: [], out: null, fullPage: false, timeoutMs: 30_000, help: false }
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    const value = (): string => {
      const next = argv[++i]
      if (next === undefined) throw new BrowseUsageError(`${flag} needs a value`)
      return next
    }
    switch (flag) {
      case '-h': case '--help': options.help = true; break
      case '--url': options.url = value(); break
      case '--start': options.start = value(); break
      case '--start-timeout': options.startTimeoutMs = millis(value(), flag, 600_000); break
      case '--timeout': options.timeoutMs = millis(value(), flag, 300_000); break
      case '--viewport': options.viewports.push(viewportOf(value())); break
      case '--out': options.out = value(); break
      case '--full-page': options.fullPage = true; break
      case '--wait': options.actions.push({ kind: 'wait', selector: value() }); break
      case '--click': options.actions.push({ kind: 'click', selector: value() }); break
      case '--type': {
        const raw = value(), at = raw.indexOf('=')
        if (at <= 0) throw new BrowseUsageError('--type expects "<selector>=<text>"')
        options.actions.push({ kind: 'type', selector: raw.slice(0, at), text: raw.slice(at + 1) })
        break
      }
      case '--press': options.actions.push({ kind: 'press', key: value() }); break
      case '--eval': options.actions.push({ kind: 'eval', script: value() }); break
      case '--sleep': options.actions.push({ kind: 'sleep', ms: millis(value(), flag, 60_000) }); break
      default: throw new BrowseUsageError(`Unknown argument "${flag}". Run with --help.`)
    }
  }
  if (options.help) return options
  if (!options.url && !options.start) throw new BrowseUsageError('Pass --url <url>, or --start "<command>" to launch the app on $PORT first.')
  if (options.viewports.length > MAX_VIEWPORTS) throw new BrowseUsageError(`At most ${MAX_VIEWPORTS} viewports`)
  if (options.actions.length > MAX_ACTIONS) throw new BrowseUsageError(`At most ${MAX_ACTIONS} actions`)
  if (!options.viewports.length) options.viewports = DEFAULT_VIEWPORTS.map((viewport) => ({ ...viewport }))
  return options
}

/** The run's own ports: PORT and the leased block (inclusive). Empty outside a run. */
export function leasedPorts(env: Record<string, string | undefined>): Set<number> {
  const ports = new Set<number>()
  const valid = (value: number) => Number.isInteger(value) && value >= 1 && value <= 65535
  const start = Number(env.SPECRAILS_RUN_PORT_RANGE_START), end = Number(env.SPECRAILS_RUN_PORT_RANGE_END)
  if (valid(start) && valid(end) && end >= start && end - start < 1000) for (let port = start; port <= end; port++) ports.add(port)
  for (const key of ['PORT', 'SPECRAILS_RUN_PORT']) {
    const value = Number(env[key])
    if (valid(value)) ports.add(value)
  }
  return ports
}

function isLoopbackHost(host: string): boolean {
  const value = host.toLowerCase().replace(/^\[|\]$/g, '')
  return value === 'localhost' || value.endsWith('.localhost') || value === '::1' || value === '0.0.0.0' || value === '::' || /^127\./.test(value) || /^::ffff:127\./.test(value)
}

function isPrivateHost(host: string): boolean {
  const value = host.toLowerCase().replace(/^\[|\]$/g, '')
  if (/^10\./.test(value) || /^192\.168\./.test(value) || /^169\.254\./.test(value) || /^0\./.test(value)) return true
  const match = /^172\.(\d+)\./.exec(value)
  if (match && Number(match[1]) >= 16 && Number(match[1]) <= 31) return true
  if (/^(?:fc|fd)[0-9a-f]{2}:/.test(value) || /^fe80:/.test(value)) return true
  return value.endsWith('.local') || value.endsWith('.internal') || value === 'metadata.google.internal'
}

function within(root: string, file: string): boolean {
  const relative = path.relative(root, file)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

export interface UrlPolicy {
  ports: ReadonlySet<number>
  /** Real (symlink-resolved) directories a file:// URL may point into. */
  roots: readonly string[]
  /** Resolve a path to its real location (fs.realpathSync in production). */
  realpath: (file: string) => string
}

/** Why a URL is refused, or null when the run may open it. */
export function refusedUrl(raw: string, policy: UrlPolicy): string | null {
  let url: URL
  try { url = new URL(raw) } catch { return `"${raw}" is not a URL` }
  if (url.protocol === 'data:' || url.protocol === 'blob:' || url.protocol === 'about:') return null
  if (url.protocol === 'file:') {
    let file: string
    try { file = policy.realpath(decodeURIComponent(url.pathname)) } catch { return `${url.pathname} does not exist` }
    return policy.roots.some((root) => within(root, file)) ? null : `${file} is outside this run's repositories`
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'ws:' && url.protocol !== 'wss:') return `${url.protocol} URLs are not allowed`
  const secure = url.protocol === 'https:' || url.protocol === 'wss:'
  const port = Number(url.port || (secure ? 443 : 80))
  if (isLoopbackHost(url.hostname)) {
    return policy.ports.has(port) ? null : `${url.hostname}:${port} is not one of this run's leased ports (${policy.ports.size ? `PORT=${[...policy.ports][0]}…` : 'none in this environment'}); start the app on $PORT`
  }
  if (isPrivateHost(url.hostname)) return `${url.hostname} is a private network address`
  return null
}

/** Run roots a file:// URL may use: the cwd and every repository the run declares. */
export function runRoots(cwd: string, env: Record<string, string | undefined>): string[] {
  const roots = [cwd]
  if (env.SPECRAILS_REPO_DIR) roots.push(env.SPECRAILS_REPO_DIR)
  try {
    const repositories = JSON.parse(env.SPECRAILS_REPOSITORIES ?? '[]') as unknown
    if (Array.isArray(repositories)) for (const repository of repositories) {
      const value = repository && typeof repository === 'object' ? (repository as { path?: unknown }).path : null
      if (typeof value === 'string' && value) roots.push(value)
    }
  } catch { /* absent or malformed: cwd only */ }
  return [...new Set(roots)]
}

export const BROWSE_HELP = `specrails-browse: look at a web page the way a person would, headless.

  $SPECRAILS_BROWSE --url file://$PWD/index.html
  $SPECRAILS_BROWSE --start "npm run dev -- --port $PORT" --url http://127.0.0.1:$PORT/
  $SPECRAILS_BROWSE --url http://127.0.0.1:$PORT/ --viewport 1440x900 --viewport 390x844 \\
      --wait "#board" --click "#start" --eval "window.game.state" --sleep 500

Options
  --url <url>            page to open (file:// inside the run's repositories, http(s) on this
                         run's leased ports such as $PORT, or a public site)
  --start "<command>"    start the app first (shell command, cwd = here) and wait until the URL
                         answers; it is stopped at the end. Default URL: http://127.0.0.1:$PORT/
  --start-timeout <ms>   how long to wait for the app (default 90000)
  --viewport WxH         repeatable (default 1440x900 and 390x844)
  --wait <selector>      wait until the element is visible
  --click <selector>     click an element
  --type "<sel>=<text>"  type into an element
  --press <key>          press a key (for example ArrowLeft, Space, Enter)
  --eval "<js>"          evaluate an expression in the page; its JSON result is reported
  --sleep <ms>           wait (animations, timers)
  --full-page            capture the full scrollable page
  --out <dir>            output folder (default: a new temporary folder)
  --timeout <ms>         per-step timeout (default 30000)

For every viewport it writes a PNG screenshot and a text summary, plus report.json with the
console errors, page errors and failed requests. Read the PNG files to see the page.
Exit code: 0 page loaded, actions ran and no errors; 1 the page logged errors; 2 it could not run.`
