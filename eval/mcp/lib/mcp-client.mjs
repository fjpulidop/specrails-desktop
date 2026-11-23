// A programmatic MCP client over the logging proxy. The `replay` client uses
// it to run a scenario's reference solution (no model, $0); seeds use it to
// reach states only MCP drives (a Builder project); checkers read the HTTP API
// (S13 also starts the entry `mcp connect` registered, as a client would).
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

/**
 * Connect; returns `{ tools, call(name, args) → envelope, close() }`. With `onElicit(params) → { action, content? }`
 * the client declares form elicitation and answers the server's forms with it (the replay's simulated person).
 */
export async function connectMcp(proxy, { name = 'eval-replay', onElicit = null } = {}) {
  const [{ Client }, { StdioClientTransport }, types] = await Promise.all([sdk('client/index.js'), sdk('client/stdio.js'), onElicit ? sdk('types.js') : null])
  const client = new Client({ name, version: '1' }, onElicit ? { capabilities: { elicitation: { form: {} } } } : undefined)
  if (onElicit) client.setRequestHandler(types.ElicitRequestSchema, async request => onElicit(request.params ?? {}))
  await client.connect(new StdioClientTransport({ command: proxy.command, args: proxy.args, env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR ?? '', ...(proxy.env ?? {}) }, stderr: 'ignore' }))
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
