/**
 * Runs an approved install: the parsed argv, never a shell, with stdin closed (a password
 * prompt fails instead of hanging), a time limit and the whole process tree stopped on expiry.
 */
import { spawnCli, treeKillSafe } from '../../../util/win-spawn'
import type { InstallRunner, InstallRunOutcome } from '../application'

/** Long enough for a Homebrew bottle or a cargo build; bounded so a run never waits forever. */
export const INSTALL_TIMEOUT_MS = 20 * 60_000
const TAIL_LINES = 6

export function createProcessInstallRunner(options: { env?: () => NodeJS.ProcessEnv; timeoutMs?: number } = {}): InstallRunner {
  return {
    run(argv, onLine): Promise<InstallRunOutcome> {
      const timeoutMs = options.timeoutMs ?? INSTALL_TIMEOUT_MS
      return new Promise(resolve => {
        const tail: string[] = []
        let pending = '', settled = false, timedOut = false
        const emit = (line: string): void => { if (!line.trim()) return; onLine(line); tail.push(line.trim()); if (tail.length > TAIL_LINES) tail.shift() }
        const finish = (outcome: InstallRunOutcome): void => { if (settled) return; settled = true; clearTimeout(timer); resolve(outcome) }
        let child: ReturnType<typeof spawnCli>
        try {
          // Installers honour these to skip interactive prompts; nothing else of the environment changes.
          child = spawnCli(argv[0]!, argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'], env: { ...(options.env?.() ?? process.env), NONINTERACTIVE: '1', HOMEBREW_NO_ENV_HINTS: '1' } })
        } catch (error) {
          finish({ ok: false, detail: error instanceof Error ? error.message : String(error) })
          return
        }
        const timer = setTimeout(() => { timedOut = true; if (child.pid) treeKillSafe(child.pid, 'SIGKILL') }, timeoutMs)
        timer.unref?.()
        const read = (chunk: Buffer): void => {
          pending += chunk.toString('utf8')
          const lines = pending.split(/\r?\n/)
          pending = lines.pop() ?? ''
          for (const line of lines) emit(line)
        }
        child.stdout?.on('data', read)
        child.stderr?.on('data', read)
        child.on('error', error => finish({ ok: false, detail: (error as NodeJS.ErrnoException).code === 'ENOENT' ? `${argv[0]} is not installed or not on PATH` : error.message }))
        child.on('close', (code, signal) => {
          emit(pending)
          if (timedOut) return finish({ ok: false, detail: `it did not finish within ${Math.round(timeoutMs / 60_000)} min` })
          if (code === 0) return finish({ ok: true })
          finish({ ok: false, detail: `exit ${code ?? signal}${tail.length ? `: ${tail[tail.length - 1]}` : ''}` })
        })
      })
    },
  }
}
