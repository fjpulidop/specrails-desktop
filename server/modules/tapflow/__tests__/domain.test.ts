import { describe, expect, it } from 'vitest'
import {
  deriveStatus, EMPTY_TAPFLOW_STATE, installerScript, isTapflowServiceCommand, nodeMajor, platformIssue,
  serviceEnvironment, tapflowConfig, tapflowResourceRoots, TAPFLOW_PACKAGES, TAPFLOW_VERSION, type TapflowObservation,
} from '../domain'

const mac = { platform: 'darwin' as const, arch: 'arm64' }
const observe = (over: Partial<TapflowObservation> = {}): TapflowObservation => ({
  host: mac, stored: { ...EMPTY_TAPFLOW_STATE }, managedInstallPresent: false, externalInstall: false, installing: null,
  supervised: 'none', relayAnswering: false, externalProcessRunning: false, lastIssue: null, ...over,
})

describe('platform eligibility', () => {
  it('accepts only macOS on Apple Silicon, saying why otherwise', () => {
    expect(platformIssue(mac)).toBeNull()
    expect(platformIssue({ platform: 'darwin', arch: 'x64' })?.detail).toContain('Intel')
    expect(platformIssue({ platform: 'win32', arch: 'x64' })?.code).toBe('unsupported-platform')
    expect(platformIssue({ platform: 'linux', arch: 'arm64' })?.code).toBe('unsupported-platform')
  })
})

describe('deriveStatus', () => {
  it('is not installed and inactive by default, with the per-platform requirements', () => {
    const status = deriveStatus(observe())
    expect(status).toMatchObject({ phase: 'not-installed', managed: false, version: null, issue: null })
    expect(status.requirements.ios).toContain('Xcode 26 or 27')
    expect(status.requirements.android).toContain('Apple Silicon')
  })

  it('reports unsupported first, whatever else is observed', () => {
    expect(deriveStatus(observe({ host: { platform: 'win32', arch: 'x64' }, managedInstallPresent: true, relayAnswering: true })).phase).toBe('unsupported')
  })

  it('walks installing → installed (inactive) → starting → running for a managed install', () => {
    const stored = { ...EMPTY_TAPFLOW_STATE, installedVersion: TAPFLOW_VERSION }
    expect(deriveStatus(observe({ installing: { sessionId: 's1' } }))).toMatchObject({ phase: 'installing', installerSessionId: 's1' })
    expect(deriveStatus(observe({ stored, managedInstallPresent: true }))).toMatchObject({ phase: 'installed', managed: true, version: TAPFLOW_VERSION })
    expect(deriveStatus(observe({ stored, managedInstallPresent: true, supervised: 'alive' })).phase).toBe('starting')
    expect(deriveStatus(observe({ stored, managedInstallPresent: true, supervised: 'alive', relayAnswering: true })).phase).toBe('running')
  })

  it('shows a Tapflow Specrails did not start as running-external', () => {
    expect(deriveStatus(observe({ relayAnswering: true })).phase).toBe('running-external')
    expect(deriveStatus(observe({ externalInstall: true, externalProcessRunning: true })).phase).toBe('running-external')
  })

  it('shows an install the person made as installed but not managed, and keeps the last issue', () => {
    const issue = { code: 'service-exited' as const, detail: 'Tapflow exited with code 1.' }
    expect(deriveStatus(observe({ externalInstall: true, lastIssue: issue }))).toMatchObject({ phase: 'installed', managed: false, issue })
  })
})

describe('service configuration', () => {
  it('writes the config Specrails needs instead of running tapflow init', () => {
    expect(tapflowConfig(4310)).toEqual({ local: { port: 4310 }, agent: { lean: true } })
  })

  it('runs the lightest profile, loopback-only through the preload, with its Node first on PATH', () => {
    const env = serviceEnvironment({ home: '/t/home', port: 4310, preloadPath: '/t/a b/loopback.cjs', nodeBinDir: '/n/bin', basePath: '/usr/bin:/bin' })
    expect(env).toMatchObject({ TAPFLOW_HOME: '/t/home', TAPFLOW_PORT: '4310', TAPFLOW_LEAN: 'on', TAPFLOW_AUDIO: 'off', TAPFLOW_ALLOW_DISPLAY_SLEEP: '1', TAPFLOW_MAX_AUTOMATED_DEVICES: '1' })
    expect(env.NODE_OPTIONS).toBe('--require "/t/a b/loopback.cjs"')
    expect(env.PATH).toBe('/n/bin:/usr/bin:/bin')
  })

  it('installs the pinned packages with the given Node and npm, then runs tapflow setup, quoting every path', () => {
    const script = installerScript({ nodePath: "/Apps/Spec rails/node", npmCli: '/n/npm-cli.js', toolsDir: "/h/o'k/tools", tapflowCli: '/h/tools/tapflow.js', home: '/h/tools/home' })
    expect(TAPFLOW_PACKAGES).toEqual([`tapflow@${TAPFLOW_VERSION}`, `@tapflowio/mcp-server@${TAPFLOW_VERSION}`])
    expect(script.split('\n')[0]).toBe('set -e')
    expect(script).toContain(`'/Apps/Spec rails/node' '/n/npm-cli.js' install --prefix '/h/o'\\''k/tools' --no-audit --no-fund --save-exact tapflow@${TAPFLOW_VERSION} @tapflowio/mcp-server@${TAPFLOW_VERSION}`)
    expect(script).toContain("TAPFLOW_HOME='/h/tools/home' '/Apps/Spec rails/node' '/h/tools/tapflow.js' setup")
    expect(script.indexOf('install --prefix')).toBeLessThan(script.indexOf(' setup'))
  })

  it('reads the Node major', () => {
    expect(nodeMajor('v22.22.3\n')).toBe(22)
    expect(nodeMajor('25.9.0')).toBe(25)
    expect(nodeMajor('garbage')).toBeNull()
  })
})

