## Context

Ticket-keyed mounts and branch reuse currently transfer unfinished edits between unrelated launches. Revision identity includes runId, and overlay cleanup authentication is also used as a commit-exclusion list, so provider switches can lose exclusions. Delivery settlement is the owner of Git publication; Core correctly archives only its own change.

## Goals / Non-Goals

**Goals:** Preserve all previous work while isolating fresh allocations; allow exact recorded delivery continuations; reject active planning residue and external links; make delta names stable across equivalent retries.

**Non-Goals:** Modify the reported third-party PR, delete old changes, reset dirty worktrees, auto-archive foreign changes, change Core acceptance gates or rewrite retained execution snapshots.

## Decisions

- Fresh allocations use a run-specific mount and collision-free new branch. Prior mounts and branches remain available through the existing ledger. Exact recorded revision/PR branches can reuse their mounted checkout; recovery continues using the frozen original mount. This avoids destructive cleanup and new archive transaction ownership.
- Settlement compares active change directories against its frozen Git baseline before staging. Newly introduced active changes block commit with an actionable existing commit-failure status. Base changes and valid archives remain allowed. Git/inspection failures fail closed.
- Index audits reject deliverable external absolute symlinks, including overlay links missing from the manifest. Existing literal exclusion and private-path protections remain intact.
- Provider-switch manifest entries authenticate against configured source roots across supported provider namespaces. Cleanup fingerprints stay narrow; commit exclusions retain authenticated prior ownership even when a copied file has changed.
- Revision admission requires durable delivered work. A failed generation without delivered work can be replaced by a fresh addendum launch through atomic generation supersession without a revision briefing. Addendum claims retain their full frozen bodies.
- Seed identifiers reuse an active declared change. Otherwise readable delta names hash durable revision/addendum identity instead of runId and obey Core's lowercase kebab-case 64-character limit.

## Risks / Trade-offs

- Preserved old mounts consume disk space → existing explicit recovery/discard cleanup remains available; no automatic data loss.
- New custom loops may intentionally leave an active change → delivery blocks with a clear path list instead of publishing incomplete planning state.
- Existing contaminated PRs cannot be repaired by allocation isolation → manual review remains separate.
- Historical runtime snapshots retain their original paths and prompts → apply the fix to fresh launches; do not rewrite retained jobs.
