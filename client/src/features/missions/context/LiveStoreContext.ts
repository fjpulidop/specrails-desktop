import { createContext } from 'react'
import type { LiveStore } from '../lib/live-store'

/** The live-turn store of the nearest AgentChatProvider (null outside one). */
export const LiveStoreContext = createContext<LiveStore | null>(null)
