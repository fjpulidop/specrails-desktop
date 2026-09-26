# Desktop role and factory integration decisions

- Desktop vendors the paired Core schema without editing it and mirrors semantic
  role validation: custom IDs, provider/model references, explicit source/artifact
  access and immutable built-in descriptors. The three historical `agents` keys
  remain intact. Custom role prompts belong to their role descriptors; global
  legacy prompt files keep their existing built-in semantics.
- Saving and capability checks fail clearly if custom roles require a Core
  without `openRoles: 1`. No custom assignment is silently dropped. Capability
  responses match the submitted built-in/custom role and escalation selections,
  with exact membership and duplicate rejection instead of a six-row ceiling.
- The settings role editor reuses provider/model/effort controls and shows
  source access, artifact access, optional native OpenSpec skill and prompt.
  Existing built-ins keep their fixed policy and project switching keeps cached
  state. Custom defaults are read-only source access and no artifact writes.
- Factory IDs and aliases remain stable. Capability-aware selection returns Core
  definition graphs only when engineV2/workflowDefinitions are supported; legacy
  factory graphs remain available to older retained runtimes. New factory graphs
  carry explicit Core kinds and global verified-delivery gates. Batch narrows
  frozen tickets in real child implementations and verifies globally after join.
- Quick SDD uses native free prompts with explicit policy and the real pinned
  OpenSpec validate/archive pieces. Host verification before and after archive
  preserves a verified final candidate. A native sentinel alone cannot satisfy
  the final completion gate.
