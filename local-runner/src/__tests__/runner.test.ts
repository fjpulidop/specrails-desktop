import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { FakeEndpoint, makeIo, run, byType, resultOf, assistantBlocks, assistantText, type Harness } from './fake-endpoint'
import { sessionFileExists } from '../runner'

let endpoint: FakeEndpoint
let cwd: string
let home: string
let env: Record<string, string | undefined>
let h: Harness

const FIXTURE_MCP = path.join(__dirname, 'fixtures', 'mcp-server.mjs')

function base(extra: string[] = []): string[] {
  return ['--base-url', endpoint.baseUrl, '--model', 'qwen-test', '--output-format', 'stream-json', ...extra]
}

beforeEach(async () => {
  endpoint = await new FakeEndpoint().start()
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'local-runner-cwd-'))
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'local-runner-home-'))
  fs.writeFileSync(path.join(cwd, 'hello.txt'), 'line one\nline two\nline three\n')
  env = { PATH: process.env.PATH, SPECRAILS_LOCAL_RUNNER_HOME: home }
  h = makeIo(cwd, env)
})

afterEach(async () => {
  await endpoint.stop()
  fs.rmSync(cwd, { recursive: true, force: true })
  fs.rmSync(home, { recursive: true, force: true })
})

describe('argv', () => {
  it('unknown flag exits 2 with a one-line diagnostic and no HTTP request', async () => {
    const code = await run(base(['-p', 'hi', '--bogus']), h)
    expect(code).toBe(2)
    expect(h.stderr()).toBe('unknown flag: --bogus\n')
    expect(endpoint.requests).toHaveLength(0)
    expect(h.frames()).toHaveLength(0)
  })

  it('rejects a missing prompt / bad max-turns / bad output-format', async () => {
    expect(await run(base([]), h)).toBe(2)
    expect(h.stderr()).toContain('missing prompt')
    const h2 = makeIo(cwd, env)
    expect(await run(base(['-p', 'x', '--max-turns', 'zero']), h2)).toBe(2)
    const h3 = makeIo(cwd, env)
    expect(await run(['-p', 'x', '--output-format', 'json'], h3)).toBe(2)
    const h4 = makeIo(cwd, env)
    expect(await run(['-p'], h4)).toBe(2)
    expect(h4.stderr()).toContain('missing value for -p')
  })
})

describe('simple turn', () => {
  it('streams text deltas, carries usage and a success result without total_cost_usd', async () => {
    endpoint.reply({ text: 'Hello there friend', usage: { prompt_tokens: 12, completion_tokens: 3 } })
    env.MY_KEY = 'secret-token'
    const code = await run(base(['-p', 'hi', '--api-key-env', 'MY_KEY', '--reasoning-effort', 'low', '--append-system-prompt', 'Be terse']), h)
    expect(code).toBe(0)
    const frames = h.frames()
    expect(frames[0]).toEqual({ type: 'system', subtype: 'init', session_id: expect.any(String), model: 'qwen-test' })
    expect(assistantText(frames)).toBe('Hello there friend')
    const textFrames = byType(frames, 'assistant').filter((f) => (f.message as { content: unknown[] }).content.length > 0)
    expect(textFrames.length).toBeGreaterThan(1)
    const ids = new Set(byType(frames, 'assistant').map((f) => (f.message as { id: string }).id))
    expect(ids.size).toBe(1)
    const usageFrame = byType(frames, 'assistant').at(-1) as { message: { usage: unknown } }
    expect(usageFrame.message.usage).toEqual({ input_tokens: 12, output_tokens: 3 })
    const result = resultOf(frames)
    expect(result).toMatchObject({ subtype: 'success', is_error: false, num_turns: 1, usage: { input_tokens: 12, output_tokens: 3 }, result: 'Hello there friend' })
    expect(result).not.toHaveProperty('total_cost_usd')
    expect(typeof result.duration_ms).toBe('number')
    const req = endpoint.requests[0]
    expect(req.headers.authorization).toBe('Bearer secret-token')
    expect(req.body).toMatchObject({ model: 'qwen-test', stream: true, reasoning_effort: 'low' })
    expect((req.body.messages as Array<{ role: string; content: string }>)[0]).toEqual({ role: 'system', content: 'Be terse' })
    expect(sessionFileExists(env, result.session_id as string)).toBe(true)
    const mode = fs.statSync(path.join(home, 'sessions', `${result.session_id}.json`)).mode & 0o777
    if (process.platform !== 'win32') expect(mode).toBe(0o600)
  })

  it('omits Authorization when the env var is unset/empty and omits reasoning_effort when not given', async () => {
    endpoint.reply({ text: 'ok' })
    await run(base(['-p', 'hi', '--api-key-env', 'NOPE']), h)
    expect(endpoint.requests[0].headers.authorization).toBeUndefined()
    expect(endpoint.requests[0].body).not.toHaveProperty('reasoning_effort')
    expect(endpoint.requests[0].body.messages).toEqual([{ role: 'user', content: 'hi' }])
  })
})

