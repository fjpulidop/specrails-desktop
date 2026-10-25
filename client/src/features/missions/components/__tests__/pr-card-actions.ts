/**
 * The PR card keeps one primary button; the rest sit behind its "More actions" menu.
 * These helpers find an action wherever it lives (a plain button, or a menu item after
 * opening the menu), so tests assert behavior, not layout.
 */
import { fireEvent, screen } from '@testing-library/react'

export function openMoreActions(): void {
  const trigger = screen.queryByTestId('agent-pr-more') ?? screen.queryByTestId('rail-pr-more')
  if (trigger && trigger.getAttribute('aria-expanded') !== 'true') fireEvent.click(trigger)
}

const prefix = (name: string) => new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)

export function queryAction(name: string): HTMLElement | null {
  const button = screen.queryByRole('button', { name })
  if (button) return button
  openMoreActions()
  return screen.queryByRole('menuitem', { name: prefix(name) })
}

export function getAction(name: string): HTMLElement {
  const found = queryAction(name)
  if (!found) throw new Error(`No "${name}" action (button or menu item)`)
  return found
}

export function queryMoreItem(testId: string): HTMLElement | null {
  const direct = screen.queryByTestId(testId)
  if (direct) return direct
  openMoreActions()
  return screen.queryByTestId(testId)
}

export function getMoreItem(testId: string): HTMLElement {
  const found = queryMoreItem(testId)
  if (!found) throw new Error(`No "${testId}" action`)
  return found
}
