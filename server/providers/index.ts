// Provider barrel. Importing this module registers every bundled adapter so
// managers can resolve them via `getAdapter`. Adapters themselves are pure
// const exports — testing an adapter in isolation does NOT side-effect the
// registry. Production code MUST import this module (not the adapter files
// directly) so the registration runs.
//
// Spec: openspec/specs/multi-provider-architecture/spec.md

import { register } from './registry'
import { claudeAdapter } from './claude-adapter'
import { codexAdapter } from './codex-adapter'
import { geminiAdapter } from './gemini-adapter'

register(claudeAdapter)
register(codexAdapter)
register(geminiAdapter)

export { getAdapter, hasAdapter, listAdapters } from './registry'
export { claudeAdapter, codexAdapter, geminiAdapter }
export type {
  ProviderAdapter,
  ProviderId,
  SpawnAction,
  SpawnOptions,
  AdapterEvent,
  NormalisedResult,
  DetectionResult,
  ProviderCapabilities,
} from './types'
export { UnknownProviderError } from './types'
