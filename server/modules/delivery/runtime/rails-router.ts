// Rails HTTP router (mounted per project under /rails). This file is the
// composition point only: each concern registers its routes from a focused
// rails-*-http.ts file, and this function fixes their order.
//
// Registration order is part of the contract (Express matches first-registered).
// Within each registrar the original relative order is kept; across registrars
// no two routes can match the same method + path (literal segments such as
// `pr-ci`, `pr-ci-offer`, `pr-deliveries` and `pr-local-changes` never collide
// with the `/:railIndex/<action>` literals), so the groups cannot shadow each
// other. Keep `/:railIndex/stop` ahead of `/pr-local-changes/:action`-style
// literal routes if a new action ever shares a second segment.
import { Router } from 'express'
import { registerRailPrCiRoutes } from './rails-pr-ci-http'
import { registerRailStateRoutes } from './rails-state-http'
import { registerRailSettingsRoutes } from './rails-settings-http'
import { registerRailLaunchRoutes } from './rails-launch-http'
import { registerRailReviewRoutes } from './rails-review-http'

/** The Intent -> Spec loop only runs from an Intent session hand-off (arch section 4.8). */
export { FLOW_SPEC_LOOP_ID } from '../../loops/runtime/loop-factory'
export { normalizeRailMode } from './rails-http-shared'
export { prDeliveryRevisionAllowed } from './rail-delivery-revision'

export function createRailsRouter(): Router {
  const router = Router({ mergeParams: true })
  registerRailPrCiRoutes(router)
  registerRailStateRoutes(router)
  registerRailSettingsRoutes(router)
  registerRailLaunchRoutes(router)
  registerRailReviewRoutes(router)
  return router
}
