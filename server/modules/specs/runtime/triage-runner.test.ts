import { EventEmitter } from 'events'
import { PassThrough } from 'stream'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { spawned, policy } = vi.hoisted(() => ({
  spawned: [] as Array<{ child: FakeChild; args: unknown[] }>,
  policy: { value: 'none' as string | null },
}))

class FakeChild extends EventEmitter {
  pid = undefined
  stdout = new PassThrough()
  stderr = new PassThrough()
  kill = vi.fn()
  emitLines(...lines: unknown[]) { for (const l of lines) this.stdout.write(JSON.stringify(l) + '\n') }
  async finish(code: number) {
    this.stdout.end()
    await new Promise((r) => setTimeout(r, 5))
    this.emit('close', code)
  }
}

vi.mock('../../../util/cli-prompt', () => ({
  spawnAiCli: (...args: unknown[]) => { const child = new FakeChild(); spawned.push({ child, args }); return child },
}))
vi.mock('../../../transient-children', () => ({ trackTransientChild: vi.fn() }))
vi.mock('../../../workspace-resolution', () => ({ resolveProjectExecution: () => ({ relocated: false, cwd: '/repo', env: {} }) }))
vi.mock('../../../providers', () => ({
  getAdapter: () => ({ id: 'fake', binary: 'fake-cli', capabilities: { systemPromptArg: true }, buildArgs: vi.fn(() => ['--print']) }),
}))
vi.mock('../../../providers/runtime', () => ({
  pureOutputToolPolicy: () => policy.value,
  buildProviderEnv: () => ({}),
  parseStreamEvents: (_adapter: unknown, line: string) => [JSON.parse(line)],
}))
vi.mock('../../accounting/runtime/result-event', () => ({
  finaliseInvocationResult: () => ({ result: { model: 'fake-mini', total_cost_usd: 0.002, tokens_in: 100, tokens_out: 20, duration_ms: 40 }, estimated: false }),
}))

import { runTriageModel, TriageModelError } from './triage-runner'

const request = (signal?: AbortSignal) => ({
  projectId: 'p1', project: { slug: 'p1', path: '/repo' }, provider: 'fake', model: 'fake-mini',
  systemPrompt: 'sys', userPrompt: 'user', signal,
})

describe('runTriageModel', () => {
  beforeEach(() => { spawned.length = 0; policy.value = 'none' })

  it('returns the text and the provider-reported usage', async () => {
    const pending = runTriageModel(request())
    const { child } = spawned[0]
    child.emitLines({ kind: 'text-delta', text: '{"size":' }, { kind: 'text-delta', text: '"S"}' }, { kind: 'result', isError: false, payload: {} })
    await child.finish(0)
    await expect(pending).resolves.toMatchObject({ text: '{"size":"S"}', model: 'fake-mini', provider: 'fake', costUsd: 0.002, tokensIn: 100, durationMs: 40 })
  })

  it('carries partial usage when the CLI exits non-zero', async () => {
    const pending = runTriageModel(request())
    const { child } = spawned[0]
    child.emitLines({ kind: 'text-delta', text: 'partial' })
    child.stderr.write('boom')
    await child.finish(2)
    const err = await pending.catch((e) => e)
    expect(err).toBeInstanceOf(TriageModelError)
    expect(err.message).toMatch(/exit code=2/)
    expect(err.partial).toMatchObject({ costUsd: 0.002 })
  })

  it('rejects a provider error result and an empty answer', async () => {
    const first = runTriageModel(request())
    spawned[0].child.emitLines({ kind: 'result', isError: true, payload: { result: 'rate limited' } })
    await spawned[0].child.finish(0)
    await expect(first).rejects.toThrow('rate limited')

    const second = runTriageModel(request())
    await spawned[1].child.finish(0)
    await expect(second).rejects.toThrow('no text')
  })

  it('stops on abort', async () => {
    const controller = new AbortController()
    const pending = runTriageModel(request(controller.signal))
    controller.abort()
    await expect(pending).rejects.toThrow('aborted')
    expect(spawned[0].child.kill).toHaveBeenCalled()
  })

  it('refuses a provider without a pure-output tool policy before spawning', async () => {
    policy.value = null
    await expect(runTriageModel(request())).rejects.toThrow('provider_tool_policy_unsupported:fake:pure-output')
    expect(spawned).toHaveLength(0)
  })
})
