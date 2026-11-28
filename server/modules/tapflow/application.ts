/**
 * Tapflow plugin use cases: status, install (in a terminal), activate, deactivate, uninstall, restore
 * at boot and stop at shutdown. Effects go through narrow ports so the policy is testable with fakes.
 */
import {
  deriveStatus, EMPTY_TAPFLOW_STATE, platformIssue, TAPFLOW_VERSION,
  type HostFacts, type TapflowIssue, type TapflowStatus, type TapflowStoredState,
} from './domain'

export interface TapflowStore {
  read(): TapflowStoredState
  write(state: TapflowStoredState): void
}

/** Where the managed install lives and which Node runs it. */
export interface TapflowInstallation {
  /** The managed packages are on disk at this version. */
  present(version: string): boolean
  /** A Tapflow the person installed themselves. */
  externalPresent(): boolean
  /** Node ≥ 22 to install and run with (the bundled one first), or null with the reason. */
  resolveNode(): { nodePath: string } | { issue: TapflowIssue }
  remove(): Promise<void>
}

export interface InstallerTerminal {
  /** Opens the installer terminal; `onExit` fires once with its exit code. */
  open(nodePath: string, onExit: (code: number | null) => void): { sessionId: string }
}

export interface TapflowService {
  /** Starts the supervised service; `onExit` fires once if it ends by itself. */
  start(opts: { nodePath: string; port: number }, onExit: (detail: string) => void): void
  stop(): Promise<void>
  state(): 'none' | 'starting' | 'alive'
  pid(): number | null
}

export interface TapflowRelay {
  /** Tapflow's liveness route answers on this port. */
  answering(port: number): Promise<boolean>
  /** Waits until the relay answers, up to the timeout. */
  waitAnswering(port: number, timeoutMs: number): Promise<boolean>
  /** Creates the admin account and the token on first use; a no-op once done. */
  ensureCredentials(port: number): Promise<void>
}

export interface TapflowDeps {
  host: HostFacts
  store: TapflowStore
  installation: TapflowInstallation
  installer: InstallerTerminal
  service: TapflowService
  relay: TapflowRelay
  /** A Tapflow that Specrails did not launch answers elsewhere (its own default port). */
  externalRelayAnswering: () => Promise<boolean>
  /** Status changes, for the WS broadcast. */
  onChange?: (status: TapflowStatus) => void
  startTimeoutMs?: number
}

export type TapflowResult = { ok: true; status: TapflowStatus } | { ok: false; status: TapflowStatus; error: string }

export interface TapflowPlugin {
  status(): Promise<TapflowStatus>
  install(): Promise<TapflowResult & { sessionId?: string }>
  activate(): Promise<TapflowResult>
  deactivate(): Promise<TapflowResult>
  uninstall(): Promise<TapflowResult>
  /** Restarts the service if it was active when the app stopped. */
  restoreOnBoot(): Promise<void>
  shutdown(): Promise<void>
  /** The supervised service pid, for resource metering. */
  servicePid(): number | null
}

