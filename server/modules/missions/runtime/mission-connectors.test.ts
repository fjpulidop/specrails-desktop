import { describe, expect, it } from 'vitest'
import {
  ConnectorSettingsValidationError,
  applyConnectorToggle,
  approximateToolTokens,
  claudeDenySettings,
  claudeRememberedConnectors,
  claudeUserServerSpec,
  codexDisableOverrides,
  connectorRows,
  connectorTurnPlan,
  connectorsMarker,
  emptyConnectorSettings,
  geminiExcluded,
  isSpecrailsDuplicate,
  parseClaudeMcpList,
  parseCodexMcpServers,
  parseConnectorSettings,
  parseJsonMcpServers,
  type DetectedConnector,
  type MissionConnectorSettings,
} from './mission-connectors'

const CODEX_TOML = `
model = "gpt-6.1-sol"

[mcp_servers.node_repl]
command = "/Applications/ChatGPT.app/node_repl"

[mcp_servers.node_repl.env]
FOO = "bar"

[mcp_servers.openaiDeveloperDocs]
url = "https://developers.openai.com/mcp"

[mcp_servers.computer-use]
command = "./Client"
args = ["mcp"]
enabled = false

[mcp_servers."my server"] # quoted
command = 'uvx'
args = ['tool', "--flag=\\"x\\""]

[mcp_servers.specrails]
command = "/Applications/Specrails.app/Contents/Resources/runtimes/node/bin/node"
args = ["/Applications/Specrails.app/Contents/Resources/binaries/specrails-mcp.js"]

[mcp_servers.specrails.tools.specrails_projects]
approval_mode = "approve"

[profiles.fast]
command = "not-a-server"
`

const CLAUDE_MCP_LIST = `Checking MCP server health…

claude.ai Claude Docs: https://api.anthropic.com/v1/pages/mcp - ✔ Connected
claude.ai Google Drive: https://drivemcp.googleapis.com/mcp/v1 - ✔ Connected
claude.ai Gmail: https://gmailmcp.googleapis.com/mcp/v1 - ! Needs authentication
claude.ai Broken: https://example.com/mcp - ✘ Failed to connect
plugin:customer-support:slack: https://mcp.slack.com/mcp (HTTP) - ! Needs authentication
headroom: /Users/me/.local/bin/headroom mcp serve - ✔ Connected
`

function settings(disabled: Partial<MissionConnectorSettings['disabled']> = {}): MissionConnectorSettings {
  const base = emptyConnectorSettings()
  return { ...base, disabled: { ...base.disabled, ...disabled } }
}

describe('parseCodexMcpServers', () => {
  it('reads server tables with transport and enabled, ignoring nested and other tables', () => {
    const servers = parseCodexMcpServers(CODEX_TOML)
    expect(servers.map((server) => server.name)).toEqual(['computer-use', 'my server', 'node_repl', 'openaiDeveloperDocs', 'specrails'])
    expect(servers.find((server) => server.name === 'computer-use')).toMatchObject({ kind: 'mcp-server', enabledInProvider: false, transport: { command: './Client', args: ['mcp'] } })
    expect(servers.find((server) => server.name === 'my server')?.transport).toEqual({ command: 'uvx', args: ['tool', '--flag="x"'] })
    expect(servers.find((server) => server.name === 'openaiDeveloperDocs')?.transport).toEqual({ url: 'https://developers.openai.com/mcp' })
    expect(servers.find((server) => server.name === 'node_repl')?.enabledInProvider).toBe(true)
  })

  it('returns nothing for a config without MCP servers', () => {
    expect(parseCodexMcpServers('model = "x"\n')).toEqual([])
  })
})

describe('parseClaudeMcpList', () => {
  it('keeps only claude.ai account connectors with their health', () => {
    const connectors = parseClaudeMcpList(CLAUDE_MCP_LIST)
    expect(connectors.map((connector) => [connector.name, connector.status])).toEqual([
      ['claude.ai Broken', 'failed'],
      ['claude.ai Claude Docs', 'connected'],
      ['claude.ai Gmail', 'needs-auth'],
      ['claude.ai Google Drive', 'connected'],
    ])
    expect(connectors[1]).toMatchObject({ provider: 'claude', kind: 'account-connector', transport: { url: 'https://api.anthropic.com/v1/pages/mcp' } })
  })

  it('falls back to the connectors Claude Code remembers', () => {
    expect(claudeRememberedConnectors({ claudeAiMcpEverConnected: ['claude.ai Gmail', 'claude.ai Gmail', 'other', 3] }).map((connector) => [connector.name, connector.status])).toEqual([['claude.ai Gmail', 'unknown']])
    expect(claudeRememberedConnectors(null)).toEqual([])
  })
})