describe('tool loop', () => {
  it('two-step tool turn: Read then final text, num_turns 2', async () => {
    endpoint
      .reply({ toolCalls: [{ id: 'call_a', name: 'Read', arguments: JSON.stringify({ file_path: 'hello.txt', limit: 2 }) }], usage: { prompt_tokens: 5, completion_tokens: 2 }, splitArgs: true })
      .reply({ text: 'Done reading', usage: { prompt_tokens: 7, completion_tokens: 3 } })
    const code = await run(base(['-p', 'read it']), h)
    expect(code).toBe(0)
    const frames = h.frames()
    const toolUse = assistantBlocks(frames).find((b) => b.type === 'tool_use') as Record<string, unknown>
    expect(toolUse).toEqual({ type: 'tool_use', id: 'call_a', name: 'Read', input: { file_path: 'hello.txt', limit: 2 } })
    const toolResult = byType(frames, 'user')[0].message as { content: Array<Record<string, unknown>> }
    expect(toolResult.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'call_a', is_error: false })
    expect(toolResult.content[0].content).toContain('line one')
    expect(toolResult.content[0].content).not.toContain('line three')
    expect(resultOf(frames)).toMatchObject({ is_error: false, num_turns: 2, usage: { input_tokens: 12, output_tokens: 5 }, result: 'Done reading' })
    const second = endpoint.requests[1].body.messages as Array<Record<string, unknown>>
    expect(second.at(-2)).toMatchObject({ role: 'assistant', tool_calls: [{ id: 'call_a' }] })
    // Never `null`: llama.cpp-style servers reject it ("invalid message content type: <nil>").
    expect((second.at(-2) as { content: unknown }).content).toBe('')
    expect(second.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'call_a' })
    const toolNames = (endpoint.requests[0].body.tools as Array<{ function: { name: string } }>).map((t) => t.function.name)
    expect(toolNames).toEqual(['Read', 'Grep', 'Glob', 'Bash', 'Write', 'Edit'])
  })

  it('nudges ONCE when the model closes a tool turn with an empty final message', async () => {
    endpoint
      .reply({ toolCalls: [{ id: 'c1', name: 'Read', arguments: JSON.stringify({ file_path: 'hello.txt' }) }] })
      .reply({ text: '' })
      .reply({ text: 'here is the answer' })
    const code = await run(base(['-p', 'go']), h)
    expect(code).toBe(0)
    expect(resultOf(h.frames())).toMatchObject({ is_error: false, num_turns: 3, result: 'here is the answer' })
    const third = endpoint.requests[2].body.messages as Array<Record<string, unknown>>
    expect(third.at(-1)).toMatchObject({ role: 'user' })
    expect(String(third.at(-1)!.content)).toContain('Reply to the user now')
  })

  it('a second empty reply after the nudge settles as an empty (non-error) result', async () => {
    endpoint
      .reply({ toolCalls: [{ id: 'c1', name: 'Read', arguments: JSON.stringify({ file_path: 'hello.txt' }) }] })
      .reply({ text: '' })
      .reply({ text: '' })
    const code = await run(base(['-p', 'go']), h)
    expect(code).toBe(0)
    expect(resultOf(h.frames())).toMatchObject({ is_error: false, num_turns: 3, result: '' })
    expect(endpoint.requests).toHaveLength(3)
  })

  it('malformed tool arguments become an error tool_result and the loop continues', async () => {
    endpoint
      .reply({ toolCalls: [{ id: 'c1', name: 'Read', arguments: '{"path": ' }, { id: 'c2', name: 'Read', arguments: '[1,2]' }] })
      .reply({ text: 'recovered' })
    const code = await run(base(['-p', 'go']), h)
    expect(code).toBe(0)
    const results = byType(h.frames(), 'user').map((f) => (f.message as { content: Array<Record<string, unknown>> }).content[0])
    expect(results[0]).toMatchObject({ tool_use_id: 'c1', is_error: true })
    expect(results[0].content).toContain('invalid tool arguments JSON')
    expect(results[1]).toMatchObject({ tool_use_id: 'c2', is_error: true })
    expect(results[1].content).toContain('must be a JSON object')
    expect(resultOf(h.frames())).toMatchObject({ is_error: false, num_turns: 2, result: 'recovered' })
  })

  it('unknown tool and Bash tool', async () => {
    endpoint
      .reply({ toolCalls: [{ id: 'u', name: 'Nope', arguments: '{}' }, { id: 'b', name: 'Bash', arguments: JSON.stringify({ command: 'echo hi && exit 3' }) }] })
      .reply({ text: 'end' })
    await run(base(['-p', 'go']), h)
    const results = byType(h.frames(), 'user').map((f) => (f.message as { content: Array<Record<string, unknown>> }).content[0])
    expect(results[0]).toMatchObject({ is_error: true })
    expect(results[0].content).toContain('Unknown tool: Nope')
    expect(results[1]).toMatchObject({ is_error: true })
    expect(results[1].content).toContain('hi')
    expect(results[1].content).toContain('exit code 3')
  })

  it('--max-turns stops with reason max_turns', async () => {
    endpoint
      .reply({ toolCalls: [{ name: 'Glob', arguments: '{"pattern":"*.txt"}' }] })
      .reply({ toolCalls: [{ name: 'Glob', arguments: '{"pattern":"*.txt"}' }] })
    const code = await run(base(['-p', 'loop', '--max-turns', '2']), h)
    expect(code).toBe(1)
    expect(resultOf(h.frames())).toMatchObject({ is_error: true, subtype: 'error', num_turns: 2, reason: 'max_turns' })
    expect(endpoint.requests).toHaveLength(2)
  })
})

