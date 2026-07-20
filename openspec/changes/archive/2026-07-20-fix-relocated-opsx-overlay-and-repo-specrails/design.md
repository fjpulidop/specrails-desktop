# Design

## D1 — Multi-source overlay, not a special-cased opsx link

The gap is generic: ANY untracked repo-resident provider-dir entry (openspec's `commands/opsx/`, `skills/openspec-*/`, a user's own untracked `.claude` extras) is invisible to a relocated isolated run today, while a legacy run gets all of them (its overlay source IS the repo). Special-casing `opsx` would fix one symptom and leave the class open. The overlay therefore takes ordered source roots — `sourceRoot` (unchanged, primary) plus optional `fallbackSourceRoots` — and merges the UNION of provider-dir entries with first-root-wins per entry. Relocated launches pass `[workspace, repo]`; legacy launches pass `[repo]` only (byte-identical to today).

## D2 — Directory merge: real dir + per-child links when several roots contribute

Today an absent dest dir gets ONE whole-dir symlink. With two roots that can both contribute children to the same dir (workspace `commands/` has `specrails/`, repo `commands/` has `opsx/`), a whole-dir link to either root would hide the other's children — and writing through the workspace link into the shared framework dir is forbidden. So:

- dest missing, exactly one root has the entry → whole-entry link (status quo).
- dest missing, entry is a dir in >1 root → create a REAL dir, recurse over the union of children (per-child resolution, first root wins for files).
- dest missing, entry is a FILE in the first root that has it → link that file (later roots never override an earlier root's file).
- dest is OUR authenticated prior link (target = one of the roots' paths AND present in the prior manifest evidence) and another root now contributes extra children, or a higher-priority root becomes the winner → REBUILD from the current ordered sources. A foreign/checkout link is never replaced even when it points at the same configured source. This is the resume path for worktrees allocated before this change and for fallback-to-primary promotion.
- dest is an authenticated prior COPY (the Windows no-link fallback) requiring the same merge/promotion → revalidate its source-identical digest immediately before removal, then rebuild from the ordered sources as a whole entry or individually recorded leaves. Merely recursing into a directory copy would lose commit exclusions for the copied primary children after the parent digest changes.
- dest is a real dir (checkout-tracked or a prior conversion) → recurse per child over the union (existing semantics, generalized).
- dest is a foreign symlink or a file → untouched (checkout always wins), unchanged.

Intermediate REAL dirs the merge creates are NOT recorded in the manifest — precedent: the providerDir root itself is already an unrecorded real dir. Only leaves (links/copies) carry manifest entries + cleanup evidence. Commit delivery deliberately runs plain `git add -A`, audits and resets every forbidden overlay path from the index, then makes the literal exclusions authoritative with `git commit --only`; the release-time cleanliness inspection authenticates the leaves individually. A converted parent is explicitly removed from the manifest even if the merged directory happens to match one fallback root's complete superset digest.

## D3 — Evidence authentication accepts any configured root

`captureOverlayCleanupEvidence` / `revalidateOverlayCleanupEvidence` currently authenticate a manifest path against THE single source root (symlink target equality, or content-digest equality for copies). With multiple roots, a candidate authenticates when it matches ANY root's corresponding path. A prior-pass whole-dir link/copy converted by D2 is explicitly revoked from the manifest (it could still authenticate against a fallback root that contains the complete merged superset); its children re-enter as individually-recorded leaves — commit-exclusion coverage is preserved, never widened to paths no root can vouch for. `rail-worktree-release` consumes persisted evidence by digest only and needs no change.

## D4 — Explore mcp=true routes through the relocation gate

`_resolveSpawnCwd`'s `if (mcpEnabled) return this._cwd` predates relocation. The purpose of that branch is "spawn where `.mcp.json` is honoured" — for a relocated project that place is the WORKSPACE (`.mcp.json`, `.specrails/`, provider dirs all live there; the repo is reachable via `./project`). Routing through `resolveProjectExecution` gives exactly that with zero behaviour change for legacy projects (gate returns `cwd = project.path`). The resolved relocation env must travel with every spawn door, including persistent-stdin sessions and the one-shot crash respawn; otherwise cwd is correct but `${SPECRAILS_REPO_DIR:-.}` silently points at the workspace. This also makes the system-prompt instruction "write directly to .specrails/local-tickets.json" resolve to the REAL store instead of polluting the repo.

Claude stores resumable sessions per cwd, which creates one compatibility edge: an MCP-enabled Explore session created before this correction lives under the repo cwd and is invisible to `--resume` from the workspace. The recovery is deliberately narrow. Only the exact provider diagnostic `No conversation found with session ID` authorizes one retry of that user turn without `--resume`; the retry stays in the resolved workspace (it never falls back to the repo), invalidates the known-bad stored session id, and carries a bounded excerpt of persisted conversation history plus the current turn so continuity is preserved without replaying an unbounded transcript. Any other error follows the normal failure path, and the fresh retry itself is never retried again. The shim applies to both spawn-per-turn and persistent-stdin resumes; persistent mode evicts only the stale child, starts one fresh stream child, and otherwise preserves its existing lifecycle.

Contract Refine normally resumes the same Explore session and therefore first mirrors the exact relocation-aware cwd decision. If that resume returns the same exact missing-session diagnostic, Contract Refine also retries at most once as a fresh workspace invocation. Because the fresh process has no resumed conversation, its prompt is explicitly seeded with the target ticket context; it remains pure-output with `--tools __none__`. It must never use the repo as a compatibility cwd.

The `SPECRAILS_EXPLORE_LEGACY_CWD=1` kill switch is honoured before the relocation gate, preserving its documented force-`<project.path>` semantics. Consequently the fresh-workspace compatibility shim is relevant only when a relocated conversation is actually routed through the workspace; the explicit legacy-cwd escape hatch remains an opt-out from that route.

## D5 — What this change deliberately does NOT do

- No opsx in the framework bundle: opsx versions ride the external `@fission-ai/openspec` pin per project, not the app-bundled framework.
- No auto-cleanup of an existing stray `<repo>/.specrails/`: deleting repo content the app cannot prove it owns is riskier than the bug.
- No workspace-level opsx link for shared-cwd relocated spawns (non-isolated loop/job runs spawned from the workspace still lack `/opsx:*`): isolated worktrees are the only launch door for dashboard rails today; the workspace-assembly seam belongs to specrails-core and is deferred.
