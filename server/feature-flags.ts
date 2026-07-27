export function isCodeExplorerEnabled(): boolean {
  return process.env.SPECRAILS_CODE_EXPLORER !== 'false'
}

/**
 * Browser-capture feature ("Add Spec from browser"): an embedded CDP/Chromium
 * browser whose screencast is streamed in-app, plus region-select → screenshot +
 * DOM capture that feeds Add Spec (Quick/Explore). Server-side default ON; set
 * SPECRAILS_BROWSER_CAPTURE="false" to disable the routes + WS endpoint entirely
 * (emergency rollback). The client gates separately on VITE_FEATURE_BROWSER_CAPTURE.
 */
export function isBrowserCaptureEnabled(): boolean {
  return process.env.SPECRAILS_BROWSER_CAPTURE !== 'false'
}

/**
 * Jira integration ("spec = Jira issue", per-project hot-swap local↔Jira).
 * Server-side default ON; set SPECRAILS_JIRA_SECTION="false" to 404 the routes
 * and skip all sync (emergency rollback). The feature is inert until a project
 * actually configures a Jira connection, so default-on is safe. The client gates
 * separately on VITE_FEATURE_JIRA.
 */
export function isJiraEnabled(): boolean {
  return process.env.SPECRAILS_JIRA_SECTION !== 'false'
}

/**
 * Interactive freestyle jobs: when launched with the rail's "Interactive"
 * toggle, a Claude Freestyle job becomes a persistent chat session —
 * the user sends multiple prompts across turns, the job stays resident until an
 * explicit "Finalize Job" action, and every turn's real token spend is summed
 * into the single job row. Server-side default ON; set
 * SPECRAILS_INTERACTIVE_JOBS="false" to reject the toggle + the per-job
 * message/finalize routes (emergency rollback). Inert unless a launch actually
 * sets interactive=true, so default-on is safe. The client gates separately on
 * VITE_FEATURE_INTERACTIVE_JOBS.
 */
export function isInteractiveJobsEnabled(): boolean {
  return process.env.SPECRAILS_INTERACTIVE_JOBS !== 'false'
}

/**
 * Loops ("automation loops"): a global, cross-project library of visually-authored
 * iterative workflows, plus a 4th rail mode ("loop") that runs a published loop
 * against the dragged spec. App-driven engine; the stop/continue decision is a
 * dedicated AI "Loop Decider" node. Server-side default ON; set
 * SPECRAILS_LOOPS_SECTION="false" to 404 the /api/loops routes and hide the
 * section (emergency rollback). Inert until a loop is actually run, so default-on
 * is safe. The client gates separately on VITE_FEATURE_LOOPS_SECTION.
 */
export function isLoopsEnabled(): boolean {
  return process.env.SPECRAILS_LOOPS_SECTION !== 'false'
}

/**
 * Review packet (nontech-review-experience): the plain-language what-changed +
 * proof surface a non-technical user decides on, replacing raw git vocabulary
 * at the review moment. Server-side default ON; set
 * SPECRAILS_REVIEW_PACKET="false" to 404 the packet route (emergency
 * rollback — the existing decision strip keeps working untouched). The client
 * gates separately on VITE_FEATURE_REVIEW_PACKET.
 */
export function isReviewPacketEnabled(): boolean {
  return process.env.SPECRAILS_REVIEW_PACKET !== 'false'
}