describe('policies', () => {
  it('--tools __none__ sends no tools', async () => {
    endpoint.reply({ text: 'x' })
    await run(base(['-p', 'go', '--tools', '__none__']), h)
    expect(endpoint.requests[0].body).not.toHaveProperty('tools')
  })

  it('--tools Read,Grep,Glob restricts and answers Write with an unknown-tool error', async () => {
    endpoint.reply({ toolCalls: [{ id: 'w', name: 'Write', arguments: JSON.stringify({ file_path: 'x.txt', content: 'nope' }) }] }).reply({ text: 'ok' })
    await run(base(['-p', 'go', '--tools', 'Read,Grep,Glob']), h)
    const names = (endpoint.requests[0].body.tools as Array<{ function: { name: string } }>).map((t) => t.function.name)
    expect(names).toEqual(['Read', 'Grep', 'Glob'])
    const tr = (byType(h.frames(), 'user')[0].message as { content: Array<Record<string, unknown>> }).content[0]
    expect(tr).toMatchObject({ is_error: true })
    expect(tr.content).toContain('Unknown tool: Write')
    expect(fs.existsSync(path.join(cwd, 'x.txt'))).toBe(false)
  })

  it('--disallowedTools removes from the default set; allow ∩ disallow is respected', async () => {
    endpoint.reply({ text: 'x' }).reply({ text: 'y' }).reply({ text: 'z' })
    await run(base(['-p', 'go', '--disallowedTools', 'Write,Edit']), h)
    const names = (endpoint.requests[0].body.tools as Array<{ function: { name: string } }>).map((t) => t.function.name)
    expect(names).toEqual(['Read', 'Grep', 'Glob', 'Bash'])
    const h2 = makeIo(cwd, env)
    await run(base(['-p', 'go', '--tools', 'Read,Bash', '--disallowedTools', 'Bash']), h2)
    expect((endpoint.requests[1].body.tools as Array<{ function: { name: string } }>).map((t) => t.function.name)).toEqual(['Read'])
    const h3 = makeIo(cwd, env)
    await run(base(['-p', 'go', '--tools', 'Bash', '--disallowedTools', 'Bash']), h3)
    expect(endpoint.requests[2].body).not.toHaveProperty('tools')
  })
})

