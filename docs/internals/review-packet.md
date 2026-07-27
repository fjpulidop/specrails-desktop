# Review packet (as-built)

The plain-language review surface a non-technical person decides on. Fulfils the
open `safe-pr-workflow` requirement *"the builder reviews a plain-language
what-changed + proof bundle … SHALL NOT expose raw git vocabulary"*, which
shipped as a deferral in that change and is discharged here.

Change: `openspec/changes/nontech-review-experience` (Wave 1 evidence, Wave 2
packet, Wave 3 revisions + narration).

## Why it exists

At `on_review` the app used to ask "Create PR / Integrate locally / Discard" —
git vocabulary, offered to someone who cannot read a diff. Nothing told them
what was done, whether it was checked, or what it cost. The packet answers those
three questions from data the app already has, and reduces the decision to three
verbs.

## The honesty contract

This is the load-bearing design constraint, not a nicety. Three rules:

1. **Every claim carries its source.** `server/review-packet.ts` splits proof
   into three tiers and the tier travels with the item so the UI must label it:

   | Tier | Source | UI framing |
   |---|---|---|
   | `app-verified` | Specrails measured it (diff stats, changed test files, commits recorded) | facts |
   | `ai-reported` | the agent said so (`VERIFICATION: PASS` sentinel, verify output) | "the AI reports … Specrails did not run these checks itself" |
   | `reviewer-score` | `sr-reviewer`'s own `confidence-score.json` | "the AI grading its own work — not an independent review" |

2. **No numeric verification claim without a structured source.** There is no
   structured test-count anywhere in the pipeline today (`loop_step_end.exitCode`
   is `null` by contract for ai-steps; the PR body's Tests section is test FILE
   paths). So the packet never prints "68 tests passed". Verify prose is carried
   verbatim inside a labelled `rawExcerpt` block instead, and
   `packetHasUnsourcedNumericClaim` guards the invariant in tests.

3. **Absence renders as absence.** No reviewer score → "No reviewer score", not
   silence that reads as approval. No test files touched → an explicit "No test
   files were changed." Harvest failure → an `evidence unavailable` badge.

## Data flow

```
launch ──► rail_pr_deliveries INSERT
             └─ spec_snapshot  (migration 56): title/description/labels FROZEN
                                so "what you asked" cannot drift when the spec
                                is edited mid-run

settle ──► harvestDeliveryEvidence()   ← BEFORE any releaseRailWorktrees call
             ├─ VERIFICATION sentinel  (regex precedent: rail-merge-orchestrator)
             ├─ verify output tail     (≤4 KB)
             └─ confidence-score.json  (read from the still-mounted worktree)
             └─ settle_evidence (migration 56)

GET /rails/pr-deliveries/:id/packet
      ├─ composeReviewPacket()   pure, zero model calls, reproducible
      └─ resolveAcceptCapability()  git remote + `gh auth token`
```

Nothing in the read path re-reads a mutable store, spawns a model, or writes.
Composing the same delivery twice returns an identical document.

## Variants

Chosen from durable outcomes only (`selectVariant`), because the failure and
nothing-changed cases are exactly where a non-technical user is most abandoned:

- `success` — work is ready.
- `no-changes` — the first-class `no_changes` settle outcome. Never rendered by
  a template that implies changes; offers acknowledge + revise, never discard.
- `partial` — "N of M ready", per-ticket sections from durable per-unit outcomes.
- `failed` — what was attempted and why it stopped, with one primary next action.

## Decision verbs

`client/src/lib/packet-verbs.ts` maps the FULL delivery state space (12
decisions × 9 actions × orthogonal outcome/status axes ≈ 14 presentation states)
onto Accept / Request changes / Discard — and marks every state where that
reduction would lie as `fineControlOnly`. Those states (the recovery family, a
closed PR, a degraded draft) render the existing `RailPrDecisionStrip` controls
instead of a friendly relabel of git work. The module header carries the full
table; `resolvePacketVerbs` is total, defaulting to `fineControlOnly` rather
than guessing.

**Accept declares what it physically does.** `server/accept-ladder.ts`
pre-resolves the ladder from shipped probes (`git remote`, offline
`gh auth token`) and fails CLOSED to `merge-local`:

