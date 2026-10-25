// ─── Spec extensions (composition seam) ───────────────────────────────────────
// Features that work ON a spec from outside the specs feature (Flow today)
// must not be imported by specs. Specs exposes this extension point and the
// application composition root (App.tsx) provides the implementation:
//
//   - StartAlternative: another way to start work on an existing spec, shown
//     with equal weight next to the Implement door (drag / Move to Rail). Flow:
//     "Start in Flow". `variant` picks the shape: a context-menu item or the
//     spec detail header button.
//
// The value must be STABLE for the app's lifetime. Without a provider the
// slot is inert and specs behave exactly as before.

import { createContext, useContext, type ComponentType, type ReactNode } from 'react'
import type { LocalTicket } from '../../../types'

export type SpecStartTarget = Pick<LocalTicket, 'id' | 'title' | 'status' | 'metadata' | 'origin_conversation_id' | 'repositoryIds'>

export interface SpecStartAlternativeProps {
  spec: SpecStartTarget
  /** The rail the spec sits on (null ⇒ none). */
  rail: { running: boolean } | null
  variant: 'menu' | 'button'
  /** Menu variant: dismiss the menu once the action finished. */
  onDone?: () => void
  className?: string
}

export interface SpecExtensions {
  StartAlternative?: ComponentType<SpecStartAlternativeProps>
}

const NONE: SpecExtensions = Object.freeze({})
const SpecExtensionsContext = createContext<SpecExtensions>(NONE)

export function SpecExtensionsProvider({ value, children }: { value: SpecExtensions; children: ReactNode }) {
  return <SpecExtensionsContext.Provider value={value}>{children}</SpecExtensionsContext.Provider>
}

export function useSpecExtensions(): SpecExtensions {
  return useContext(SpecExtensionsContext)
}
