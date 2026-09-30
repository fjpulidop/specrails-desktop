import type { ChildProcess } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { homedir } from 'node:os'
import path from 'node:path'
import { spawnCli, treeKillSafe } from '../../../util/win-spawn'
import { normalizeCodex, record } from '../domain'
import type { UsageReader, UsageReadResult } from '../ports'
import { UsageError } from './errors'
import { fingerprint, readAuthFile } from './local-auth'
interface CodexOptions {
  home?: string
  readFile?: typeof readAuthFile
  spawn?: () => ChildProcess
  stop?: (child: ChildProcess) => Promise<void>
  timeoutMs?: number
}
async function stopProbe(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>(resolve => {
    const done = () => { clearTimeout(timer); child.off('close', done); resolve() }
    const timer = setTimeout(() => {
      if (child.pid) treeKillSafe(child.pid, 'SIGKILL', () => done())
      else { child.kill('SIGKILL'); done() }
    }, 500)
    child.once('close', done)
    child.stdin?.end()
    if (child.pid) treeKillSafe(child.pid, 'SIGTERM')
    else child.kill('SIGTERM')
  })
}
export function createCodexReader(options: CodexOptions = {}): UsageReader {
  const home = options.home ?? process.env.CODEX_HOME ?? path.join(homedir(), '.codex')
  return {
    async context() {
      if (!path.isAbsolute(home)) throw new UsageError('unsupported-platform')
      return fingerprint(`${home}:${await (options.readFile ?? readAuthFile)(path.join(home, 'auth.json')) ?? 'keychain-or-none'}`)
    },
    read(signal) {
      if (signal.aborted) return Promise.reject(new UsageError('aborted'))
      return new Promise<UsageReadResult>((resolve, reject) => {
        let child: ChildProcess
        try { child = options.spawn ? options.spawn() : spawnCli('codex', ['app-server', '--listen', 'stdio://'], {
          cwd: homedir(), env: { ...process.env, CODEX_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
        }) } catch { reject(new UsageError('unsupported-cli')); return }
        let buffer = '', finished = false, plan: string | null = null, identity: string | undefined
        const decoder = new StringDecoder('utf8')
        const timer = setTimeout(() => finish(new UsageError('probe-timeout', true)), options.timeoutMs ?? 25_000)
        function cleanup() {
          clearTimeout(timer); signal.removeEventListener('abort', abort)
          child.stdout?.off('data', data); child.stderr?.off('data', drain)
          child.off('error', failure); child.off('close', closed)
          child.stdin?.off('error', failure)
        }
        function finish(error?: UsageError, result?: UsageReadResult) {
          if (finished) return
          finished = true; cleanup()
          // Continue draining without retaining provider diagnostics during termination.
          child.stdout?.resume(); child.stderr?.resume()
          void (options.stop ?? stopProbe)(child).then(() => error ? reject(error) : resolve(result!), () => reject(new UsageError('cleanup-failed', true)))
        }
        const abort = () => finish(new UsageError('aborted'))
        const failure = () => finish(new UsageError('unsupported-cli'))
        const closed = () => finish(new UsageError('probe-exited', true))
        const drain = () => { /* no raw stderr retained */ }
        function send(id: number, method: string, params: unknown = {}) {
          try { child.stdin?.write(`${JSON.stringify({ id, method, params })}\n`) } catch { failure() }
        }
        function data(chunk: Buffer) {
          buffer += decoder.write(chunk)
          if (Buffer.byteLength(buffer) > 1024 * 1024) { finish(new UsageError('invalid-response', true)); return }
          let newline
          while (!finished && (newline = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1)
            let message: Record<string, unknown>
            try { message = record(JSON.parse(line)) } catch { finish(new UsageError('invalid-response', true)); return }
            if (typeof message.id !== 'number') continue
            if (message.error) {
              const code = record(message.error).code
              finish(new UsageError(code === -32601 ? 'unsupported-cli' : 'provider-error', code !== -32601)); return
            }
            if (message.id === 1) {
              try { child.stdin?.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`) } catch { failure(); return }
              send(2, 'account/read', { refreshToken: false })
            } else if (message.id === 2) {
              const account = record(record(message.result).account)
              if (!Object.keys(account).length) { finish(undefined, { availability: 'signed-out', windows: [], plan: null, source: null }); return }
              if (account.type !== 'chatgpt') { finish(undefined, { availability: 'unsupported-auth', windows: [], plan: null, source: null }); return }
              plan = typeof account.planType === 'string' ? account.planType.slice(0, 80) : null
              // Never export an email; only an internal fingerprint for identity checks.
              if (typeof account.email === 'string') identity = fingerprint(account.email)
              send(3, 'account/rateLimits/read')
            } else if (message.id === 3) {
              const payload = record(message.result), windows = normalizeCodex(payload)
              if (typeof payload.accountId === 'string') identity = fingerprint(payload.accountId)
              if (!windows.length) { finish(new UsageError('usage-unavailable')); return }
              finish(undefined, { availability: 'available', windows, plan, source: 'app-server', identity })
            }
          }
        }
        signal.addEventListener('abort', abort, { once: true })
        child.on('error', failure); child.on('close', closed); child.stdin?.on('error', failure)
        child.stdout?.on('data', data); child.stderr?.on('data', drain)
        send(1, 'initialize', { clientInfo: { name: 'specrails-subscription-usage', title: 'Specrails', version: '1.0.0' } })
      })
    },
  }
}