describe('path confinement', () => {
  it('rejects ../ escapes and honours --add-dir', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'local-runner-outside-'))
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'top secret')
    const escape = path.relative(cwd, path.join(outside, 'secret.txt'))
    endpoint
      .reply({ toolCalls: [{ id: 'e', name: 'Read', arguments: JSON.stringify({ file_path: escape }) }] })
      .reply({ text: 'done' })
      .reply({ toolCalls: [{ id: 'ok', name: 'Read', arguments: JSON.stringify({ file_path: path.join(outside, 'secret.txt') }) }] })
      .reply({ text: 'done' })
    await run(base(['-p', 'go']), h)
    const tr = (byType(h.frames(), 'user')[0].message as { content: Array<Record<string, unknown>> }).content[0]
    expect(tr).toMatchObject({ is_error: true })
    expect(tr.content).toContain('path confinement')
    expect(tr.content).not.toContain('top secret')

    const h2 = makeIo(cwd, env)
    await run(base(['-p', 'go', '--add-dir', outside]), h2)
    const tr2 = (byType(h2.frames(), 'user')[0].message as { content: Array<Record<string, unknown>> }).content[0]
    expect(tr2).toMatchObject({ is_error: false })
    expect(tr2.content).toContain('top secret')
    fs.rmSync(outside, { recursive: true, force: true })
  })
})

describe('sessions', () => {
  it('--resume continues the history and a missing session emits the exact diagnostic', async () => {
    endpoint.reply({ text: 'first' }).reply({ text: 'second' })
    await run(base(['-p', 'one']), h)
    const sid = resultOf(h.frames()).session_id as string
    const h2 = makeIo(cwd, env)
    const code = await run(base(['-p', 'two', '--resume', sid]), h2)
    expect(code).toBe(0)
    expect(resultOf(h2.frames()).session_id).toBe(sid)
    expect(endpoint.requests[1].body.messages).toEqual([
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'first' },
      { role: 'user', content: 'two' },
    ])

    const h3 = makeIo(cwd, env)
    const missing = await run(base(['-p', 'x', '--resume', 'does-not-exist']), h3)
    expect(missing).toBe(1)
    expect(h3.frames()).toEqual([
      expect.objectContaining({ type: 'result', is_error: true, session_id: 'does-not-exist', result: 'No conversation found with session ID: does-not-exist' }),
    ])
    expect(endpoint.requests).toHaveLength(2)
  })

  it('rejects unsafe / corrupt session ids without crashing', async () => {
    fs.mkdirSync(path.join(home, 'sessions'), { recursive: true })
    fs.writeFileSync(path.join(home, 'sessions', 'corrupt.json'), '{not json')
    fs.writeFileSync(path.join(home, 'sessions', 'nomsgs.json'), '{"id":"nomsgs"}')
    for (const id of ['../etc/passwd', 'corrupt', 'nomsgs']) {
      const hx = makeIo(cwd, env)
      expect(await run(base(['-p', 'x', '--resume', id]), hx)).toBe(1)
      expect(resultOf(hx.frames()).result).toContain('No conversation found')
    }
  })
})