describe('parseJsonMcpServers', () => {
  it('reads an mcpServers map and marks excluded entries off', () => {
    const json = { mcpServers: { b: { command: 'b', args: ['x', 1] }, a: { url: 'https://a', type: 'http' }, junk: 'x' }, mcp: { excluded: ['b'] } }
    const servers = parseJsonMcpServers('gemini', json, { excluded: geminiExcluded(json) })
    expect(servers.map((server) => [server.name, server.enabledInProvider])).toEqual([['a', true], ['b', false]])
    expect(servers[1]!.transport).toEqual({ command: 'b', args: ['x'] })
    expect(parseJsonMcpServers('claude', null)).toEqual([])
  })
})

describe('isSpecrailsDuplicate', () => {
  it('matches the reserved name, the bundled bridge and the Desktop HTTP endpoint', () => {
    expect(isSpecrailsDuplicate({ name: 'Specrails' })).toBe(true)
    expect(isSpecrailsDuplicate({ name: 'sr', transport: { command: 'node', args: ['/Applications/Specrails.app/binaries/specrails-mcp.js'] } })).toBe(true)
    expect(isSpecrailsDuplicate({ name: 'sr', transport: { url: 'http://127.0.0.1:4200/api/mcp' } })).toBe(true)
    expect(isSpecrailsDuplicate({ name: 'docs', transport: { url: 'https://example.com/api/mcp' } })).toBe(false)
    expect(isSpecrailsDuplicate({ name: 'tokensave', transport: { command: 'tokensave', args: ['serve'] } })).toBe(false)
  })
})

describe('settings', () => {
  it('parses stored settings tolerantly', () => {
    expect(parseConnectorSettings(undefined)).toEqual(emptyConnectorSettings())
    expect(parseConnectorSettings('{bad')).toEqual(emptyConnectorSettings())
    expect(parseConnectorSettings(JSON.stringify({ disabled: { codex: ['b', 'a', 'a', 4], claude: 'x', other: ['y'] } })).disabled).toEqual({ claude: [], codex: ['a', 'b'], gemini: [], kimi: [] })
  })

  it('toggles one connector in the deny-list', () => {
    const off = applyConnectorToggle(emptyConnectorSettings(), { provider: 'claude', name: 'claude.ai Gmail', enabled: false })
    expect(off.disabled.claude).toEqual(['claude.ai Gmail'])
    expect(applyConnectorToggle(off, { provider: 'claude', name: 'claude.ai Gmail', enabled: true }).disabled.claude).toEqual([])
  })

  it('rejects malformed toggles', () => {
    for (const body of [null, { provider: 'x', name: 'a', enabled: true }, { provider: 'codex', name: '', enabled: true }, { provider: 'codex', name: 'a', enabled: 'no' }]) {
      expect(() => applyConnectorToggle(emptyConnectorSettings(), body)).toThrow(ConnectorSettingsValidationError)
    }
  })
})

const codex = parseCodexMcpServers(CODEX_TOML)

describe('connectorRows', () => {
  it('is enabled by default and locks duplicates, provider-disabled and External MCP entries', () => {
    const rows = connectorRows('codex', codex, settings({ codex: ['node_repl'] }), { injected: ['openaiDeveloperDocs'], sizes: { 'codex:my server': { tools: 3, tokens: 500, measuredAt: 't' } } })
    const byName = Object.fromEntries(rows.map((row) => [row.name, row]))
    expect(byName['computer-use']).toMatchObject({ enabled: false, lock: 'disabled-in-provider' })
    expect(byName.specrails).toMatchObject({ enabled: false, lock: 'specrails-duplicate' })
    expect(byName.openaiDeveloperDocs).toMatchObject({ enabled: true, lock: 'external-mcp' })
    expect(byName.node_repl).toMatchObject({ enabled: false })
    expect(byName.node_repl!.lock).toBeUndefined()
    expect(byName['my server']).toMatchObject({ enabled: true, size: { tools: 3, tokens: 500 } })
  })

  it('marks Kimi servers unsupported', () => {
    const kimi = parseJsonMcpServers('kimi', { mcpServers: { a: { command: 'a' } } })
    expect(connectorRows('kimi', kimi, settings())[0]).toMatchObject({ enabled: true, lock: 'unsupported' })
  })
})

