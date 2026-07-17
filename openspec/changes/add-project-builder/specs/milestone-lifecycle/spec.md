# milestone-lifecycle

## ADDED Requirements

### Requirement: M1-only detailed generation
The Builder SHALL generate detailed specs during day 0 ONLY for Milestone 1: an approval-gated walking skeleton of 5–10 canonical rich specs whose first spec is explicitly `kind='scaffold'`. After approval, all 5–10 SHALL arrive in one assistant response and one complete snapshot, never in partial waves. Milestones 2+ SHALL carry only high-level `plannedSpecs` titles until their milestone is explicitly generated against the real project; explicit generation SHALL likewise return the target milestone's entire detailed set in one response/snapshot. The system prompt SHALL enforce the 5–10 range, atomic response, and rich contract; the commit endpoint SHALL use the shared deterministic quality gate before mutation and reject blueprints whose `specsComplete` is false, whose M1 set is outside 5–10, whose first spec is not the scaffold, or whose detailed specs fail the canonical field/heading/criteria/dependency contract.

#### Scenario: Cap enforced at commit
- **WHEN** a blueprint arrives with 12 `m1Specs`
- **THEN** commit validation rejects with a named error

#### Scenario: M2 stays shallow
- **WHEN** the committed blueprint is inspected
- **THEN** M2+ milestones contain titles only, no descriptions

#### Scenario: Partial M1 stays uncommittable
- **WHEN** an interrupted or crafted snapshot contains fewer than 5 M1 specs, has `specsComplete=false`, or includes an incomplete detailed spec
- **THEN** project commit is rejected before mutation, and the normal generation flow never presents that subset as its completed result

### Requirement: Launch Milestone 1 CTA
After a successful commit, the Builder's final screen SHALL offer "Launch Milestone 1": place ALL M1-labeled `todo` tickets on ONE rail and launch it with the batch-implement factory loop (sequential, single worktree, single PR), reusing the existing rails REST surface unchanged (`POST /rails` when no free rail, `PUT` tickets, `POST /rails/:i/launch`). The CTA SHALL be skippable; the same action SHALL be available later from the sidebar entry.

#### Scenario: One batch rail
- **WHEN** the user activates "Launch Milestone 1" with 7 M1 tickets
- **THEN** one rail launches in batch mode carrying all 7 tickets, subject to the existing launch guards (409s surface as normal toasts)

#### Scenario: Skippable
- **WHEN** the user closes the final screen without launching
- **THEN** the project remains fully usable and the CTA reappears in the sidebar entry

### Requirement: Sidebar re-entry
A sidebar entry SHALL appear (board and mission modes, inside the active project only) when the active project's workspace contains `blueprint.json`. It SHALL show per-milestone progress derived LIVE from the ticket board (tickets labeled `M<n>`, their statuses) — never from stored ticket ids — and expose "Launch Milestone 1" (while M1 has launchable tickets) and "Generate M<next>" actions.

#### Scenario: Entry visibility
- **WHEN** the active project has no `blueprint.json`
- **THEN** no Builder sidebar entry renders

#### Scenario: Board-derived progress
- **WHEN** the user manually moves an M1 ticket to `done`
- **THEN** the sidebar milestone progress reflects it on the next board update without any blueprint write

### Requirement: Generate M2+ as project-level grounded generation
"Generate M<next>" SHALL open a PROJECT-level conversation (`chat_conversations.kind='milestone'`) spawned through the existing ChatManager machinery, seeded with `blueprint.json`, the target milestone's `plannedSpecs`, the complete canonical rich-spec contract, and milestone grounding rules. It SHALL be an inspection-only authoring turn: the prompt SHALL forbid repository/workspace/ticket/config/git mutation, write-capable commands/tools, and builds/tests. It SHALL inspect the real project before naming paths or identifiers and SHALL require criteria covering behavior, failures/edge cases, and tests. For relocated projects the prompt SHALL identify the absolute source repo and its `./project` mount rather than letting tools inspect only the workspace. The complete dynamic instructions and blueprint context SHALL reach Claude, Codex, and Gemini; when an adapter lacks a dedicated system-prompt argument, the server SHALL fold them into the effective user turn. Native tool policy SHALL restrict Claude to plan/safe mode with Read/Grep/Glob, Codex to its read-only filesystem sandbox, and Gemini to plan mode without yolo. Because Gemini exposes no selectable Codex-style filesystem sandbox, its boundary SHALL be described as CLI plan/policy-layer rather than OS/filesystem enforced; incompatible safety flags SHALL fail the turn instead of relaxing to yolo. It SHALL reuse the `blueprint-draft` protocol for output and SHALL return every detailed spec for the target milestone in one response containing one complete snapshot, never an incrementally committable subset. Before any write, committing the exact raw batch SHALL atomically apply the same `specsComplete` and rich-spec quality gate used by M1; on success it SHALL insert authoritative detailed tickets labeled `M<n>` with `source='project-builder'` and `created_by='project-builder'`, preserving priority/short summary/domain labels, folding the separate criteria once, and mapping dependencies, then store only `status='committed'` and advisory `ticketIds` on that blueprint milestone. Turn accounting SHALL record per-project `ai_invocations` rows with `surface='explore-spec'` (no new surface value). On Jira-connected projects the inserted specs ride the existing spec-creation → Jira machinery unchanged. After success the client SHALL invalidate/refetch the blueprint and advance the Generate action to the first later milestone still `planned`.

#### Scenario: Grounded generation
- **WHEN** "Generate M2" runs on a project with real code
- **THEN** the conversation spawns project-level with code-reading tools and the seeded milestone context, and detailed specs name only verified existing paths and identifiers

#### Scenario: All providers receive the milestone contract
- **WHEN** M2 generation uses Claude, Codex, or Gemini
- **THEN** the effective invocation includes the same exact headings, structured fields, completion/dependency rules, one-response complete-set rule, grounding requirements, and blueprint context

#### Scenario: Provider-native read-only policies
- **WHEN** M2 generation spawns through Claude, Codex, or Gemini
- **THEN** Claude receives plan/safe mode with only Read/Grep/Glob, Codex receives a read-only sandbox, and Gemini receives plan mode without yolo or an unsafe fallback

#### Scenario: Relocated project grounds against the source repo
- **WHEN** M2 generation runs from a relocated workspace
- **THEN** the prompt identifies the real source repository path and `./project` mount so read tools do not inspect the workspace as though it were the codebase

#### Scenario: Commit flips status
- **WHEN** the M2 batch is committed
- **THEN** authoritative rich tickets labeled `M2` appear as `todo` with reviewed priority/summary/folded criteria/domain labels/prerequisites, while `blueprint.json` records only `m2.status='committed'` and advisory ticket IDs

#### Scenario: Successful commit advances the sidebar
- **WHEN** committing M2 returns success and M3 remains planned
- **THEN** the client refetches the blueprint, closes the M2 shell, and the next Generate action targets M3

#### Scenario: Invalid M2 batch writes nothing
- **WHEN** any detailed M2 spec fails the shared quality gate
- **THEN** the endpoint inserts no tickets and leaves the milestone status and blueprint pair unchanged

#### Scenario: Accounting per project
- **WHEN** an M2 generation turn settles
- **THEN** an `ai_invocations` row records with `surface='explore-spec'` and the project's id
