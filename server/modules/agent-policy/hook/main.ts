/**
 * Process entry of the bundled policy hook (see `policy-hook.ts` for the
 * contract). Reads stdin, writes exactly one JSON answer, exits 0.
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { randomBytes } from 'crypto'
import { NO_DECISION, runPolicyHook, type HookFs } from './policy-hook'
import { DENIAL_SPOOL_DIR, MAX_SPOOLED_DENIALS, type DenialReport } from '../domain/report'

const WATCHDOG_MS = 3000
const MAX_INPUT_BYTES = 4 * 1024 * 1024

const hookFs: HookFs = {
  readFile: (p) => { try { return fs.readFileSync(p, 'utf8') } catch { return null } },
  realpath: (p) => { try { return fs.realpathSync(p) } catch { return null } },
  isDir: (p) => { try { return fs.statSync(p).isDirectory() } catch { return false } },
  exists: (p) => { try { fs.lstatSync(p); return true } catch { return false } },
}

function argValue(name: string): string | null {
  const index = process.argv.indexOf(name)
  return index !== -1 ? process.argv[index + 1] ?? null : null
}

/**
 * Leave the denial for the server's audit. Best-effort and bounded: never
 * delays or changes the decision.
 */
function spoolDenial(report: DenialReport): void {
  try {
    const home = argValue('--specrails-home') ?? process.env.SPECRAILS_REGISTRY_HOME ?? os.homedir()
    const dir = path.join(home, '.specrails', 'agent-policy', DENIAL_SPOOL_DIR)
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    if (fs.readdirSync(dir).length >= MAX_SPOOLED_DENIALS) return
    const name = `${Date.now()}-${process.pid}-${randomBytes(4).toString('hex')}.json`
    const tmp = path.join(dir, `.${name}.tmp`)
    fs.writeFileSync(tmp, JSON.stringify(report), { mode: 0o600 })
    fs.renameSync(tmp, path.join(dir, name))
  } catch { /* the stream still carries the denial */ }
}

let answered = false
function answer(text: string): void {
  if (answered) return
  answered = true
  process.stdout.write(text, () => process.exit(0))
}

export function main(): void {
  const timer = setTimeout(() => answer(NO_DECISION), WATCHDOG_MS)
  timer.unref?.()
  const chunks: Buffer[] = []
  let size = 0
  process.stdin.on('data', (chunk: Buffer) => {
    size += chunk.length
    if (size > MAX_INPUT_BYTES) { answer(NO_DECISION); return }
    chunks.push(chunk)
  })
  process.stdin.on('error', () => answer(NO_DECISION))
  process.stdin.on('end', () => {
    try {
      const result = runPolicyHook(Buffer.concat(chunks).toString('utf8'), {
        argv: process.argv.slice(2),
        env: process.env,
        home: os.homedir(),
        tmpdir: os.tmpdir(),
        fs: hookFs,
      })
      if (result.report) spoolDenial(result.report)
      answer(result.output)
    } catch {
      answer(NO_DECISION)
    }
  })
}

main()
