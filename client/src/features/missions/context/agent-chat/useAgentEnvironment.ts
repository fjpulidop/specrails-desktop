/**
 * What this machine offers the agent: whether the Specrails MCP server is
 * enabled (and enabling it), and which AI providers are usable.
 */
import { useCallback, useRef, useState } from 'react'
import i18n from '../../../../lib/i18n'
import { notifyError } from '../../../../lib/notify-error'
import { getMcpStatus, enableMcp, getAvailableProviders } from '../../lib/agent-api'

export function useAgentEnvironment() {
  const [mcpEnabled, setMcpEnabled] = useState(true)
  const [enablingMcp, setEnablingMcp] = useState(false)
  const [providersReady, setProvidersReady] = useState<boolean | null>(null)
  // The machine's usable provider ids (CLIs on PATH + reachable local engines).
  // A fresh mission starts on `preferredProvider(usable)`, never on a hardcoded
  // claude — a local-only machine would otherwise compose on an uninstalled CLI.
  const [usableProviders, setUsableProviders] = useState<string[]>([])
  const usableProvidersRef = useRef<string[]>([])
  usableProvidersRef.current = usableProviders

  const refreshMcp = useCallback(async () => {
    try {
      const s = await getMcpStatus()
      setMcpEnabled(s.enabled)
    } catch {
      setMcpEnabled(false)
    }
  }, [])

  const refreshProviders = useCallback(async () => {
    try {
      const { any, installed } = await getAvailableProviders()
      setProvidersReady(any)
      setUsableProviders(Array.isArray(installed) ? installed : [])
    } catch {
      // On a probe failure, don't hard-block the agent — leave it usable.
      setProvidersReady(true)
    }
  }, [])

  const enableMcpServer = useCallback(async () => {
    setEnablingMcp(true)
    try {
      await enableMcp()
      await refreshMcp()
    } catch (err) {
      notifyError(i18n.t('agent:errors.mcpEnableFailed'), { detail: err instanceof Error ? err.message : undefined })
    } finally {
      setEnablingMcp(false)
    }
  }, [refreshMcp])

  return { mcpEnabled, enablingMcp, providersReady, usableProviders, usableProvidersRef, refreshMcp, refreshProviders, enableMcpServer }
}
