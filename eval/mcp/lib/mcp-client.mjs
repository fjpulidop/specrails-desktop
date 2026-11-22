// A programmatic MCP client over the logging proxy. The `replay` client uses
// it to run a scenario's reference solution (no model, $0), and seeds and
// checkers never use it: they read the app's HTTP API.
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { DESKTOP_DIR, EVAL_DIR } from './instance.mjs'

const require = createRequire(path.join(DESKTOP_DIR, 'package.json'))
const sdk = p => import(pathToFileURL(require.resolve(`@modelcontextprotocol/sdk/${p}`)).href)

/** The proxy command line a client config registers (pure). */
export function proxyCommand({ logFile, home, port, label }) {
  return { command: process.execPath, args: [path.join(EVAL_DIR, 'lib', 'proxy.mjs'), '--log', logFile, '--home', home, '--port', String(port), ...(label ? ['--label', label] : [])] }
}

/** Connect; returns `{ tools, call(name, args) → envelope, close() }`. */
export async function connectMcp(proxy, { name = 'eval-replay' } = {}) {
  const [{ Client }, { StdioClientTransport }] = await Promise.all([sdk('client/index.js'), sdk('client/stdio.js')])
  const client = new Client({ name, version: '1' })
  await client.connect(new StdioClientTransport({ command: proxy.command, args: proxy.args, env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR ?? '' }, stderr: 'ignore' }))
  const listed = await client.listTools()
  return {
    tools: listed.tools,
    instructions: client.getInstructions?.() ?? null,
    async call(tool, args) {
      const r = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: 120_000 })
      const envelope = r.structuredContent ?? parseText(r.content?.[0]?.text)
      return { envelope, isError: Boolean(r.isError) }
    },
    close: () => client.close(),
  }
}

function parseText(text) {
  if (typeof text !== 'string') return null
  const brace = text.indexOf('{')
  try { return JSON.parse(brace > 0 ? text.slice(brace) : text) } catch { return { text } }
}