export function createTapflowPlugin(deps: TapflowDeps): TapflowPlugin {
  const { host, store, installation, installer, service, relay } = deps
  const startTimeoutMs = deps.startTimeoutMs ?? 30_000
  let installing: { sessionId: string } | null = null
  let lastIssue: TapflowIssue | null = null
  // Set while Specrails itself stops the service, so its exit is not reported as a crash.
  let stopping = false
  // One lifecycle change at a time (a double click must not start two services).
  let chain: Promise<unknown> = Promise.resolve()
  const serialize = <T>(task: () => Promise<T>): Promise<T> => {
    const next = chain.then(task, task)
    chain = next.catch(() => undefined)
    return next
  }

  const stored = (): TapflowStoredState => ({ ...EMPTY_TAPFLOW_STATE, ...store.read() })

  async function status(): Promise<TapflowStatus> {
    const state = stored()
    const supported = platformIssue(host) === null
    const supervised = service.state()
    const relayAnswering = supported ? await relay.answering(state.port) : false
    return deriveStatus({
      host, stored: state,
      managedInstallPresent: supported && state.installedVersion !== null && installation.present(state.installedVersion),
      externalInstall: supported && installation.externalPresent(),
      installing, supervised, relayAnswering,
      externalProcessRunning: supported && supervised === 'none' && !relayAnswering && await deps.externalRelayAnswering(),
      lastIssue,
    })
  }

  async function changed(): Promise<TapflowStatus> {
    const current = await status()
    try { deps.onChange?.(current) } catch { /* a listener must not break the lifecycle */ }
    return current
  }

  const refused = async (error: string): Promise<TapflowResult> => ({ ok: false, status: await status(), error })

  async function startService(state: TapflowStoredState): Promise<TapflowResult> {
    if (!state.nodePath) return refused('Tapflow is not installed by Specrails.')
    lastIssue = null
    stopping = false
    service.start({ nodePath: state.nodePath, port: state.port }, (detail) => {
      if (stopping) return
      lastIssue = { code: 'service-exited', detail }
      void changed()
    })
    await changed()
    if (!(await relay.waitAnswering(state.port, startTimeoutMs))) {
      lastIssue = { code: 'start-timeout', detail: `Tapflow did not answer on port ${state.port} within ${Math.round(startTimeoutMs / 1000)} s.` }
      await stopService()
      return { ok: false, status: await changed(), error: lastIssue.detail }
    }
    try {
      await relay.ensureCredentials(state.port)
    } catch (err) {
      lastIssue = { code: 'bootstrap-failed', detail: (err as Error).message }
      await stopService()
      return { ok: false, status: await changed(), error: lastIssue.detail }
    }
    return { ok: true, status: await changed() }
  }

  async function stopService(): Promise<void> {
    stopping = true
    try { await service.stop() } finally { stopping = false }
  }

  return {
    status,

    install: () => serialize(async () => {
      const unsupported = platformIssue(host)
      if (unsupported) return refused(unsupported.detail)
      if (installing) return { ok: true as const, status: await status(), sessionId: installing.sessionId }
      const node = installation.resolveNode()
      if ('issue' in node) { lastIssue = node.issue; return refused(node.issue.detail) }
      lastIssue = null
      const { sessionId } = installer.open(node.nodePath, (code) => {
        installing = null
        // The packages decide "installed": Tapflow's setup can end non-zero when the person declines an
        // optional step (the network filter, which Specrails leaves off), while iOS works.
        if (installation.present(TAPFLOW_VERSION)) {
          store.write({ ...stored(), installedVersion: TAPFLOW_VERSION, nodePath: node.nodePath, active: false })
          lastIssue = code === 0 ? null : { code: 'setup-incomplete', detail: `Tapflow is installed, but its setup did not finish (${code === null ? 'the terminal was closed' : `exit code ${code}`}). Install again to rerun the setup for iOS or Android.` }
        } else {
          lastIssue = { code: 'install-failed', detail: code === null ? 'The installer terminal was closed before it finished.' : `The installer exited with code ${code}.` }
        }
        void changed()
      })
      installing = { sessionId }
      return { ok: true as const, status: await changed(), sessionId }
    }),

    activate: () => serialize(async () => {
      const state = stored()
      const current = await status()
      if (current.phase === 'running' || current.phase === 'running-external') return { ok: true as const, status: current }
      if (current.phase !== 'installed' || !current.managed) return refused(current.phase === 'unsupported' ? current.issue?.detail ?? 'Unsupported' : 'Install Tapflow from Specrails first.')
      store.write({ ...state, active: true })
      return startService(state)
    }),

    deactivate: () => serialize(async () => {
      store.write({ ...stored(), active: false })
      // Never stop a Tapflow the person started: only the supervised child.
      if (service.state() !== 'none') await stopService()
      lastIssue = null
      return { ok: true as const, status: await changed() }
    }),

    uninstall: () => serialize(async () => {
      if (installing) return refused('The installer is still running.')
      if (service.state() !== 'none') await stopService()
      await installation.remove()
      store.write({ ...EMPTY_TAPFLOW_STATE, port: stored().port })
      lastIssue = null
      return { ok: true as const, status: await changed() }
    }),

    restoreOnBoot: () => serialize(async () => {
      const state = stored()
      if (!state.active || platformIssue(host)) return
      if (!state.installedVersion || !installation.present(state.installedVersion)) return
      // Someone else's Tapflow already answers there: use it, start nothing.
      if (await relay.answering(state.port)) return
      await startService(state)
    }),

    shutdown: async () => {
      if (service.state() !== 'none') await stopService()
    },

    servicePid: () => service.pid(),
  }
}
