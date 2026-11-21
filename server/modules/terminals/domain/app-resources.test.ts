import { describe, expect, it } from 'vitest'
import { classifyCommand, isSamplerCommand, measureAppResources, SERVER_ITEM_LABEL } from './app-resources'
import type { ProcessSample } from './mission-resources'

const MB = 1024 * 1024
const p = (pid: number, ppid: number, command: string, rssMb = 10, cpuPercent = 1): ProcessSample => ({ pid, ppid, command, rssBytes: rssMb * MB, cpuPercent })

const SERVER = 100
const table: ProcessSample[] = [
  p(1, 0, '/sbin/launchd', 50),
  p(SERVER, 1, 'node /app/server/index.js', 200, 5),
  p(200, SERVER, '/usr/local/bin/claude -p --output-format stream-json', 300, 20),
  p(201, 200, 'node /tmp/mission/worktree/mcp-bridge.js', 40),
  p(300, SERVER, 'npm run dev', 80),
  p(301, 300, 'node vite', 120, 10),
  p(400, SERVER, '/bin/zsh -l', 5),
  p(401, 400, 'git status', 2),
  p(500, SERVER, 'node /app/mcp-bridge/dist/bridge.js', 60),
  p(501, SERVER, 'git fetch origin', 15),
  p(502, SERVER, 'node /opt/codex/bin/codex.js exec', 90),
  p(503, SERVER, 'ps -axo pid=,ppid=,pcpu=,rss=,command=', 1),
  p(504, SERVER, 'sleep 10', 1),
  p(900, 1, '/Applications/Other.app/Contents/MacOS/Other', 500),
]

describe('classifyCommand', () => {
  it('recognises agent CLIs, MCP processes, git and others', () => {
    expect(classifyCommand('/usr/local/bin/claude -p')).toEqual({ category: 'agent-cli', label: 'Claude' })
    expect(classifyCommand('node /usr/lib/node_modules/@openai/codex/bin/codex.js exec')).toEqual({ category: 'agent-cli', label: 'Codex' })
    expect(classifyCommand('gemini --yolo')).toEqual({ category: 'agent-cli', label: 'Gemini' })
    expect(classifyCommand('kimi.exe run')).toEqual({ category: 'agent-cli', label: 'Kimi' })
    expect(classifyCommand('node /app/mcp-bridge/dist/bridge.js')).toEqual({ category: 'mcp', label: 'MCP bridge' })
    expect(classifyCommand('node /app/local-runner/dist/runner.js')).toEqual({ category: 'mcp', label: 'Local runner' })
    expect(classifyCommand('npx @playwright/mcp --headless')).toEqual({ category: 'mcp', label: 'MCP server' })
    expect(classifyCommand('/usr/bin/git fetch origin')).toEqual({ category: 'git', label: 'git' })
    expect(classifyCommand('gh pr view 12')).toEqual({ category: 'git', label: 'gh' })
    expect(classifyCommand('node vite --port 5173')).toEqual({ category: 'other', label: 'vite' })
    expect(classifyCommand('sleep 10')).toEqual({ category: 'other', label: 'sleep' })
    expect(classifyCommand('npm run dev')).toEqual({ category: 'other', label: 'npm run dev' })
  })

  it('ignores agent names that only appear in arguments', () => {
    expect(classifyCommand('grep -r claude src')).toEqual({ category: 'other', label: 'grep' })
  })

  it('detects the sampler query itself', () => {
    expect(isSamplerCommand('ps -axo pid=,ppid=,pcpu=,rss=,command=')).toBe(true)
    expect(isSamplerCommand('powershell.exe -Command Get-CimInstance Win32_Process | Select-Object ProcessId')).toBe(true)
    expect(isSamplerCommand('ps aux')).toBe(false)
  })
})

