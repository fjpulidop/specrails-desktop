import { spawn, type ChildProcess } from 'node:child_process'

import { findCoreAgentRuntimeCli } from '../../agent-runtime/runtime/agent-runtime-loader'
import { resolveCoreNodeRuntime } from '../../../core-node-runtime'
import { treeKillSafe, windowsSpawnEnv } from '../../../util/win-spawn'
import { SessionRequestError } from '../domain/errors'
import { SUPPORTED_PROTOCOL_VERSIONS, type InitializeResult } from '../domain/protocol'
import type { HostProcessLauncher, SessionHostClient } from '../ports'
import { StdioSessionHostClient } from './rpc-client'

export interface CoreHostLauncherOptions {
  /** Absolute path of Core's `dist/agent-runtime/cli.js`; defaults to the selected Core runtime. */
  cli?: () => string | null
  node?: () => string
  env?: NodeJS.ProcessEnv
  host?: { name: string; version: string }
  /** Grace for `host.shutdown` before the process tree is killed. */
  shutdownGraceMs?: number
  requestTimeoutMs?: number
  spawnProcess?: (command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => ChildProcess
  onStderr?: (scope: string, text: string) => void
}

export interface LaunchedHost extends SessionHostClient {
  readonly initialize: InitializeResult
  readonly pid: number | undefined
}

/**
 * Launches `node <core>/cli.js host --stdio --scope <scope>` through the same
 * Core and Node resolution as implementation runs (bundled Node under pkg,
 * Windows-safe environment), then performs the protocol handshake.
 */
export class CoreHostLauncher implements HostProcessLauncher {
  constructor(private readonly options: CoreHostLauncherOptions = {}) {}

  async launch(scope: string): Promise<LaunchedHost> {
    const cli = (this.options.cli ?? findCoreAgentRuntimeCli)()
    if (!cli) throw new SessionRequestError('The selected Core runtime does not include the agent runtime CLI', { code: 'driver_unavailable', retryable: false })
    const env = windowsSpawnEnv(this.options.env ?? process.env)
    const args = [cli, 'host', '--stdio', '--scope', scope]
    const command = (this.options.node ?? resolveCoreNodeRuntime)()
    const child = (this.options.spawnProcess ?? ((cmd, argv, opts) => spawn(cmd, argv, { env: opts.env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })))(command, args, { env })
    if (!child.stdin || !child.stdout) throw new SessionRequestError('Session host has no stdio pipes', { code: 'internal', retryable: true })
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      stderr = (stderr + text).slice(-8_192)
      this.options.onStderr?.(scope, text)
    })
    const exited = new Promise<number | null>((resolve) => {
      child.once('exit', (code) => resolve(code))
      child.once('error', () => resolve(null))
    })
    const grace = this.options.shutdownGraceMs ?? 10_000
    const client = new StdioSessionHostClient({ stdin: child.stdin, stdout: child.stdout }, {
      ...(this.options.requestTimeoutMs !== undefined ? { timeoutMs: this.options.requestTimeoutMs } : {}),
      onClose: async () => {
        // Ask for a graceful stop (interruptions recorded, lease released), then make sure the tree is gone.
        await Promise.race([client.request('host.shutdown', { graceMs: grace }).catch(() => undefined), exited])
        const forced = setTimeout(() => { if (child.pid) treeKillSafe(child.pid, 'SIGKILL') }, grace)
        await exited
        clearTimeout(forced)
      },
    })
    void exited.then((code) => client.markClosed(`Session host exited (code ${code ?? 'none'})${stderr ? `: ${stderr.trim().split('\n').at(-1)}` : ''}`))

    let initialize: InitializeResult
    try {
      initialize = await client.request<InitializeResult>('initialize', {
        protocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
        host: this.options.host ?? { name: 'specrails-desktop', version: 'dev' },
        scope,
      })
      if (initialize.capabilities?.sessions !== 1) throw new SessionRequestError('Core session host does not advertise sessions', { code: 'protocol_mismatch', retryable: false })
    } catch (error) {
      if (child.pid) treeKillSafe(child.pid, 'SIGKILL')
      client.markClosed('Session host failed to initialize')
      throw error
    }
    return Object.assign(client, { initialize, pid: child.pid }) as LaunchedHost
  }
}
