/**
 * Ids of the built-in loops the client names directly (the server's `loop-factory.ts`
 * owns their graphs). Fix PR CI keeps this id for life: its CI offer, settlement and host
 * tasks find a run by it, so it is edited in place in Loops and never copied.
 */
export const PR_CI_LOOP_ID = 'factory:pr-ci'
