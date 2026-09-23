import { useEffect, useState } from 'react'
import { useDesktop } from '../../../hooks/useDesktop'
import { FEATURE_JIRA } from '../../../lib/feature-flags'
import { jiraApi } from '../lib/jira-api'

export interface JiraConnectionInfo {
  /** True only when a connection exists AND sync is enabled. */
  connected: boolean
  jiraProjectKey: string | null
  /** Configured "move-to on discard" status name (null = not configured). */
  discardStatus: string | null
  loading: boolean
}

/**
 * Lightweight per-project Jira connection probe for Add Spec surfaces. Tells the
 * UI whether new specs will be created in Jira (so it can show the "Se creará en
 * Jira · PROJ" indicator). Re-runs on project switch. Safe when the feature is
 * off (returns { connected: false }).
 */
export function useJiraConnection(): JiraConnectionInfo {
  const { activeProjectId } = useDesktop()
  const [info, setInfo] = useState<{ connected: boolean; key: string | null; discardStatus: string | null }>({
    connected: false,
    key: null,
    discardStatus: null,
  })
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!FEATURE_JIRA || !activeProjectId) {
      setInfo({ connected: false, key: null, discardStatus: null })
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    jiraApi
      .getConnection()
      .then((s) => {
        if (cancelled) return
        const connected = !!(s.connected && s.connection?.enabled)
        setInfo({
          connected,
          key: s.connection?.jiraProjectKey ?? null,
          discardStatus: connected ? s.connection?.discardStatus ?? null : null,
        })
      })
      .catch(() => {
        if (!cancelled) setInfo({ connected: false, key: null, discardStatus: null })
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [activeProjectId])

  return { connected: info.connected, jiraProjectKey: info.key, discardStatus: info.discardStatus, loading }
}
