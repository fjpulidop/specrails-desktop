// Public API of the Tapflow plugin (iOS Simulator / Android emulator streaming): rules, use cases, routes and wiring.
export { TAPFLOW_VERSION, TAPFLOW_DEFAULT_PORT, tapflowResourceRoots, type TapflowPhase, type TapflowStatus, type TapflowIssue } from './domain'
export { createTapflowPlugin, type TapflowPlugin } from './application'
export { registerTapflowRoutes } from './adapters/http'
export { createTapflowRuntime, createMobileTestHandlersFor, mobileOfferEnv, tapflowReady, tapflowServicePid, withDeviceFootprints } from './runtime'
export { registerMobileTestRoutes } from './adapters/http'