describe('measureAppResources', () => {
  it('attributes each process once, owned roots first, then classified leftovers, then the server', () => {
    const result = measureAppResources(table, [
      { category: 'missions', label: 'Fix login', pid: 200, projectId: 'p1', projectName: 'Web', chatId: 'c1' },
      // Same tree as the mission: already claimed, contributes nothing.
      { category: 'background', label: 'mcp', pid: 201, projectId: 'p1', chatId: 'c1' },
      { category: 'background', label: 'npm run dev', pid: 300, projectId: 'p1', chatId: 'c1' },
      { category: 'terminals', label: 'Terminal 1', pid: 400, projectId: 'p2' },
      // Gone from the table.
      { category: 'terminals', label: 'Closed', pid: 4040, projectId: 'p2' },
    ], SERVER)

    const byId = Object.fromEntries(result.categories.map((c) => [c.id, c]))
    expect(result.categories.map((c) => c.id)).toEqual(['missions', 'background', 'terminals', 'agent-cli', 'mcp', 'git', 'other', 'server'])
    expect(byId.missions).toMatchObject({ processCount: 2, memoryBytes: 340 * MB, cpuPercent: 21 })
    expect(byId.missions.items).toEqual([{ label: 'Fix login', projectId: 'p1', projectName: 'Web', chatId: 'c1', cpuPercent: 21, memoryBytes: 340 * MB, processCount: 2 }])
    expect(byId.background.items).toHaveLength(1)
    expect(byId.background).toMatchObject({ processCount: 2, memoryBytes: 200 * MB })
    expect(byId.terminals).toMatchObject({ processCount: 2, memoryBytes: 7 * MB })
    expect(byId['agent-cli'].items).toEqual([expect.objectContaining({ label: 'Codex', processCount: 1 })])
    expect(byId.mcp.items).toEqual([expect.objectContaining({ label: 'MCP bridge', memoryBytes: 60 * MB })])
    expect(byId.git.items).toEqual([expect.objectContaining({ label: 'git', processCount: 1 })])
    expect(byId.other.items.map((i) => i.label)).toEqual(['sleep'])
    expect(byId.server.items).toEqual([expect.objectContaining({ label: SERVER_ITEM_LABEL, processCount: 1, memoryBytes: 200 * MB })])

    // launchd, the unrelated app and the ps query are not counted.
    expect(result.totals.processCount).toBe(11)
    expect(result.totals.memoryBytes).toBe((340 + 200 + 7 + 90 + 60 + 15 + 1 + 200) * MB)
  })

  it('merges roots of the same owner into one item and never lets a root absorb the server', () => {
    const result = measureAppResources(table, [
      { category: 'missions', label: 'Mission', pid: 200, chatId: 'c1' },
      { category: 'missions', label: 'Mission', pid: 502, chatId: 'c1' },
      { category: 'missions', label: 'Bad root', pid: SERVER, chatId: 'c9' },
    ], SERVER)
    const missions = result.categories.find((c) => c.id === 'missions')!
    expect(missions.items).toEqual([expect.objectContaining({ label: 'Mission', processCount: 3 })])
    expect(result.categories.find((c) => c.id === 'server')?.processCount).toBe(1)
    expect(result.categories.some((c) => c.id === 'agent-cli')).toBe(false)
  })

  it('puts rails right after missions and before background processes in the claimed-set priority', () => {
    const result = measureAppResources(table, [
      { category: 'missions', label: 'Fix login', pid: 200, chatId: 'c1' },
      // The Core definition runtime of a rail run: its provider CLI children come with it.
      { category: 'rails', label: 'Rail 1 · Implement · #12', pid: 502, projectId: 'p1', projectName: 'Web', runId: 'r1' },
      { category: 'rails', label: '/specrails:implement #12', pid: 501, projectId: 'p1', runId: 'j1' },
      // A background root inside the rail's tree is already claimed.
      { category: 'background', label: 'codex child', pid: 502, projectId: 'p1' },
    ], SERVER)
    expect(result.categories.map((c) => c.id)).toEqual(['missions', 'rails', 'mcp', 'other', 'server'])
    expect(result.categories.find((c) => c.id === 'other')!.items.map((i) => i.label)).toEqual(['npm run dev', 'zsh', 'sleep'])
    const rails = result.categories.find((c) => c.id === 'rails')!
    expect(rails.items).toEqual([
      { label: 'Rail 1 · Implement · #12', projectId: 'p1', projectName: 'Web', runId: 'r1', cpuPercent: 1, memoryBytes: 90 * MB, processCount: 1 },
      { label: '/specrails:implement #12', projectId: 'p1', runId: 'j1', cpuPercent: 1, memoryBytes: 15 * MB, processCount: 1 },
    ])
    expect(result.categories.some((c) => c.id === 'agent-cli' || c.id === 'git')).toBe(false)
  })

  it('omits empty categories and tolerates a table without the server', () => {
    const result = measureAppResources([p(7, 1, 'claude')], [], SERVER)
    expect(result).toEqual({ totals: { cpuPercent: 0, memoryBytes: 0, processCount: 0 }, categories: [] })
  })

  it('survives parent cycles', () => {
    const cyclic = [p(SERVER, 1, 'node server'), p(10, 11, 'a'), p(11, 10, 'b')]
    const result = measureAppResources(cyclic, [{ category: 'background', label: 'loop', pid: 10 }], SERVER)
    expect(result.categories.find((c) => c.id === 'background')?.processCount).toBe(2)
  })
})

describe('the server binary as a runtime', () => {
  it("names Core's session host instead of the server binary that runs it", () => {
    const host = '/Applications/Specrails.app/Contents/MacOS/specrails-server /Users/me/.specrails/core/current/dist/agent-runtime/cli.js host --stdio --scope specrails'
    expect(classifyCommand(host)).toEqual({ category: 'agent-cli', label: 'Core session host' })
    expect(classifyCommand('/x/specrails-server /x/dist/agent-runtime/cli.js status --run r1')).toEqual({ category: 'agent-cli', label: 'Core runtime' })
    expect(classifyCommand('/x/specrails-server /x/scripts/some-tool.js --flag').label).toBe('some-tool')
  })
})
