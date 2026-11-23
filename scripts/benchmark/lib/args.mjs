// Command-line options for the benchmark (pure).

export class ArgsError extends Error {
  constructor(message) { super(message); this.name = 'ArgsError' }
}

const FLAGS = {
  '--scenarios': 'scenarios', '--home': 'home', '--port': 'port', '--client-port': 'clientPort',
  '--provider': 'provider', '--model': 'model', '--budget-runs': 'budgetRuns', '--stop-at-weekly': 'stopAtWeekly',
  '--work-dir': 'workDir', '--core-bin': 'coreBin', '--path-prepend': 'pathPrepend', '--report': 'report',
  '--only': 'only', '--parallel': 'parallel', '--quota-settle-ms': 'quotaSettleMs', '--quota-every-s': 'quotaEveryS',
  '--duration-min': 'durationMin', '--launch-until-min': 'launchUntilMin', '--sample-every-s': 'sampleEveryS', '--pause-at-window': 'pauseAtWindow',
  '--inspect-port': 'inspectPort', '--max-auto-resumes': 'maxAutoResumes', '--limit-sim-file': 'limitSimFile',
}
const BOOLEANS = { '--start-server': 'startServer', '--stop-server': 'stopServer', '--dry-run': 'dryRun', '--burst': 'burst', '--soak': 'soak', '--merge-after': 'mergeAfter', '--quiet': 'quiet', '--help': 'help', '-h': 'help' }

export function parseArgs(argv) {
  const o = { provider: 'claude', model: 'haiku', budgetRuns: 25, stopAtWeekly: 95, parallel: 3, workDir: null, only: [], quotaSettleMs: 8000, quotaEveryS: 60, burst: false, soak: false, durationMin: 600, launchUntilMin: null, sampleEveryS: 60, pauseAtWindow: 85, inspectPort: null, maxAutoResumes: 3, limitSimFile: null,
    startServer: false, stopServer: false, dryRun: false, quiet: false, help: false, providerForced: false, modelForced: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (BOOLEANS[a]) { o[BOOLEANS[a]] = true; continue }
    const [flag, inline] = a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, undefined]
    const key = FLAGS[flag]
    if (!key) throw new ArgsError(`Unknown option ${a}`)
    const value = inline ?? argv[++i]
    if (value === undefined) throw new ArgsError(`${flag} needs a value`)
    o[key] = value
    if (key === 'provider') o.providerForced = true
    if (key === 'model') o.modelForced = true
  }
  if (o.help) return o
  if (!o.scenarios) throw new ArgsError('--scenarios <file> is required')
  for (const k of ['budgetRuns', 'stopAtWeekly', 'parallel', 'quotaSettleMs', 'quotaEveryS', 'durationMin', 'sampleEveryS', 'pauseAtWindow', 'maxAutoResumes', ...(o.launchUntilMin !== null ? ['launchUntilMin'] : []), ...(o.inspectPort !== null ? ['inspectPort'] : [])]) {
    const n = Number(o[k])
    if (!Number.isFinite(n) || n < 0) throw new ArgsError(`--${k.replace(/[A-Z]/g, c => '-' + c.toLowerCase())} must be a non-negative number`)
    o[k] = n
  }
  if (o.soak && o.burst) throw new ArgsError('--soak and --burst are exclusive')
  if (o.sampleEveryS < 5 && o.soak) throw new ArgsError('--sample-every-s must be at least 5')
  if (o.stopAtWeekly > 100) throw new ArgsError('--stop-at-weekly must be at most 100')
  if (o.parallel < 1) o.parallel = 1
  o.only = typeof o.only === 'string' ? o.only.split(',').map(s => s.trim()).filter(Boolean) : o.only
  return o
}
