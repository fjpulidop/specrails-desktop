import type { SpawnOptions } from 'child_process'

export type HeadroomProvider = 'codex' | 'claude'

export interface HeadroomRoutingState {
  port: number
  activeProviders: Partial<Record<HeadroomProvider, boolean>>
}

const DEFAULT_PORT = 8787

let routingState: HeadroomRoutingState = {
  port: DEFAULT_PORT,
  activeProviders: {},
}

export function setHeadroomRoutingState(next: HeadroomRoutingState): void {
  routingState = {
    port: Number.isInteger(next.port) ? next.port : DEFAULT_PORT,
    activeProviders: { ...next.activeProviders },
  }
}

export function getHeadroomRoutingState(): HeadroomRoutingState {
  return {
    port: routingState.port,
    activeProviders: { ...routingState.activeProviders },
  }
}

export function providerForBinary(binary: string): HeadroomProvider | null {
  const name = binary.toLowerCase().replace(/\.cmd$|\.exe$/, '')
  if (name === 'codex') return 'codex'
  if (name === 'claude') return 'claude'
  return null
}

export function applyHeadroomEnvForBinary(binary: string, env: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  const provider = providerForBinary(binary)
  if (!provider || !routingState.activeProviders[provider]) return env ?? process.env

  const base = `http://127.0.0.1:${routingState.port}`
  const merged: NodeJS.ProcessEnv = { ...(env ?? process.env) }
  if (provider === 'codex') {
    merged.OPENAI_BASE_URL = `${base}/v1`
  } else if (provider === 'claude') {
    merged.ANTHROPIC_BASE_URL = base
  }
  merged.HEADROOM_PORT = String(routingState.port)
  return merged
}

export function withHeadroomSpawnEnv(binary: string, options: SpawnOptions = {}): SpawnOptions {
  return {
    ...options,
    env: applyHeadroomEnvForBinary(binary, options.env),
  }
}
