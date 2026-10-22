## Context

The review packet is composed from durable rows (`settle_evidence`, spec snapshot, provenance, cost). Core 5.3 records the reviewer brief at every verdict; the brief is advisory and the approval gate never reads it.

## Decisions

### D1. Gate on the active Core capability, store inside `settle_evidence`

`coreAnnouncesReviewBrief()` probes `runtime api` (cached by the loader). Without `reviewBrief: 1`, the harvest never reads a brief and the persisted evidence is byte-identical. `settle_evidence` is a JSON text column, so the record rides on each unit (`reviewBrief`) and no migration is needed.

### D2. Source order per unit

1. `<pipeline>/<runId>/review-brief.json` (engine 1, rewritten at every verdict, approved or not).
2. Engine 2 committed scopes: `implementation` → `review.brief`, a reviewer `implementation-step`, or the selected reviewer role turn (`reviewerStepId`). Definition runs do not put the brief in `runtime-result`, and the child implementation pipeline directory is not addressable from Desktop, so the committed scope output is the durable source.
3. `confidence-score.json` → `brief` (approved verdicts; only when the raw file fits the existing 8 KB cap).

### D3. Tolerant normalization, never a throw

Every field is optional on the wire. Entries missing their key text or with an unknown severity are dropped and counted (`droppedEntries`); risks are re-sorted high → medium → low (stable) and capped at five; text is trimmed and bounded. An unreadable or unknown-version file becomes a record with a `diagnostic`, so the packet says the brief could not be used instead of silently hiding it. A thrown read marks the unit's harvest as errored, like the other sources.

### D4. Rendering

`whatToLookAt` merges units (each entry keeps `ticketId`, shown only for multi-ticket deliveries) and is `null` when nothing is listed and no diagnostic exists. The section sits right after the verdict block, before drift/versions/watch-out and the measured facts. File refs are plain monospace text: the packet links no files elsewhere and the Code explorer shows the base checkout, not the delivery branch, so a link could open a different version of the line.

### D5. PR body and cards stay short

The PR block lists only high and medium risks, untested paths and human checks (as an unchecked task list) under an "advisory, not a verification result" line. Cards get `riskSummary` (counts + top risk) derived from `settle_evidence` by a substring-guarded parse, so rows without a brief never pay for JSON parsing and their messages do not change shape.

## Risks / Trade-offs

- A run frozen on a newer Core while the active Core is older is gated off until the active Core is updated (heal then fills it). Accepted: the capability belongs to the active Core per the contract.
- `confidence-score.json` briefs larger than 8 KB are not read through that fallback; the pipeline record remains the primary source.
