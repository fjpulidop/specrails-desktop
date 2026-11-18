/**
 * Pure model for the app-wide Resources view: attribute one process-table snapshot to everything Specrails
 * launched. Each process is counted once (a claimed set; the first root that reaches it wins), in priority
 * order: agent sessions, rails/loops/jobs, background processes, terminals, then the server's remaining children classified by
 * command line, then the server process itself. No I/O here; `runtime/app-resources.ts` feeds it.
 */
import type { MissionResourceTotals, ProcessSample } from './mission-resources'

export type AppResourceCategoryId = 'missions' | 'rails' | 'background' | 'terminals' | 'agent-cli' | 'mcp' | 'git' | 'other' | 'server'

/** Display and attribution order. */
export const APP_RESOURCE_CATEGORIES: readonly AppResourceCategoryId[] = ['missions', 'rails', 'background', 'terminals', 'agent-cli', 'mcp', 'git', 'other', 'server']

/** A process tree Specrails knows the owner of. */
export interface AppResourceRoot {
  category: 'missions' | 'rails' | 'background' | 'terminals'
  label: string
  pid: number
  projectId?: string
  projectName?: string
  chatId?: string
  /** Loop run or job id, for rails. */
  runId?: string
}

export interface AppResourceItem {
  label: string
  projectId?: string
  projectName?: string
  chatId?: string
  /** Loop run or job id, for rails. */
  runId?: string
  cpuPercent: number
  memoryBytes: number
  processCount: number
}

export interface AppResourceCategory extends MissionResourceTotals {
  id: AppResourceCategoryId
  items: AppResourceItem[]
}

export interface AppResourceMeasurement {
  totals: MissionResourceTotals
  categories: AppResourceCategory[]
}

/** Label of the server process itself; the client translates it by category. */
export const SERVER_ITEM_LABEL = 'Specrails server'

/** `npm run dev` reads better than its script name alone. */
const PACKAGE_RUNNERS = new Set(['npm', 'pnpm', 'yarn'])
// The packaged server binary doubles as the Node runtime for the scripts it
// launches (e.g. Core's agent-session host), so it is a wrapper too: name the
// script it runs, never the binary.
const RUNTIME_WRAPPERS = new Set(['node', 'bun', 'deno', 'npx', 'python', 'python3', 'cmd', 'sh', 'bash', 'zsh', 'specrails-server'])

