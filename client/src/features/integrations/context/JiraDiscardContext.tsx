import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { useJiraConnection } from '../hooks/useJiraConnection'

interface JiraDiscardValue {
  /** The configured "move-to on discard" status, or null when discard is N/A. */
  discardStatus: string | null
}

const JiraDiscardContext = createContext<JiraDiscardValue>({ discardStatus: null })

/**
 * Provides the project's Jira discard ("move-to") status to every descendant
 * with ONE connection fetch (via useJiraConnection), so the per-card
 * TicketContextMenu can offer "Move to <status>" without fetching per card.
 * Mounted around the specs board. Outside a provider the hook returns null, so
 * unrelated context menus keep their normal delete behaviour.
 */
export function JiraDiscardProvider({ children }: { children: ReactNode }) {
  const jira = useJiraConnection()
  const discardStatus = jira.connected ? jira.discardStatus : null
  const value = useMemo(() => ({ discardStatus }), [discardStatus])
  return <JiraDiscardContext.Provider value={value}>{children}</JiraDiscardContext.Provider>
}

export function useJiraDiscard(): JiraDiscardValue {
  return useContext(JiraDiscardContext)
}
