import { spawn } from 'child_process'
import type { BridgeEntry } from './client-config'

/**
 * The connect verify step: run the exact registered entry as a client would
 * (stdio), complete `initialize` + `notifications/initialized`, read
 * `tools/list` and, when the v2 surface is served, one read-only
 * `specrails_overview(app)`. Registration alone proves nothing.
 */

export interface VerifyResult {
  ok: boolean
  /** Advertised tools. */
  toolCount?: number
  /** ≈ o200k tokens the advertised tools cost a model (conservative estimate, `catalogTokens`). */
  approxTokens?: number
  serverVersion?: string
  /** The protocol version the server answered. */
  protocolVersion?: string
  /** The server sent instructions (the v2 surface). */
  instructions?: boolean
  /** One line from `specrails_overview(app)` when available. */
  overview?: string
  error?: string
  ms: number
}

/** The protocol version verify (and doctor) asks for. */
export const VERIFY_PROTOCOL = '2025-06-18'
const PROTOCOL = VERIFY_PROTOCOL

/**
 * What the catalog costs a model per turn: each tool in the function shape a
 * client sends (name, description, input schema; the shape the budget test
 * measures). Tool schemas average about 4.2 UTF-8 bytes per o200k token;
 * connect.test.ts keeps this within 15% of the real tokenizer (a dev
 * dependency the packaged app does not ship).
 */
export const SCHEMA_BYTES_PER_TOKEN = 4.2

export function catalogTokens(tools: ReadonlyArray<{ name: string; description?: string; inputSchema?: unknown }>): number {
  return Math.round(tools.reduce((sum, tool) => sum + Buffer.byteLength(JSON.stringify({ type: 'function', name: `mcp__specrails__${tool.name}`, description: tool.description, parameters: tool.inputSchema }), 'utf8'), 0) / SCHEMA_BYTES_PER_TOKEN)
}

export function verifyBridge(entry: BridgeEntry, options: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): Promise<VerifyResult> {
  const started = Date.now()
  const timeoutMs = options.timeoutMs ?? 20_000
  return new Promise((resolve) => {
    let settled = false
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(entry.command, entry.args, { env: { ...(options.env ?? process.env), ...entry.env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    } catch (err) {
      resolve({ ok: false, error: (err as Error).message, ms: Date.now() - started })
      return
    }
    const pending = new Map<number, (msg: Record<string, unknown>) => void>()
    let stderr = ''
    let buffer = ''
    const finish = (result: Omit<VerifyResult, 'ms'>) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { child.stdin?.end() } catch { /* closed */ }
      try { child.kill() } catch { /* exited */ }
      resolve({ ...result, ms: Date.now() - started })
    }
    const timer = setTimeout(() => finish({ ok: false, error: `No answer within ${Math.round(timeoutMs / 1000)} s.${stderr ? ` ${stderr.trim().slice(-300)}` : ''}` }), timeoutMs)
    child.on('error', (err) => finish({ ok: false, error: err.message }))
    child.on('exit', (code) => finish({ ok: false, error: (stderr.trim().slice(-300) || `The bridge exited (code ${code ?? 'null'}).`) }))
    child.stderr?.on('data', (chunk) => { stderr = (stderr + String(chunk)).slice(-4000) })
    child.stdout?.on('data', (chunk) => {
      buffer += String(chunk)
      let nl: number
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (!line) continue
        try {
          const msg = JSON.parse(line) as Record<string, unknown>
          const id = typeof msg.id === 'number' ? msg.id : null
          if (id !== null && pending.has(id)) { pending.get(id)!(msg); pending.delete(id) }
        } catch { /* a non-JSON line is not ours */ }
      }
    })
    let nextId = 1
    const request = (method: string, params: unknown) => new Promise<Record<string, unknown>>((done) => {
      const id = nextId++
      pending.set(id, done)
      child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
    const errorOf = (msg: Record<string, unknown>) => (msg.error as { message?: string } | undefined)?.message
    void (async () => {
      const init = await request('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'specrails-connect-verify', version: '1' } })
      if (errorOf(init)) return finish({ ok: false, error: errorOf(init) })
      const initResult = (init.result ?? {}) as { serverInfo?: { version?: string }; instructions?: string; protocolVersion?: string }
      child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
      const listed = await request('tools/list', {})
      if (errorOf(listed)) return finish({ ok: false, error: errorOf(listed) })
      const tools = ((listed.result as { tools?: Array<{ name: string; description?: string; inputSchema?: unknown }> } | undefined)?.tools) ?? []
      const base = {
        ok: true, toolCount: tools.length, approxTokens: catalogTokens(tools),
        ...(initResult.serverInfo?.version ? { serverVersion: initResult.serverInfo.version } : {}),
        ...(typeof initResult.protocolVersion === 'string' ? { protocolVersion: initResult.protocolVersion } : {}),
        instructions: typeof initResult.instructions === 'string' && initResult.instructions.length > 0,
      }
      if (!tools.some((tool) => tool.name === 'specrails_overview')) return finish(base)
      const called = await request('tools/call', { name: 'specrails_overview', arguments: { action: 'app' } })
      const content = (called.result as { structuredContent?: { summary?: unknown }; content?: Array<{ text?: string }> } | undefined)
      const summary = typeof content?.structuredContent?.summary === 'string' ? content.structuredContent.summary : content?.content?.[0]?.text?.split('\n')[0]
      finish({ ...base, ...(summary ? { overview: summary.slice(0, 240) } : {}) })
    })().catch((err: unknown) => finish({ ok: false, error: err instanceof Error ? err.message : String(err) }))
  })
}