describe('persistent stdin', () => {
  it('runs one turn per user line, same session id, exits 0 at stdin end', async () => {
    endpoint.reply({ text: 'r1' }).reply({ text: 'r2' })
    const p = run(base(['--input-format', 'stream-json']), h)
    h.stdin.write(JSON.stringify({ type: 'user', message: { content: 'first' } }) + '\n')
    h.stdin.write('not json\n')
    h.stdin.write(JSON.stringify({ type: 'system' }) + '\n')
    h.stdin.write(JSON.stringify({ type: 'user', message: { content: [{ type: 'image' }] } }) + '\n')
    h.stdin.write(JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'second' }] } }) + '\n')
    h.stdin.end()
    const code = await p
    expect(code).toBe(0)
    const results = byType(h.frames(), 'result')
    expect(results).toHaveLength(2)
    expect(results[0].result).toBe('r1')
    expect(results[1].result).toBe('r2')
    expect(results[0].session_id).toBe(results[1].session_id)
    expect(byType(h.frames(), 'system')).toHaveLength(2)
    expect(h.stderr()).toContain('non-JSON stdin line')
    expect(h.stderr()).toContain('without text content')
    // history accumulated across turns
    expect((endpoint.requests[1].body.messages as unknown[]).length).toBe(3)
  })

  it('stays alive after an endpoint error and runs -p as the first turn', async () => {
    endpoint.reply({ text: 'p' }).reply({ status: 500, body: 'boom' }).reply({ text: 'back' })
    const p = run(base(['-p', 'initial', '--input-format', 'stream-json']), h)
    h.stdin.write(JSON.stringify({ type: 'user', message: { content: 'fails' } }) + '\n')
    h.stdin.write(JSON.stringify({ type: 'user', message: { content: 'works' } }) + '\n')
    h.stdin.end()
    expect(await p).toBe(0)
    const results = byType(h.frames(), 'result')
    expect(results.map((r) => r.is_error)).toEqual([false, true, false])
    expect(results[1].result).toContain('HTTP 500')
  })
})

describe('endpoint errors', () => {
  it('endpoint down → result error naming the connection failure, exit 1', async () => {
    const dead = endpoint.baseUrl
    await endpoint.stop()
    endpoint = await new FakeEndpoint().start() // afterEach needs a live one
    const code = await run(['--base-url', dead, '-p', 'hi'], h)
    expect(code).toBe(1)
    const r = resultOf(h.frames())
    expect(r).toMatchObject({ is_error: true, subtype: 'error', num_turns: 0 })
    expect(r.result).toMatch(/connection to .* failed: ECONNREFUSED/)
  })

  it('429 body is passed through verbatim; non-SSE body is an error', async () => {
    endpoint.reply({ status: 429, body: '{"error":{"message":"rate limit exceeded, retry after 30s"}}' })
    expect(await run(base(['-p', 'hi']), h)).toBe(1)
    expect(resultOf(h.frames()).result).toContain('HTTP 429')
    expect(resultOf(h.frames()).result).toContain('rate limit exceeded, retry after 30s')

    endpoint.reply({ status: 200, body: '{"choices":[]}', contentType: 'application/json' })
    const h2 = makeIo(cwd, env)
    expect(await run(base(['-p', 'hi']), h2)).toBe(1)
    expect(resultOf(h2.frames()).result).toContain('non-SSE response')
  })

  it('context-length error evicts the oldest tool exchange and retries once; second failure surfaces verbatim', async () => {
    endpoint
      .reply({ toolCalls: [{ id: 't1', name: 'Glob', arguments: '{"pattern":"*.txt"}' }] })
      .reply({ status: 400, body: 'This model\'s maximum context length is 4096 tokens' })
      .reply({ text: 'after eviction' })
    expect(await run(base(['-p', 'big']), h)).toBe(0)
    expect(h.stderr()).toContain('evicted the oldest tool exchange')
    const retried = endpoint.requests[2].body.messages as Array<{ role: string }>
    expect(retried.map((m) => m.role)).toEqual(['user'])
    expect(resultOf(h.frames())).toMatchObject({ is_error: false, result: 'after eviction' })

    // Nothing left to evict → verbatim error
    endpoint.reply({ status: 400, body: 'context window too long' })
    const h2 = makeIo(cwd, env)
    expect(await run(base(['-p', 'again']), h2)).toBe(1)
    expect(resultOf(h2.frames()).result).toContain('context window too long')

    // Evict once, then a second context error is final
    endpoint
      .reply({ toolCalls: [{ id: 't1', name: 'Glob', arguments: '{"pattern":"*.txt"}' }] })
      .reply({ status: 400, body: 'too long' })
      .reply({ status: 400, body: 'still too long' })
    const h3 = makeIo(cwd, env)
    expect(await run(base(['-p', 'x']), h3)).toBe(1)
    expect(resultOf(h3.frames()).result).toContain('still too long')
  })

  it('tolerates malformed SSE chunks', async () => {
    endpoint.reply({ rawSse: 'data: not-json\n\n: comment\ndata: {"choices":[]}\n\ndata: {"choices":[{"delta":{"content":"ok"}}]}\ndata: [DONE]' })
    expect(await run(base(['-p', 'hi']), h)).toBe(0)
    expect(resultOf(h.frames()).result).toBe('ok')
  })
})

