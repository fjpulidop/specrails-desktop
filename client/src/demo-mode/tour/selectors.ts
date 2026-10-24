/**
 * DOM selectors used by the tour orchestrator. One exported constant per
 * selector so the `selectors.test.ts` unit test can iterate and assert each
 * resolves to exactly one element in the demo build.
 *
 * openspec: desktop-demo-scripted-tour
 */

export const TOUR_SELECTORS = {
  /** The "New spec" button inside the Specs toolbar that opens the Propose Spec modal. */
  addSpecButton: '[data-tour="add-spec-btn"]',
  /** Textarea inside the Propose Spec modal where the spec description is typed. */
  proposeSpecTextarea: '[data-tour="propose-spec-textarea"]',
  /** "Generate Spec" submit button inside the Propose Spec modal. */
  generateSpecButton: '[data-tour="generate-spec-btn"]',
  /** The REAL new-spec ticket rendered inside the Specs column (id 9999). */
  newSpecCard: '[data-ticket-id="9999"]',
  /** The Play control on the first rail (Rail 1). */
  rail1PlayButton: '[data-tour="rail-1-play"]',
  /** The View Log (scroll icon) control on the first rail. Only visible while the rail is running. */
  rail1LogButton: '[data-tour="rail-1-logs"]',
} as const

export type TourSelectorKey = keyof typeof TOUR_SELECTORS

/** Resolve a tour selector to a single DOM element or null if not present. */
export function findTourElement(key: TourSelectorKey): Element | null {
  const selector = TOUR_SELECTORS[key]
  const matches = document.querySelectorAll(selector)
  if (matches.length !== 1) return null
  return matches[0]
}