function basename(token: string): string {
  const clean = token.replace(/^["']|["']$/g, '')
  const last = clean.split(/[\\/]/).filter(Boolean).pop() ?? clean
  return last.replace(/\.(exe|cmd|bat|js|mjs|cjs)$/i, '')
}

/** The executable part of a command line: tokens up to the first flag (paths may contain spaces). */
function commandHead(command: string): string[] {
  const head: string[] = []
  for (const token of command.trim().split(/\s+/)) {
    if (!token || token.startsWith('-') || head.length >= 4) break
    head.push(token)
  }
  return head
}

const AGENT_CLIS: Array<[RegExp, string]> = [
  [/claude/, 'Claude'],
  [/codex/, 'Codex'],
  [/gemini/, 'Gemini'],
  [/kimi/, 'Kimi'],
]

/** Classifies a process the server launched without a registered owner, by its command line. */
export function classifyCommand(command: string): { category: 'agent-cli' | 'mcp' | 'git' | 'other'; label: string } {
  const lower = command.toLowerCase()
  if (/mcp-bridge/.test(lower)) return { category: 'mcp', label: 'MCP bridge' }
  if (/local-runner/.test(lower)) return { category: 'mcp', label: 'Local runner' }
  // Core's agent runtime: the session host runs mission and Intent sessions; other
  // runtime commands (run, status…) without a registered owner are still agents.
  if (/agent-runtime[\\/]cli(\.m?js)?\b/.test(lower)) {
    return { category: 'agent-cli', label: /\shost(\s|$)/.test(lower) ? 'Core session host' : 'Core runtime' }
  }
  const head = commandHead(lower)
  const headText = head.join(' ')
  for (const [pattern, label] of AGENT_CLIS) if (pattern.test(headText)) return { category: 'agent-cli', label }
  if (/(^|[\s\\/])mcp([\s\-_.]|$)/.test(headText) || /-mcp(\s|$|\.)/.test(headText)) return { category: 'mcp', label: 'MCP server' }
  const names = head.map(basename)
  const program = names[0] ?? ''
  if (program === 'git' || program === 'gh') return { category: 'git', label: program }
  if (PACKAGE_RUNNERS.has(program)) return { category: 'other', label: head.slice(0, 3).join(' ') }
  const shown = RUNTIME_WRAPPERS.has(program) && names[1] ? names[1] : program
  return { category: 'other', label: shown || 'process' }
}

/** The process-table query itself (`ps` / the CIM PowerShell) is not something Specrails runs for the user. */
export function isSamplerCommand(command: string): boolean {
  return /(^|[\\/])ps\s+-axo\s+pid=/.test(command) || /Get-CimInstance Win32_Process/.test(command)
}

const round1 = (value: number) => Math.round(value * 10) / 10

export function measureAppResources(table: ProcessSample[], roots: AppResourceRoot[], serverPid: number): AppResourceMeasurement {
  const byPid = new Map(table.map((s) => [s.pid, s]))
  const children = new Map<number, ProcessSample[]>()
  for (const s of table) {
    if (s.ppid === s.pid) continue
    const list = children.get(s.ppid)
    if (list) list.push(s)
    else children.set(s.ppid, [s])
  }
  // The server is reported on its own, last; no root's tree may absorb it.
  const claimed = new Set<number>([serverPid])

  const claimTree = (rootPid: number): ProcessSample[] => {
    const root = byPid.get(rootPid)
    if (!root || claimed.has(rootPid)) return []
    const out: ProcessSample[] = []
    const stack = [root]
    while (stack.length) {
      const next = stack.pop()!
      if (claimed.has(next.pid)) continue
      claimed.add(next.pid)
      out.push(next)
      stack.push(...(children.get(next.pid) ?? []))
    }
    return out
  }

  const items = new Map<AppResourceCategoryId, Map<string, AppResourceItem>>()
  const add = (category: AppResourceCategoryId, item: Omit<AppResourceItem, 'cpuPercent' | 'memoryBytes' | 'processCount'>, tree: ProcessSample[]) => {
    if (!tree.length) return
    let group = items.get(category)
    if (!group) { group = new Map(); items.set(category, group) }
    const key = [item.label, item.projectId ?? '', item.chatId ?? '', item.runId ?? ''].join('\u0000')
    const current = group.get(key) ?? { ...item, cpuPercent: 0, memoryBytes: 0, processCount: 0 }
    for (const s of tree) {
      current.cpuPercent += s.cpuPercent
      current.memoryBytes += s.rssBytes
      current.processCount += 1
    }
    group.set(key, current)
  }

  for (const root of roots) {
    const { category, pid, ...item } = root
    add(category, item, claimTree(pid))
  }

  const leftovers = (children.get(serverPid) ?? [])
    .filter((s) => !claimed.has(s.pid) && !isSamplerCommand(s.command))
    .sort((a, b) => a.pid - b.pid)
  for (const child of leftovers) {
    const { category, label } = classifyCommand(child.command)
    add(category, { label }, claimTree(child.pid))
  }

  const server = byPid.get(serverPid)
  if (server) add('server', { label: SERVER_ITEM_LABEL }, [server])

  const categories: AppResourceCategory[] = []
  for (const id of APP_RESOURCE_CATEGORIES) {
    const group = items.get(id)
    if (!group) continue
    const list = [...group.values()]
      .map((item) => ({ ...item, cpuPercent: round1(item.cpuPercent) }))
      .sort((a, b) => b.memoryBytes - a.memoryBytes || b.cpuPercent - a.cpuPercent || a.label.localeCompare(b.label))
    categories.push({
      id,
      cpuPercent: round1(list.reduce((sum, i) => sum + i.cpuPercent, 0)),
      memoryBytes: list.reduce((sum, i) => sum + i.memoryBytes, 0),
      processCount: list.reduce((sum, i) => sum + i.processCount, 0),
      items: list,
    })
  }
  return {
    totals: {
      cpuPercent: round1(categories.reduce((sum, c) => sum + c.cpuPercent, 0)),
      memoryBytes: categories.reduce((sum, c) => sum + c.memoryBytes, 0),
      processCount: categories.reduce((sum, c) => sum + c.processCount, 0),
    },
    categories,
  }
}
