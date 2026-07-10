import type { ChildProcess, SpawnOptions } from 'child_process'
import { treeKillSafe } from './util/win-spawn'

export type HeadroomProvider = 'codex' | 'claude'

export interface HeadroomRoutingState {
  port: number
  /**
   * Stable, Specrails-owned client endpoint. In production this points at the
   * desktop HTTP server relay, never at Headroom's reusable backend port.
   */
  relayBaseUrl?: string
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
    relayBaseUrl: next.relayBaseUrl,
    activeProviders: { ...next.activeProviders },
  }
}

export function getHeadroomRoutingState(): HeadroomRoutingState {
  return {
    port: routingState.port,
    ...(routingState.relayBaseUrl ? { relayBaseUrl: routingState.relayBaseUrl } : {}),
    activeProviders: { ...routingState.activeProviders },
  }
}

export function providerForBinary(binary: string): HeadroomProvider | null {
  const name = binary.toLowerCase().replace(/\.cmd$|\.exe$/, '')
  if (name === 'codex') return 'codex'
  if (name === 'claude') return 'claude'
  return null
}

/** Return the active stable relay base only when this exact spawn inherited it. */
export function headroomRelayBaseUrlForBinary(
  binary: string,
  env: NodeJS.ProcessEnv | undefined,
): string | null {
  const provider = providerForBinary(binary)
  const base = routingState.relayBaseUrl
  if (!provider || !base || !routingState.activeProviders[provider]) return null
  const inherited = provider === 'codex'
    ? env?.OPENAI_BASE_URL === `${base}/v1`
    : env?.ANTHROPIC_BASE_URL === base
  return inherited ? base : null
}

export function applyHeadroomEnvForBinary(binary: string, env: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  const provider = providerForBinary(binary)
  if (!provider || !routingState.activeProviders[provider]) return env ?? process.env

  const base = routingState.relayBaseUrl ?? `http://127.0.0.1:${routingState.port}`
  const merged: NodeJS.ProcessEnv = { ...(env ?? process.env) }
  if (provider === 'codex') {
    merged.OPENAI_BASE_URL = `${base}/v1`
  } else if (provider === 'claude') {
    merged.ANTHROPIC_BASE_URL = base
  }
  if (routingState.relayBaseUrl) {
    // BASE_URL (including its runtime token path) is the sole authority in
    // relay mode. A bare port cannot encode that path and would let integrations
    // reconstruct either the desktop root or the reusable backend endpoint.
    delete merged.HEADROOM_PORT
  } else {
    merged.HEADROOM_PORT = String(routingState.port)
  }
  return merged
}

const routedChildren = new Set<ChildProcess>()

/**
 * Record a provider child that inherited the stable Headroom relay URL. The
 * desktop server must not release that endpoint during graceful shutdown while
 * one of these children can still retry a request against it.
 */
export function registerHeadroomRoutedChild(
  binary: string,
  env: NodeJS.ProcessEnv | undefined,
  child: ChildProcess,
): void {
  const provider = providerForBinary(binary)
  if (!provider || !routingState.activeProviders[provider]) return
  const relayInherited = headroomRelayBaseUrlForBinary(binary, env) !== null
  const directBase = `http://127.0.0.1:${routingState.port}`
  const directInherited = !routingState.relayBaseUrl && (
    provider === 'codex'
      ? env?.OPENAI_BASE_URL === `${directBase}/v1`
      : env?.ANTHROPIC_BASE_URL === directBase
  )
  if ((!relayInherited && !directInherited) || typeof child.once !== 'function') return

  routedChildren.add(child)
  child.once('close', () => {
    routedChildren.delete(child)
  })
}

function terminateRoutedChild(child: ChildProcess): Promise<void> {
  if (child.exitCode != null || child.signalCode != null) {
    // `exit` precedes `close`; inherited stdio can keep the latter pending. Keep
    // the stable endpoint leased until close is observed (bounded for a stuck
    // descriptor), rather than releasing it merely because the root exited.
    return new Promise((resolve) => {
      const deadline = setTimeout(resolve, 2_000)
      deadline.unref?.()
      child.once('close', () => {
        clearTimeout(deadline)
        resolve()
      })
    })
  }
  const pid = child.pid
  return new Promise((resolve) => {
    let settled = false
    let escalation: NodeJS.Timeout | null = null
    let deadline: NodeJS.Timeout | null = null
    const finish = () => {
      if (settled) return
      settled = true
      if (escalation) clearTimeout(escalation)
      if (deadline) clearTimeout(deadline)
      child.removeListener('close', finish)
      resolve()
    }
    child.once('close', finish)

    const signal = (value: NodeJS.Signals) => {
      try {
        if (pid) treeKillSafe(pid, value, () => { /* close is authoritative */ })
        else child.kill(value)
      } catch {
        // Escalation/deadline below keep shutdown bounded.
      }
    }
    signal('SIGTERM')
    if (settled) return
    escalation = setTimeout(() => signal('SIGKILL'), 1_500)
    escalation.unref?.()
    deadline = setTimeout(finish, 2_000)
    deadline.unref?.()
  })
}

/**
 * Stop and drain every provider child that inherited the relay. Iterate over
 * newly observed children too, rather than relying on a one-time snapshot.
 */
export async function terminateHeadroomRoutedChildren(): Promise<void> {
  const attempted = new Set<ChildProcess>()
  while (true) {
    const pending = [...routedChildren].filter((child) => !attempted.has(child))
    if (pending.length === 0) return
    for (const child of pending) attempted.add(child)
    await Promise.all(pending.map(terminateRoutedChild))
  }
}

/** @internal Test-only visibility for lifecycle assertions. */
export function headroomRoutedChildCount(): number {
  return routedChildren.size
}

export function withHeadroomSpawnEnv(binary: string, options: SpawnOptions = {}): SpawnOptions {
  return {
    ...options,
    env: applyHeadroomEnvForBinary(binary, options.env),
  }
}
