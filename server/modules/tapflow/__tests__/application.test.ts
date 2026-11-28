import { describe, expect, it, vi } from 'vitest'
import { createTapflowPlugin, type TapflowDeps } from '../application'
import { EMPTY_TAPFLOW_STATE, TAPFLOW_VERSION, type TapflowStatus, type TapflowStoredState } from '../domain'

/** Fakes for every port: an in-memory store, a controllable installer, service and relay. */
function harness(over: Partial<TapflowDeps> = {}) {
  let stored: TapflowStoredState = { ...EMPTY_TAPFLOW_STATE }
  let installed = false
  let installerExit: ((code: number | null) => void) | null = null
  let serviceExit: ((detail: string) => void) | null = null
  let alive = false
  let answering = false
  const statuses: TapflowStatus[] = []
  const service = {
    start: vi.fn((_opts: { nodePath: string; port: number }, onExit: (detail: string) => void) => { alive = true; answering = true; serviceExit = onExit }),
    stop: vi.fn(async () => { if (alive) { alive = false; answering = false; serviceExit?.('Tapflow stopped (SIGTERM).') } }),
    state: () => (alive ? 'alive' as const : 'none' as const),
    pid: () => (alive ? 4242 : null),
  }
  const relay = {
    answering: vi.fn(async () => answering),
    waitAnswering: vi.fn(async () => answering),
    ensureCredentials: vi.fn(async () => {}),
  }
  const deps: TapflowDeps = {
    host: { platform: 'darwin', arch: 'arm64' },
    store: { read: () => stored, write: (state) => { stored = state } },
    installation: {
      present: (version) => installed && version === TAPFLOW_VERSION,
      externalPresent: () => false,
      resolveNode: () => ({ nodePath: '/bundled/node' }),
      remove: vi.fn(async () => { installed = false }),
    },
    installer: { open: vi.fn((_node: string, onExit: (code: number | null) => void) => { installerExit = onExit; return { sessionId: 'term-1' } }) },
    service, relay,
    externalRelayAnswering: async () => false,
    onChange: (status) => statuses.push(status),
    ...over,
  }
  const plugin = createTapflowPlugin(deps)
  return {
    plugin, deps, service, relay, statuses,
    stored: () => stored,
    finishInstall: (code: number | null, files = true) => { installed = files; installerExit?.(code) },
    crash: () => { alive = false; answering = false; serviceExit?.('Tapflow exited with code 1.') },
    setAnswering: (value: boolean) => { answering = value },
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('Tapflow plugin use cases', () => {
  it('installs through the terminal and ends installed and inactive, recording the Node that installed it', async () => {
    const h = harness()
    const started = await h.plugin.install()
    expect(started).toMatchObject({ ok: true, sessionId: 'term-1', status: { phase: 'installing', installerSessionId: 'term-1' } })
    // A second click attaches to the same installer instead of opening another.
    expect(await h.plugin.install()).toMatchObject({ sessionId: 'term-1' })
    expect(h.deps.installer.open).toHaveBeenCalledTimes(1)
    h.finishInstall(0)
    await settle()
    expect(h.stored()).toMatchObject({ installedVersion: TAPFLOW_VERSION, nodePath: '/bundled/node', active: false })
    expect((await h.plugin.status()).phase).toBe('installed')
    expect(h.service.start).not.toHaveBeenCalled()
  })

  it('records the install when the packages are there even if Tapflow\'s setup ends non-zero, with a setup warning', async () => {
    const h = harness()
    await h.plugin.install()
    h.finishInstall(1, true)
    await settle()
    expect(await h.plugin.status()).toMatchObject({ phase: 'installed', managed: true, issue: { code: 'setup-incomplete', detail: expect.stringContaining('exit code 1') } })
    expect(h.stored().installedVersion).toBe(TAPFLOW_VERSION)
  })

  it('stays not installed with the exit code when the installer fails or is closed', async () => {
    const h = harness()
    await h.plugin.install()
    h.finishInstall(1, false)
    await settle()
    expect(await h.plugin.status()).toMatchObject({ phase: 'not-installed', issue: { code: 'install-failed', detail: 'The installer exited with code 1.' } })
    await h.plugin.install()
    h.finishInstall(null, false)
    await settle()
    expect((await h.plugin.status()).issue?.detail).toContain('closed before it finished')
    expect(h.stored().installedVersion).toBeNull()
  })

  it('refuses to install on an unsupported platform or without a usable Node', async () => {
    const windows = harness({ host: { platform: 'win32', arch: 'x64' } })
    expect(await windows.plugin.install()).toMatchObject({ ok: false, status: { phase: 'unsupported' } })
    expect(windows.deps.installer.open).not.toHaveBeenCalled()
    const noNode = harness()
    noNode.deps.installation.resolveNode = () => ({ issue: { code: 'node-missing', detail: 'Tapflow needs Node 22 or later with npm; Specrails found none.' } })
    expect(await noNode.plugin.install()).toMatchObject({ ok: false, error: expect.stringContaining('Node 22') })
  })

  it('activates the supervised service, bootstraps its credentials and deactivates it', async () => {
    const h = harness()
    await h.plugin.install(); h.finishInstall(0); await settle()
    const on = await h.plugin.activate()
    expect(on).toMatchObject({ ok: true, status: { phase: 'running' } })
    expect(h.service.start).toHaveBeenCalledWith({ nodePath: '/bundled/node', port: 4310 }, expect.any(Function))
    expect(h.relay.ensureCredentials).toHaveBeenCalledWith(4310)
    expect(h.stored().active).toBe(true)
    expect(h.plugin.servicePid()).toBe(4242)
    const off = await h.plugin.deactivate()
    expect(off).toMatchObject({ ok: true, status: { phase: 'installed', issue: null } })
    expect(h.stored().active).toBe(false)
  })

  it('starts one service for concurrent activations', async () => {
    const h = harness()
    await h.plugin.install(); h.finishInstall(0); await settle()
    await Promise.all([h.plugin.activate(), h.plugin.activate()])
    expect(h.service.start).toHaveBeenCalledTimes(1)
  })

  it('shows a crashed service as inactive with the reason, and can start it again', async () => {
    const h = harness()
    await h.plugin.install(); h.finishInstall(0); await settle()
    await h.plugin.activate()
    h.crash()
    await settle()
    expect(await h.plugin.status()).toMatchObject({ phase: 'installed', issue: { code: 'service-exited' } })
    expect(h.statuses.at(-1)?.phase).toBe('installed')
    expect((await h.plugin.activate()).ok).toBe(true)
  })

  it('stops a service that never answers and says so', async () => {
    const h = harness()
    await h.plugin.install(); h.finishInstall(0); await settle()
    h.service.start.mockImplementationOnce(() => { /* alive but never answering */ })
    h.relay.waitAnswering.mockResolvedValueOnce(false)
    const result = await h.plugin.activate()
    expect(result).toMatchObject({ ok: false, status: { issue: { code: 'start-timeout' } } })
    expect(h.service.stop).toHaveBeenCalled()
  })

  it('stops the service when the credential bootstrap fails', async () => {
    const h = harness()
    await h.plugin.install(); h.finishInstall(0); await settle()
    h.relay.ensureCredentials.mockRejectedValueOnce(new Error('This Tapflow already has an account Specrails did not create'))
    expect(await h.plugin.activate()).toMatchObject({ ok: false, status: { phase: 'installed', issue: { code: 'bootstrap-failed' } } })
    expect(h.service.state()).toBe('none')
  })

  it('never stops a Tapflow it did not start, and reports it as running-external', async () => {
    const h = harness({ externalRelayAnswering: async () => true })
    expect((await h.plugin.status()).phase).toBe('running-external')
    await h.plugin.deactivate()
    expect(h.service.stop).not.toHaveBeenCalled()
  })

  it('restores an active service at boot unless another Tapflow already answers on its port', async () => {
    const h = harness()
    await h.plugin.install(); h.finishInstall(0); await settle()
    await h.plugin.activate(); await h.plugin.shutdown()
    expect(h.stored().active).toBe(true)
    await h.plugin.restoreOnBoot()
    expect(h.service.start).toHaveBeenCalledTimes(2)
    await h.plugin.shutdown()
    h.setAnswering(true)
    await h.plugin.restoreOnBoot()
    expect(h.service.start).toHaveBeenCalledTimes(2)
  })

  it('uninstalls: stops the service, removes the files and forgets the install', async () => {
    const h = harness()
    await h.plugin.install(); h.finishInstall(0); await settle()
    await h.plugin.activate()
    expect(await h.plugin.uninstall()).toMatchObject({ ok: true, status: { phase: 'not-installed' } })
    expect(h.deps.installation.remove).toHaveBeenCalled()
    expect(h.stored()).toMatchObject({ installedVersion: null, nodePath: null, active: false })
  })
})
