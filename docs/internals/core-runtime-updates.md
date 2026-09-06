# Core runtime selection and updates

Desktop resolves one Core runtime for framework materialization, project setup,
compatibility checks and execution helpers. `server/core-runtime.ts` performs
read-only discovery; it does not execute a PATH shim or install a global package.

An explicit `SPECRAILS_CORE_BIN` wins when it resolves to a usable compatible
package. Otherwise Desktop selects the newest compatible package from its
activated managed installation, bundled resources, local dependency and external
CLI on PATH. Core 4 and 5 remain supported. A runtime older than the active
framework is rejected rather than silently replacing an update.

## Persistence and publication

Desktop updates retain the complete npm installation, including dependencies,
under `~/.specrails/core/<version>/`. The registry home override applies to this
directory. Only the managed package corresponding to the active framework is
eligible; an unpublished staging directory is not an installation candidate.

Updates verify the downloaded version, retain the package, materialize every
requested provider without swapping, and persist recovery state before moving
`framework/current`. Incomplete retained packages are moved to a retained
`.previous-<version>-*` directory before their verified replacement is published.
Previous framework versions are retained. Windows repair reads the activated
version instead of choosing the highest directory, which could be an unfinished
stage.

Changing the shared pointer does not update copied project files. The update
therefore waits for all affected workspaces to be assembled again. Existing
provider installation configuration and MCP configuration are preserved. A
workspace's version marker and any runtime helper declared by the selected Core
contract are verified before that workspace is considered refreshed.

## Partial refresh and recovery

The global `core/update-status.json` stores a pending version before publication.
Affected workspaces receive `.specrails/core-update-pending.json` before the
first asynchronous assembly. New implementations in those workspaces are
blocked until verification clears the marker; reading projects and conversations
remains available. The global pending state also protects an old workspace whose
local marker could not be written.

If one workspace fails after publication, Desktop reports a partial update and
retains the pending state across restart. It does not claim that a global pointer
rollback restored already updated copies. **Finish updating** retries with the
retained package and works offline. Successful completion is emitted only after
all workspace refreshes and the final recovery-state write succeed.

## Version reporting

Global status distinguishes the selected runtime and its source, the active
framework, the version included in Desktop, and the last successful registry
check. Installing an explicit target does not overwrite a newer known registry
version. Registry-check cache failures do not erase installed-version information;
recovery-state write failures prevent publication or successful completion.

Project status reports provider link versions separately from the workspace seed
marker. Mixed links/copies or a pending refresh produce `mixed: true` and no
single claimed installed version. Copied and deliberately pinned projects retain
their own version instead of inheriting global `current`.

Core 5 uses deterministic installation. Legacy enrichment entry points complete
only when the native Core 5 role and command artifacts are present; otherwise
they request installation repair and never invoke a removed enrichment command.

Tests use temporary installations and fake CLI processes, including a fresh Node
process that resolves an updated package and materializes another provider
offline. No global CLI or user project is updated by these tests.
