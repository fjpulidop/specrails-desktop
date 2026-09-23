## Why

Today the developer-prerequisites check (Node.js, npm, npx, Git) only fires inside `SetupWizard`, which runs **after** the user has already opened `AddProjectDialog`, picked a path, named the project, chosen a provider, and clicked "Add". The project is registered in `hub.sqlite` before we tell the user that something they need is missing — leaving them with a half-registered project they can't complete and a flow that breaks the premium "fail-before-commitment" expectation.

## What Changes

- **AddProjectDialog** runs a prerequisites check the moment it opens and renders a compact status panel inline.
  - Per tool: ✓ name + version when present, ✗ name + "More info" link when missing.
  - The "More info" affordance is rendered **only** when at least one required tool is missing — no clutter for users who already have everything.
- The "Add project" submit button is **disabled** while any required tool is missing. A tooltip on the disabled button names the missing tools.
- A new **Install instructions modal** opens from "More info":
  - Auto-detects the host OS (macOS / Windows / Linux) and shows only that OS's commands by default, with an expandable "Show other platforms" section.
  - macOS: Homebrew commands when applicable (`brew install node git`) plus official `nodejs.org` / `git-scm.com` fallback links.
  - Windows: `winget install OpenJS.NodeJS.LTS` and `winget install Git.Git`, plus the official download links.
  - Linux: `apt`/`dnf` snippets plus the official links.
  - Each command has a copy-to-clipboard button with a brief "copied" feedback toast.
- After the user installs a tool externally, the modal automatically re-checks prerequisites:
  - On `window.focus`.
  - On a manual "I installed it, recheck" button.
  - Cached 60s server-side response is invalidated by the recheck button.
- A small client-side cache (60s, hub-scoped) prevents repeated `/api/hub/setup-prerequisites` fetches when the dialog is opened/closed quickly.
- `SetupWizard` keeps its existing prerequisites panel as a **secondary defence** (in case the user gets there via a stale link or backend mismatch). Both surfaces share a single hook (`usePrerequisites`) so the UI and caching policy stay consistent.
- **Server enrichment**: `GET /api/hub/setup-prerequisites` returns minimum-version metadata per tool (e.g. `minVersion: '18.0.0'` for Node) and surfaces a `meetsMinimum: boolean` field. Existing `installed` semantics are preserved.
- **Server enrichment**: response includes a `platform` field (`'darwin' | 'win32' | 'linux'`) so the client renders OS-correct hints without re-detecting platform.

## Capabilities

### New Capabilities
- `add-project-prerequisites-gate`: Specifies the prerequisites check inside `AddProjectDialog`, the rules for blocking the submit, the install-instructions modal, and the cross-surface hook contract.

### Modified Capabilities
<!-- None — there is no existing spec covering AddProjectDialog or prerequisites surfacing. SetupWizard's spec (`setup-wizard-install-cta`) covers a different concern (post-registration install CTA) and is not amended. -->

## Impact

**New code (client):**
- `client/src/features/projects/hooks/usePrerequisites.ts` — shared hook with 60s cache and recheck on `window.focus`.
- `client/src/features/projects/components/PrerequisitesPanel.tsx` — reusable status panel rendered by both `AddProjectDialog` and `SetupWizard`.
- `client/src/features/projects/components/InstallInstructionsModal.tsx` — OS-aware install command modal with copy-to-clipboard.

**Modified code (client):**
- `client/src/features/projects/components/AddProjectDialog.tsx` — embeds `<PrerequisitesPanel />`, gates the submit button, opens `<InstallInstructionsModal />`.
- `client/src/components/SetupWizard.tsx` — replaces the inline prereq fetch + panel with `usePrerequisites()` + `<PrerequisitesPanel />`.

**Modified code (server):**
- `server/setup-prerequisites.ts` — adds `minVersion` per tool and a `meetsMinimum` field; adds `platform` to the response.
- `server/setup-prerequisites.test.ts` — extends coverage for version parsing and `meetsMinimum`.

**APIs:**
- `GET /api/hub/setup-prerequisites` response shape changes additively: new optional fields `minVersion`, `meetsMinimum`, `platform`. No breaking change for existing consumers.

**Dependencies:** none added.

**User-visible:** Adding a project becomes impossible while required tools are missing; install instructions are one click away with copy-paste commands.

**Coverage gates:** New components carry their own tests; client global gate (70%) holds. Server gate stays at 80%/70% — the additive prereq logic adds straightforward branches.
