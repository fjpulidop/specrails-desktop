import { describe, expect, it } from 'vitest'
import { isVersionedNodePath, stableNodeCommand, type NodePathDeps } from './node-path'

const CELLAR = '/opt/homebrew/Cellar/node/25.2.1/bin/node'

function deps(overrides: Partial<NodePathDeps> & { links?: Record<string, string> }): NodePathDeps {
  const links = overrides.links ?? {}
  const files = new Set([...Object.keys(links), ...Object.values(links)])
  return {
    execPath: CELLAR,
    bundled: null,
    env: { PATH: '/usr/bin:/opt/homebrew/bin' },
    platform: 'darwin',
    realpath: (file) => links[file] ?? (files.has(file) ? file : null),
    isExecutable: (file) => files.has(file),
    ...overrides,
  }
}

describe('isVersionedNodePath', () => {
  it('flags one installed version of Homebrew and the version managers, not stable links', () => {
    for (const file of [
      CELLAR, '/usr/local/Cellar/node@22/22.11.0/bin/node', '/Users/me/.nvm/versions/node/v22.11.0/bin/node',
      '/Users/me/.local/share/fnm/node-versions/v22.1.0/installation/bin/node', '/Users/me/.volta/tools/image/node/22.1.0/bin/node',
      '/Users/me/.asdf/installs/nodejs/22.1.0/bin/node', '/usr/local/n/versions/node/22.1.0/bin/node', 'C:\\Users\\me\\AppData\\Roaming\\nvm\\v22.1.0\\node.exe',
    ]) expect(isVersionedNodePath(file), file).toBe(true)
    for (const file of ['/opt/homebrew/bin/node', '/opt/homebrew/opt/node@22/bin/node', '/usr/local/bin/node', '/usr/bin/node', '/Users/me/.volta/bin/node', 'node']) {
      expect(isVersionedNodePath(file), file).toBe(false)
    }
  })
})

describe('stableNodeCommand', () => {
  it('prefers the bundled runtime', () => {
    expect(stableNodeCommand(deps({ bundled: '/Applications/Specrails.app/Contents/Resources/runtimes/node/bin/node' }))).toEqual({
      command: '/Applications/Specrails.app/Contents/Resources/runtimes/node/bin/node', source: 'bundled',
    })
  })

  it('never registers a pkg-built server binary: it ignores the bridge script and starts a second server', () => {
    const server = '/Users/me/specrails-desktop/src-tauri/target/debug/specrails-server'
    expect(stableNodeCommand(deps({ execPath: server, packagedServer: true, nodeOnPath: '/opt/homebrew/bin/node' }))).toEqual({
      command: '/opt/homebrew/bin/node', source: 'exec_path',
    })
    // A versioned node on PATH still resolves to its stable link.
    expect(stableNodeCommand(deps({
      execPath: server, packagedServer: true, nodeOnPath: CELLAR, links: { '/opt/homebrew/bin/node': CELLAR },
    }))).toEqual({ command: '/opt/homebrew/bin/node', source: 'stable_link' })
    const none = stableNodeCommand(deps({ execPath: server, packagedServer: true, nodeOnPath: null }))
    expect(none.warning).toMatch(/No Node\.js was found on PATH/)
    // The bundled runtime still wins.
    expect(stableNodeCommand(deps({ execPath: server, packagedServer: true, nodeOnPath: '/usr/bin/node', bundled: '/b/node' })).command).toBe('/b/node')
  })

  it('keeps an execPath that is not versioned', () => {
    expect(stableNodeCommand(deps({ execPath: '/usr/bin/node' }))).toEqual({ command: '/usr/bin/node', source: 'exec_path' })
  })

  it('swaps a Cellar path for the PATH link that resolves to the same Node', () => {
    const result = stableNodeCommand(deps({ links: { '/opt/homebrew/bin/node': CELLAR } }))
    expect(result).toEqual({ command: '/opt/homebrew/bin/node', source: 'stable_link' })
  })

  it('uses the Homebrew opt link of a keg-only formula (node@22) that is not on PATH', () => {
    const exec = '/opt/homebrew/Cellar/node@22/22.11.0/bin/node'
    const result = stableNodeCommand(deps({ execPath: exec, links: { '/opt/homebrew/opt/node@22/bin/node': exec, '/opt/homebrew/bin/node': CELLAR } }))
    expect(result).toEqual({ command: '/opt/homebrew/opt/node@22/bin/node', source: 'stable_link' })
  })

  it('never picks a link to another Node version, nor a versioned dir on PATH', () => {
    const exec = '/Users/me/.nvm/versions/node/v22.11.0/bin/node'
    const result = stableNodeCommand(deps({
      execPath: exec,
      env: { PATH: '/Users/me/.nvm/versions/node/v22.11.0/bin:/usr/local/bin' },
      links: { '/usr/local/bin/node': '/usr/local/Cellar/node/25.0.0/bin/node', [exec]: exec },
    }))
    expect(result.source).toBe('versioned')
    expect(result.command).toBe(exec)
    expect(result.warning).toMatch(/stops working when that version is upgraded/)
  })
})