describe('tapflowResourceRoots', () => {
  const UDID = 'A1B1366D-EDEF-4CB9-9355-9D2CDBB942F4'
  const table = [
    { pid: 100, ppid: 1, command: '/Apps/node /t/node_modules/tapflow/bin/tapflow.js start' },
    { pid: 101, ppid: 100, command: '/t/node_modules/@tapflowio/ios-agent/bin/screencapture-helper 30 x h264' },
    { pid: 200, ppid: 1, command: `launchd_sim /Users/me/Library/Developer/CoreSimulator/Devices/${UDID}/data/var/run/launchd_bootstrap.plist` },
    { pid: 300, ppid: 1, command: '/sdk/emulator/qemu/darwin-aarch64/qemu-system-aarch64 -netdelay none -avd tapflow-phone -no-window' },
    { pid: 400, ppid: 1, command: '/usr/bin/some-other-tool' },
  ]

  it('claims the service, each booted simulator and each emulator while Tapflow runs', () => {
    expect(tapflowResourceRoots(table, 100)).toEqual([
      { label: 'Tapflow service', pid: 100 },
      { label: 'iOS Simulator A1B1366D', pid: 200 },
      { label: 'Android Emulator tapflow-phone', pid: 300 },
    ])
  })

  it('finds a Tapflow the person started by its command line', () => {
    expect(tapflowResourceRoots(table, null)[0]).toEqual({ label: 'Tapflow service', pid: 100 })
    expect(isTapflowServiceCommand('node /usr/local/bin/tapflow start')).toBe(true)
    expect(isTapflowServiceCommand('tapflow doctor --json')).toBe(false)
  })

  it('claims nothing when no Tapflow runs, even with a simulator booted', () => {
    expect(tapflowResourceRoots(table.filter((row) => row.pid !== 100 && row.pid !== 101), null)).toEqual([])
    expect(tapflowResourceRoots(table.slice(2), 100)).toEqual([])
  })
})

describe('device memory as physical footprint', () => {
  it('parses top MEM values in every unit, ignoring the header and malformed rows', async () => {
    const { parseTopMemory } = await import('../domain')
    const out = parseTopMemory(['Processes: 900 total', 'PID    MEM', '15131  30M', '81165  8110M+', '1667   1.5G-', '42     512K', '7      100B', 'nonsense line', ''].join('\n'))
    expect(out.get(15131)).toBe(30 * 1024 ** 2)
    expect(out.get(81165)).toBe(8110 * 1024 ** 2)
    expect(out.get(1667)).toBe(Math.round(1.5 * 1024 ** 3))
    expect(out.get(42)).toBe(512 * 1024)
    expect(out.get(7)).toBe(100)
    expect(out.size).toBe(5)
  })

  it('collects the whole tree of each device root and never the service', async () => {
    const { deviceTreePids } = await import('../domain')
    const table = [
      { pid: 100, ppid: 1, command: 'tapflow start' }, { pid: 101, ppid: 100, command: 'helper' },
      { pid: 200, ppid: 1, command: 'launchd_sim' }, { pid: 201, ppid: 200, command: 'SpringBoard' }, { pid: 202, ppid: 201, command: 'app' },
    ]
    expect(deviceTreePids(table, [{ label: 'Tapflow service', pid: 100 }, { label: 'iOS Simulator X', pid: 200 }]).sort()).toEqual([200, 201, 202])
    expect(deviceTreePids(table, [{ label: 'Tapflow service', pid: 100 }])).toEqual([])
  })
})