describe('connectorTurnPlan', () => {
  it('Codex: lists enabled servers by name only and leaves the rest to Core to disable', () => {
    const plan = connectorTurnPlan('codex', codex, settings({ codex: ['node_repl'] }), { reserved: ['specrails'] })
    expect(plan.inheritUserScope).toBe(false)
    expect(plan.servers).toEqual([{ name: 'my server' }, { name: 'openaiDeveloperDocs' }])
    expect(plan.denied).toEqual(['computer-use', 'node_repl'])
  })

  it('Codex: never re-lists or denies a name the turn already carries', () => {
    const plan = connectorTurnPlan('codex', codex, settings(), { reserved: ['specrails', 'openaiDeveloperDocs'] })
    expect(plan.servers.map((server) => server.name)).not.toContain('openaiDeveloperDocs')
    expect(plan.denied).not.toContain('openaiDeveloperDocs')
  })

  it('Codex: a duplicate of Specrails under another name is always disabled', () => {
    const duplicate: DetectedConnector = { provider: 'codex', name: 'sr-copy', kind: 'mcp-server', enabledInProvider: true, transport: { command: 'node', args: ['/x/specrails-mcp.js'] } }
    expect(connectorTurnPlan('codex', [duplicate], settings(), { reserved: ['specrails'] }).denied).toEqual(['sr-copy'])
  })

  const claude: DetectedConnector[] = [
    ...parseClaudeMcpList(CLAUDE_MCP_LIST),
    ...parseJsonMcpServers('claude', { mcpServers: { tokensave: { command: 'tokensave', args: ['serve'], env: { A: '1' } }, remote: { type: 'http', url: 'https://r', headers: { X: 'y' } }, legacy: { type: 'sse', url: 'https://s' } } }),
  ]

  it('Claude: denies stored names (minus reserved) and injects user servers only with on-demand tools', () => {
    const stored = settings({ claude: ['claude.ai Gmail', 'tokensave', 'specrails', 'claude.ai Not Seen'] })
    const without = connectorTurnPlan('claude', claude, stored, { reserved: ['specrails'] })
    expect(without).toEqual({ inheritUserScope: true, servers: [], denied: ['claude.ai Gmail', 'claude.ai Not Seen', 'tokensave'] })
    const deferred = connectorTurnPlan('claude', claude, settings(), { reserved: ['specrails'], deferredMcpTools: true })
    expect(deferred.servers).toEqual([
      { name: 'remote', url: 'https://r', headers: { X: 'y' } },
      { name: 'tokensave', command: 'tokensave', args: ['serve'], env: { A: '1' } },
    ])
  })

  it('Gemini: excludes turned-off, provider-excluded and duplicate servers', () => {
    const json = { mcpServers: { a: { command: 'a' }, b: { command: 'b' }, specrails: { command: 'node' } }, mcp: { excluded: ['b'] } }
    const gemini = parseJsonMcpServers('gemini', json, { excluded: geminiExcluded(json) })
    expect(connectorTurnPlan('gemini', gemini, settings({ gemini: ['a'] }), { reserved: [] }).denied).toEqual(['a', 'b', 'specrails'])
  })

  it('other providers inherit everything', () => {
    expect(connectorTurnPlan('kimi', [], settings(), { reserved: [] })).toEqual({ inheritUserScope: true, servers: [], denied: [] })
    expect(connectorTurnPlan('local-llama', [], settings(), { reserved: [] })).toEqual({ inheritUserScope: true, servers: [], denied: [] })
  })
})

describe('provider switches', () => {
  it('builds Codex -c disables for addressable names only', () => {
    expect(codexDisableOverrides(['blender', 'my server', 'premiere-pro'])).toEqual(['-c', 'mcp_servers.blender.enabled=false', '-c', 'mcp_servers.premiere-pro.enabled=false'])
  })

  it('builds the Claude deny file body', () => {
    expect(claudeDenySettings(['b', 'a', 'a'])).toEqual({ deniedMcpServers: [{ serverName: 'a' }, { serverName: 'b' }] })
  })

  it('tags a deny-list stably', () => {
    expect(connectorsMarker([])).toBeNull()
    expect(connectorsMarker(['b', 'a'])).toBe(connectorsMarker(['a', 'b', 'a']))
    expect(connectorsMarker(['a'])).not.toBe(connectorsMarker(['b']))
  })

  it('skips Claude user servers Core cannot express', () => {
    expect(claudeUserServerSpec({ provider: 'claude', name: 'x', kind: 'mcp-server', enabledInProvider: true, config: { type: 'sse', url: 'https://s' } })).toBeNull()
  })

  it('approximates tokens from definition size', () => {
    expect(approximateToolTokens(88_000)).toBe(32_593)
  })
})