describe('slash commands', () => {
  it('expands <cwd>/.claude/commands/<ns>/<name>.md into the system tail with $ARGUMENTS', async () => {
    fs.mkdirSync(path.join(cwd, '.claude', 'commands', 'specrails'), { recursive: true })
    fs.writeFileSync(path.join(cwd, '.claude', 'commands', 'specrails', 'implement.md'), '---\ndescription: x\n---\nImplement ticket $ARGUMENTS now.')
    endpoint.reply({ text: 'ok' })
    await run(base(['-p', '/specrails:implement 42', '--system-prompt', 'BASE']), h)
    const msgs = endpoint.requests[0].body.messages as Array<{ role: string; content: string }>
    expect(msgs[0]).toEqual({ role: 'system', content: 'BASE\n\nImplement ticket 42 now.' })
    expect(msgs[1]).toEqual({ role: 'user', content: '/specrails:implement 42' })
  })

  it('unknown command → assistant text + result error, no network', async () => {
    const code = await run(base(['-p', '/specrails:nope 1']), h)
    expect(code).toBe(1)
    expect(assistantText(h.frames())).toBe('Unknown command: /specrails:nope')
    expect(resultOf(h.frames())).toMatchObject({ is_error: true, num_turns: 0, result: 'Unknown command: /specrails:nope' })
    expect(endpoint.requests).toHaveLength(0)
  })
})

describe('MCP', () => {
  it('exposes fixture tools as mcp__<server>__<tool>, routes calls, skips a failing server', async () => {
    const cfg = path.join(cwd, 'mcp.json')
    fs.writeFileSync(
      cfg,
      JSON.stringify({
        mcpServers: {
          specrails: { command: process.execPath, args: [FIXTURE_MCP] },
          broken: { command: path.join(cwd, 'definitely-missing-binary'), args: [] },
          remote: { type: 'http', url: 'http://x' },
        },
      }),
    )
    endpoint
      .reply({
        toolCalls: [
          { id: 'm1', name: 'mcp__specrails__specrails_specs', arguments: '{"action":"list"}' },
          { id: 'm2', name: 'mcp__specrails__boom', arguments: '{}' },
        ],
      })
      .reply({ text: 'listed' })
    const code = await run(base(['-p', 'list specs', '--mcp-config', cfg, '--tools', '__none__']), h)
    expect(code).toBe(0)
    const names = (endpoint.requests[0].body.tools as Array<{ function: { name: string } }>).map((t) => t.function.name)
    expect(names).toEqual(['mcp__specrails__specrails_specs', 'mcp__specrails__boom'])
    const results = byType(h.frames(), 'user').map((f) => (f.message as { content: Array<Record<string, unknown>> }).content[0])
    expect(results[0]).toMatchObject({ tool_use_id: 'm1', is_error: false, content: 'specs:list' })
    expect(results[1]).toMatchObject({ tool_use_id: 'm2', is_error: true, content: 'kaboom' })
    expect(h.stderr()).toContain('mcp server "broken" failed to start')
    expect(h.stderr()).toContain('mcp server "remote": unsupported spec')
  }, 30000)

  it('an unreadable --mcp-config is logged and the turn continues', async () => {
    endpoint.reply({ text: 'ok' })
    expect(await run(base(['-p', 'x', '--mcp-config', path.join(cwd, 'missing.json')]), h)).toBe(0)
    expect(h.stderr()).toContain('cannot load --mcp-config')
  })
})
