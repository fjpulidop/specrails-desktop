// ─── A run's primary action: an explicit contract ────────────────────────────
// The run strip shows ONE primary action for the run it shows. The run's full
// card (mounted, hidden, inside the strip's panel) DECLARES that action here —
// id, label, kind and handler — instead of the strip reading the DOM.
//
//   kind 'local'    — reversible, inward actions that spend nothing new
//                     (Resume, Back to Flow, Mark done): the strip performs
//                     them in one click.
//   kind 'outward'  — actions other people see, that start a delivery or
//                     that spend money on a new run (Create PR, Publish,
//                     Reopen, Approve, Launch, merge, Relaunch, Recover):
//                     the strip NEVER fires them. Its button opens the panel
//                     with focus on the card's own control, so the card's
//                     confirmation and refusals stay in charge.
//
// A card declares its primary by rendering <RunPrimaryButton primary={…}>
// (or calling useRunPrimary). Outside a strip panel (a card in the history)
// the declaration is inert.

import { createContext, forwardRef, useContext, useEffect, useRef, type ButtonHTMLAttributes, type ReactNode, type Ref } from 'react'

/**
 * The ONE recipe of a run's primary button (strip primary, hand-off Launch,
 * card primary, Flow Start): shape, type, focus and disabled state. Pair it
 * with a color: PRIMARY_ACTION is the primary accent; a mode passes its own
 * (Flow: accent-flow) on the same shape.
 */
export const PRIMARY_ACTION_SHAPE =
  'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-xs font-semibold shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50'

export const PRIMARY_ACTION =
  `${PRIMARY_ACTION_SHAPE} bg-accent-primary text-white hover:bg-accent-primary/90 focus-visible:ring-accent-primary/60`

export type RunPrimaryKind = 'outward' | 'local'

export interface RunPrimaryDeclaration {
  /** Stable id of the action within its card ("create-pr", "relaunch"). */
  id: string
  /** The words of the action (the card's own label). */
  label: string
  kind: RunPrimaryKind
  /** Lower wins when a card declares several (e.g. Approve over Recover). Default 10. */
  rank?: number
}

export interface RunPrimaryAction extends RunPrimaryDeclaration {
  disabled: boolean
  /** Performs the action (local kinds only — the strip never runs an outward one). */
  run: () => void
  /** Moves focus to the card's control (outward kinds). */
  focus: () => void
}

/** What a strip panel collects: the declarations of the card it hosts. */
export interface RunPrimaryRegistry {
  set: (owner: symbol, action: RunPrimaryAction) => void
  remove: (owner: symbol) => void
}

const RunPrimaryContext = createContext<RunPrimaryRegistry | null>(null)

/** Scopes the declarations of one run's card to that run (the strip wraps each panel). */
export function RunPrimaryScope({ registry, children }: { registry: RunPrimaryRegistry; children: ReactNode }) {
  return <RunPrimaryContext.Provider value={registry}>{children}</RunPrimaryContext.Provider>
}

/** The best declared action of a set: lowest rank, then the first declared. */
export function bestRunPrimary(actions: Iterable<RunPrimaryAction>): RunPrimaryAction | null {
  let best: RunPrimaryAction | null = null
  for (const action of actions) {
    if (!best || (action.rank ?? 10) < (best.rank ?? 10)) best = action
  }
  return best
}

/**
 * Declares (or withdraws, with null) the run's primary action. The handler and
 * focus target may change every render; only the visible fields re-declare.
 */
export function useRunPrimary(action: (RunPrimaryDeclaration & { disabled?: boolean; run: () => void; focus: () => void }) | null): void {
  const registry = useContext(RunPrimaryContext)
  const owner = useRef<symbol>(Symbol('run-primary'))
  const latest = useRef(action)
  latest.current = action
  const id = action?.id ?? null
  const label = action?.label ?? null
  const kind = action?.kind ?? null
  const rank = action?.rank
  const disabled = action?.disabled ?? false
  useEffect(() => {
    if (!registry) return
    const me = owner.current
    if (id === null || label === null || kind === null) { registry.remove(me); return }
    registry.set(me, {
      id, label, kind, rank, disabled,
      run: () => latest.current?.run(),
      focus: () => latest.current?.focus(),
    })
  }, [registry, id, label, kind, rank, disabled])
  useEffect(() => {
    if (!registry) return
    const me = owner.current
    return () => registry.remove(me)
  }, [registry])
}

type ButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick' | 'type'> & {
  primary: RunPrimaryDeclaration
  onClick: () => void
}

/** A card's control that is also its run's primary action. */
export const RunPrimaryButton = forwardRef(function RunPrimaryButton(
  { primary, onClick, disabled, ...rest }: ButtonProps,
  forwarded: Ref<HTMLButtonElement>,
) {
  const local = useRef<HTMLButtonElement | null>(null)
  useRunPrimary({
    ...primary,
    disabled: !!disabled,
    run: onClick,
    focus: () => {
      const node = local.current
      if (!node) return
      try { node.focus({ preventScroll: true }) } catch { node.focus() }
    },
  })
  return (
    <button
      {...rest}
      ref={(node) => {
        local.current = node
        if (typeof forwarded === 'function') forwarded(node)
        else if (forwarded) forwarded.current = node
      }}
      type="button"
      disabled={disabled}
      data-run-primary-id={primary.id}
      data-run-primary-kind={primary.kind}
      onClick={(event) => { event.stopPropagation(); onClick() }}
    />
  )
})
