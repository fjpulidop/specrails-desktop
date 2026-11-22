// Command-line options of `npm run eval:mcp` (pure).
import os from 'node:os'
import path from 'node:path'
import { CLIENTS, AUTH_MODES } from './clients.mjs'
import { DEFAULT_PORT, DEFAULT_CLIENT_PORT } from './isolation.mjs'

export class ArgsError extends Error {
  constructor(message) { super(message); this.name = 'ArgsError' }
}

const FLAGS = {
  '--client': 'client', '--scenario': 'scenario', '--repeat': 'repeat', '--model': 'model', '--home': 'home', '--port': 'port',
  '--client-port': 'clientPort', '--work-dir': 'workDir', '--out': 'out', '--fleet': 'fleet', '--baseline': 'baseline',
  '--stop-at-window': 'stopAtWindow', '--max-cost-usd': 'maxCostUsd', '--core-dir': 'coreDir', '--client-bin': 'clientBin',
  '--max-turns': 'maxTurns', '--turn-timeout-s': 'turnTimeoutS', '--auth': 'auth', '--effort': 'effort',
}
const BOOLEANS = { '--v1': 'v1', '--fresh': 'fresh', '--keep-server': 'keepServer', '--probe': 'probe', '--no-quota-guard': 'noQuotaGuard', '--help': 'help', '-h': 'help' }
const NUMBERS = ['repeat', 'port', 'clientPort', 'fleet', 'stopAtWindow', 'maxCostUsd', 'maxTurns', 'turnTimeoutS']

export const USAGE = `npm run eval:mcp -- --client claude|codex|replay [--scenario <id>|<id,id>|all] [--repeat n]
  [--model m] [--auth temp|session] [--effort low] [--v1] [--probe] [--fleet n] [--baseline <v1 report.json>] [--fresh] [--keep-server]
  [--home ~/.specrails-dev-mcpeval] [--port 4400 --client-port 4401] [--work-dir dir] [--out dir]
  [--stop-at-window 70] [--max-cost-usd 1] [--max-turns 40] [--core-dir <specrails-core>] [--client-bin path]`

export function parseArgs(argv, { userHome = os.homedir(), tmp = os.tmpdir() } = {}) {
  const o = { client: null, scenario: 'all', repeat: 1, model: null, home: path.join(userHome, '.specrails-dev-mcpeval'), port: DEFAULT_PORT, clientPort: DEFAULT_CLIENT_PORT,
    workDir: path.join(tmp, 'specrails-eval-mcp'), out: null, fleet: 100, baseline: null, stopAtWindow: 70, maxCostUsd: 1, coreDir: null, clientBin: null,
    maxTurns: 40, turnTimeoutS: 600, auth: 'temp', effort: null, v1: false, fresh: false, keepServer: false, probe: false, noQuotaGuard: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (BOOLEANS[a]) { o[BOOLEANS[a]] = true; continue }
    const [flag, inline] = a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, undefined]
    const key = FLAGS[flag]
    if (!key) throw new ArgsError(`Unknown option ${a}`)
    const value = inline ?? argv[++i]
    if (value === undefined) throw new ArgsError(`${flag} needs a value`)
    o[key] = value
  }
  if (o.help) return o
  if (!CLIENTS.includes(o.client)) throw new ArgsError(`--client must be one of ${CLIENTS.join(', ')}`)
  for (const k of NUMBERS) {
    const n = Number(o[k])
    if (!Number.isFinite(n) || n < 0) throw new ArgsError(`--${k.replace(/[A-Z]/g, c => '-' + c.toLowerCase())} must be a non-negative number`)
    o[k] = n
  }
  if (!AUTH_MODES.includes(o.auth)) throw new ArgsError(`--auth must be one of ${AUTH_MODES.join(', ')}`)
  if (o.auth === 'session' && o.client === 'replay') throw new ArgsError('--auth session needs a real client')
  if (o.repeat < 1 || !Number.isInteger(o.repeat)) throw new ArgsError('--repeat must be a positive integer')
  if (o.stopAtWindow > 100) throw new ArgsError('--stop-at-window must be at most 100')
  if (o.v1 && o.client === 'replay') throw new ArgsError('--v1 needs a real client: the replay solutions are written for v2')
  o.home = o.home.replace(/^~(?=$|[\\/])/, userHome)
  o.workDir = path.resolve(o.workDir.replace(/^~(?=$|[\\/])/, userHome))
  return o
}
