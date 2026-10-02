# Desktop workflows and loop agents

Desktop owns workflow recipes, agent definitions and decisions. Core supplies
reusable execution primitives, scoped tools, durable checkpoints and real host
verification. `workflowAgentSteps: 1` (catalog version 7) enables the current
recipes. A new step is a `role-turn` bound to a loop-defined role, not a Core
implementation phase.

## Editable recipes

Implement and Ship and Green use loop roles `plan`, `build`, `assess` and
`correct`. Their names, instructions, engines, effort, turn limits, permissions,
OpenSpec skill, task prompts and structured result schemas are editable. The
graph defines confidence questions, review thresholds, correction edges, optional
candidate approval, archive routing and post-archive verification. These are
explicit nodes, not policies hidden behind a phase selector.

The recipe declares `ticketScope: all` to preserve a single execution for a
rail's selected specs. This Desktop launch setting is independent of Core's
journal format; other loops can declare `per-ticket`.

Add **Agent step** to any loop or component to create an independent agent
configuration. Select the node to edit it. Its role identifier accepts a new
name or an existing role; selecting an existing role intentionally shares that
role's definition within this loop. With no node selected, the inspector shows
a selection hint. Advanced settings holds workflow limits and composition.

Freestyle, Quick SDD and the remaining starter templates also own their agent
configuration. Their prompt and decider nodes retain their existing semantics.
Freestyle and free-form starters use agent definitions for direct code work,
without requiring an active OpenSpec change or an apply binding. Command
templates resolve their spec/constant placeholders at admission; inserted task
data remains literal and cannot introduce commands or Core runtime tokens.
Provider connections stay global; repository verification commands stay with
the project. Launch provider, model and effort supply inherited defaults;
explicit loop-owned assignments take precedence. Publishing a builtin edit applies to future runs in
all projects. Duplicate it for a specific flow.

## Host gates and recovery

`artifact-contract` freezes proposal, design, delta specs and task descriptions
in private state owned by the execution scope. Checks allow task checkbox
completion and can require all tasks complete. Workflow variables and fork
output patches cannot replace that private contract. Verification retains all
configured host checks; bounded planner proposals supply actual commands only
for repositories without configured checks. Scoped subprocess validation and
real candidate receipts apply to both sources.
Committed verification outputs include bounded actual command diagnostics for
the reviewer and fixer, prioritizing failures; full evidence stays in receipts.

Agent outputs include the host candidate hash. Optional approval captures its
candidate before interruption and retains it on resume. The archive gate checks
real committed full verification and the reviewed/approved candidate before
publishing the recoverable write set. The final host check certifies the archived
candidate. Reviewer assertions remain AI evidence and cannot create verification.

Implement checks the host candidate hash after each correction. When verification
failed and the correction leaves that candidate unchanged, it ends unsuccessfully
with the corrector's explanation instead of rerunning the same failed checks.
Corrections after a passing verification may still refresh review evidence without
source changes. Failed completion reasons are surfaced in Desktop's job error.

The corrector receives the exact verification command, cwd, original exit code,
failure summary, full-evidence identifier and current candidate's review output
directly. The recipe explicitly clears review feedback when verification fails
or its candidate no longer matches, including before the first reviewer visit.
It reproduces the failure, distinguishes implementation defects from test
compatibility assumptions and external blockers, and may make a minimal test
compatibility repair inside the admitted workspace while preserving the tested
behavior and every required safety guard. An unchanged filename alone cannot
justify an unrelated-failure diagnosis. Focused checks retain their original exit
codes; repaired assertions need negative cases. Saved/customized definitions keep
their frozen prompts; future unedited recipes use these updated defaults.

The paired Core also supplies the official verify skill and real status/apply
context before a read-only reviewer turn, including custom `assess` roles. Missing
planning context still blocks invocation; host preparation does not approve the
candidate or replace the review's inspection and structured findings.

Admission freezes the graph, agents, Core package and repository checks. Resume
uses this snapshot. Generic forks copy an active change into a separate change,
carry scope-owned contracts forward, rebind `run.changeId`, and clear verification.
A changed candidate must be verified and reviewed again.

## Existing loops

Unedited builtin rows refresh when the selected Core supports the capability.
Edited graphs are preserved. **Restore original** adopts the new builtin recipe;
duplicating it leaves the existing customization intact. Older packages continue
to receive compatible recipes. Saved `implementation` and `implementation-step`
nodes remain executable for historical graphs and retained runs. They are hidden
from the new-node palette and marked historical in their inspector.

Historical project agent import remains an explicit draft operation. It copies
configuration without modifying the source project. The current recipe's role
names should be configured directly in each node.

## Validation and local development

`loop-factory-paired.test.ts` executes the actual Desktop bridge and Core CLI with
deterministic executors, including arbitrary roles and correction after failed
verification. Core contract, approval and fork tests check real files and durable
recovery. UI tests add two independent agents and save their separate definitions.

For paired checks, build Core and set `SPECRAILS_CORE_SOURCE_DIR` to its checkout.
For local Desktop execution, set `SPECRAILS_CORE_RUNTIME_PATH` to the built
`specrails-core/dist/agent-runtime/index.js` when starting the dev server or native
dev app. Restart after rebuilding Core so capability detection refreshes.

Loop agent providers default to `inherit`: resolve the launching mission/rail’s
provider, model and effort before freezing the Core runtime configuration. A
provider explicitly selected in the loop wins; its blank model uses that
provider’s default rather than an incompatible mission model. Inherited agents
may still override model or effort individually. The inheritance marker is never
passed to Core as a connection. Builtin refresh upgrades unchanged factory
recipes; customized loops retain their explicit selections.

## Projects and code workspaces

Registration and project settings accept `workspacePaths`, one directory per line,
absolute or relative to the registered repository. For `skills`, configure
`skills-studio` to work in that child directory. Configure several folders of the
same Git checkout under one membership to preserve one branch and delivery owner.
An omitted list means the registered folder is itself the code workspace.
Independent nested Git checkouts can be attached to a non-Git project container as
separate memberships; specs must select those members for isolated writes.

Rails and mission implementation cards expose workspace checkboxes.
`workspaceSelection` maps repository IDs to a nonempty subset of their registered
paths. The operator discovers these paths from project context and may include
`repositoryIds` and `workspaceSelection` in a `rail-launch` proposal or a direct MCP
launch. Unknown paths and memberships fail before resource allocation. A launch
never modifies project workspace configuration. Rail choices are saved with the
project's dashboard state; card choices are saved in the message's launch intent.

All three workflows freeze selected code scopes and configured checks. Checks
without a directory expand across selected workspaces; explicit checks for other
registered workspaces are excluded. Every executed check must remain inside a
selected code workspace, including after symlink resolution. Multiple scopes require
an explicit workspace directory for agent-proposed checks. Logs show actual command
directories, and agents receive the same absolute paths for manual checks. These
code workspaces are distinct from the internal agent/artifact workspace.

The MCP exposes workspace inventory and membership configuration through `specrails_projects` (`repositories`, `repository_add`, `repository_update`, `repository_remove`). Updates reuse the HTTP lifecycle guards. `specrails_setup(add_project)` accepts primary `workspacePaths` and additional `repositories`; both `specrails_rails(launch)` and `specrails_loops(run)` accept the same `workspaceSelection` map. Project resolution also recognizes registered workspace paths.