- remote + authenticated gh → Accept = create the PR (reviewable, reversible).
- otherwise → Accept = write into the user's own checkout, and the page ALWAYS
  interposes a plain-language consequence confirm first ("no separate review
  copy … cannot be undone").

Decisions execute through the existing `useRailPrDecisions().act()` +
`rail.pr_state` broadcast + authoritative POST-response snapshot. The packet
holds no optimistic state; a raced answer surfaces the neutral
"someone already answered this".

## Surfaces

- Routed page `/review/:prDeliveryId` (`client/src/pages/ReviewPacketPage.tsx`) —
  chosen over a portal so the documented z-order ladder is irrelevant.
- Entry points: a `Review` button on the rail strip's `on_review` row and on the
  agent-chat PR card. Both keep their precise git actions.
- Layout is an inverted pyramid: verdict + confidence + cost + verbs above the
  fold; the sections are progressive disclosure below.
- "Discuss this delivery" deliberately routes into the existing agent chat
  rather than adding a second Q&A brain (see the change's design D5).

## Revisions (Wave 3)

"Ask for changes" is a sentence, not a new commission.

**The launch door.** `prDeliveryRevisionAllowed` (`rails-router.ts`) is the ONE
exemption to the pending-decision 409, and it is deliberately strict: the launch
must name the rail's ACTIVE generation, that generation must be non-terminal, and
the rail must still cover its exact ticket set. Anything else keeps the existing
409; a wrong id gets a distinct `invalid_revision_target` so the caller learns
what to fix. `launch_all` deliberately does NOT get the exemption — a batch
fan-out must never silently revise.

**Revisions are generations, not a new state.** A revision creates a NEW delivery
row that supersedes the one it revises (migration 57 adds `revision_note` +
`revision_of`). No new `decision` value exists, because an unknown decision makes
older clients drop the whole PR card — and supersession already means "a newer
attempt replaced the previous one". Version lineage, crash-restore and
one-active-generation-per-rail all come free from the shipped machinery.

**The loop.** `factory:revision` is the fourth factory loop: `{{cmd:revise}}` (a
distilled step that applies the one requested change on top of the branch and
then runs `sr-reviewer` over the resulting diff, so packet v2 keeps its reviewer
tier) followed by the standard `{{cmd:verify}}`. No Architect step — the plan and
the code already exist. It is resolvable by id but deliberately NOT listed in the
public catalog: its prompt consumes `{{const:REVISION_REQUEST}}`, which only a
revision launch injects. The router forces this loop for any revision whatever
the rail's stored mode is; without that, every tweak would re-run implement.

**Fresh session by contract** (`server/revision-seed.ts`). The run is seeded from
durable state — the instruction, the frozen spec, the branch that carries the
work, and what the previous run actually REPORTED (failure first). `--resume` of
the prior session is not attempted: sessions are cwd-scoped to a released
worktree, `jobs.session_id` holds the final step's session rather than the
developer's, and every shipped recovery path in this codebase already prefers
fresh + durable. The branch carries the work; the seed carries the intent.

**Drift nudges, not limits.** `computeDriftNudges` fires on real measurements —
cumulative revision cost above half the original build, churn landing mostly
outside the original file set, or a revision-count backstop — and the banner
shows its own numbers. It never blocks another revision. A bare count was
rejected: it treats a 40-cent typo fix and a nine-dollar thrash identically.

## Known limitations

- **Batch attribution.** `file_story_contributions` keys files to a run's
  primary ticket, so when one run covers several tickets the per-section churn is
  `null` and the delivery-level total is shown instead. Splitting it would invent
  precision.
- **No revision duration estimate.** Nothing is promised until real
  revision-run history exists (the honest-ranges rule applies to our own
  marketing numbers too).
- **No structured test counts** until the parallel specrails-core ask lands
  (counts emitted into `confidence-score.json`). When it does, the composer's
  tier-1 branch picks them up and the claim becomes app-verified.

## Flags

- `SPECRAILS_REVIEW_PACKET=false` → the packet route 404s.
- `VITE_FEATURE_REVIEW_PACKET=false` → the route and both entry points vanish.
- `SPECRAILS_DELIVERY_REVISIONS=false` → the revision exemption disappears and
  every launch against an undecided delivery 409s exactly as before.

Any flag off leaves the existing decision strip byte-identical.
