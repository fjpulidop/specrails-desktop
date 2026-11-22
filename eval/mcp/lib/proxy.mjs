#!/usr/bin/env node
// Stdio MCP proxy between an agent client and the isolated instance's bridge.
// It relays newline-delimited JSON-RPC both ways unchanged and appends every
// message, timestamped, to a JSONL log: the server-side record the metrics
// read (calls, tool names, errors, confirmations, response sizes, latency).
//
//   node proxy.mjs --log <file> --home <isolated home> --port <port> [--label <scenario>]
//
// The bridge reads the scoped MCP token from <home>/.specrails/mcp.token.
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const opt = name => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined }
const logFile = opt('--log')
const home = opt('--home')
const port = opt('--port')
if (!logFile || !home || !port) { console.error('usage: proxy.mjs --log <file> --home <dir> --port <port>'); process.exit(2) }
const label = opt('--label') ?? null

const record = (dir, raw) => {
  let m
  try { m = JSON.parse(raw) } catch { m = { unparsed: raw.slice(0, 2000) } }
  fs.appendFileSync(logFile, JSON.stringify({ t: Date.now() + (performance.now() % 1), d: dir, label, bytes: Buffer.byteLength(raw), m }) + '\n')
}

const bridge = spawn(path.join(desktop, 'node_modules', '.bin', 'tsx'), [path.join(desktop, 'mcp-bridge', 'src', 'index.ts')], {
  env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, SPECRAILS_REGISTRY_HOME: home, SPECRAILS_MCP_PORT: String(port) },
  stdio: ['pipe', 'pipe', 'inherit'],
})

/** Split a stream into lines, calling `fn` per complete line. */
function lines(stream, fn) {
  let buf = ''
  stream.setEncoding('utf8')
  stream.on('data', chunk => {
    buf += chunk
    let i
    while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line.trim()) fn(line) }
  })
}

lines(process.stdin, line => { record('in', line); bridge.stdin.write(line + '\n') })
lines(bridge.stdout, line => { record('out', line); process.stdout.write(line + '\n') })
process.stdin.on('end', () => bridge.stdin.end())
bridge.on('exit', code => process.exit(code ?? 0))
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { bridge.kill(signal); process.exit(0) })
