import { describe, expect, it, afterEach } from 'vitest'
import { EventEmitter } from 'events'
import type { ChildProcess } from 'child_process'
import {
  applyHeadroomEnvForBinary,
  headroomRoutedChildCount,
  providerForBinary,
  registerHeadroomRoutedChild,
  setHeadroomRoutingState,
  terminateHeadroomRoutedChildren,
  withHeadroomSpawnEnv,
} from './headroom-routing'

afterEach(() => {
  setHeadroomRoutingState({ port: 8787, activeProviders: {} })
})

describe('headroom routing', () => {
  it('detects supported provider binaries', () => {
    expect(providerForBinary('codex')).toBe('codex')
    expect(providerForBinary('codex.cmd')).toBe('codex')
    expect(providerForBinary('claude.exe')).toBe('claude')
    expect(providerForBinary('gemini')).toBeNull()
  })

  it('injects provider-specific base URLs only when enabled', () => {
    setHeadroomRoutingState({ port: 8788, activeProviders: { codex: true, claude: false } })

    const codex = applyHeadroomEnvForBinary('codex', { PATH: '/bin' })
    expect(codex.OPENAI_BASE_URL).toBe('http://127.0.0.1:8788/v1')
    expect(codex.ANTHROPIC_BASE_URL).toBeUndefined()
    expect(codex.HEADROOM_PORT).toBe('8788')

    const claude = applyHeadroomEnvForBinary('claude', { PATH: '/bin' })
    expect(claude.ANTHROPIC_BASE_URL).toBeUndefined()
  })

  it('wraps spawn options without mutating unrelated binaries', () => {
    setHeadroomRoutingState({ port: 8799, activeProviders: { claude: true } })

    const wrapped = withHeadroomSpawnEnv('claude', { cwd: '/tmp', env: { PATH: '/bin' } })
    expect(wrapped.cwd).toBe('/tmp')
    expect(wrapped.env?.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:8799')

    const other = withHeadroomSpawnEnv('gemini', { env: { PATH: '/bin' } })
    expect(other.env?.ANTHROPIC_BASE_URL).toBeUndefined()
    expect(other.env?.OPENAI_BASE_URL).toBeUndefined()
  })

  it('routes providers through the stable desktop relay without a bare-port bypass', () => {
    setHeadroomRoutingState({
      port: 4200,
      relayBaseUrl: 'http://127.0.0.1:4200/_specrails/headroom',
      activeProviders: { codex: true, claude: true },
    })

    const codex = applyHeadroomEnvForBinary('codex', {})
    const claude = applyHeadroomEnvForBinary('claude', {})

    expect(codex.OPENAI_BASE_URL).toBe('http://127.0.0.1:4200/_specrails/headroom/v1')
    expect(claude.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:4200/_specrails/headroom')
    expect(codex.HEADROOM_PORT).toBeUndefined()
    expect(claude.HEADROOM_PORT).toBeUndefined()

    const inherited = applyHeadroomEnvForBinary('codex', { HEADROOM_PORT: '8787' })
    expect(inherited.HEADROOM_PORT).toBeUndefined()
  })

  it('keeps routed-child leases until close and drains them before endpoint release', async () => {
    setHeadroomRoutingState({
      port: 4200,
      relayBaseUrl: 'http://127.0.0.1:4200/_specrails/headroom',
      activeProviders: { codex: true },
    })
    const child = new EventEmitter() as ChildProcess
    Object.assign(child, {
      pid: undefined,
      exitCode: null,
      signalCode: null,
      kill: (signal: NodeJS.Signals) => {
        Object.assign(child, { signalCode: signal })
        child.emit('close', null, signal)
        return true
      },
    })
    const env = applyHeadroomEnvForBinary('codex', {})

    registerHeadroomRoutedChild('codex', env, child)
    expect(headroomRoutedChildCount()).toBe(1)

    await terminateHeadroomRoutedChildren()
    expect(headroomRoutedChildCount()).toBe(0)
  })
})
