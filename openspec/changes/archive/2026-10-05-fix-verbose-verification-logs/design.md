## Context

The runtime bridge forwards raw events to persistence and separately projects human-readable verification output. Its existing filter understands TAP and Node's spec reporter, but Jest passing-suite lines and repeated console stack traces are unbounded. Client job views also cap event arrays by keeping the tail, which can discard earlier loop boundaries.

## Goals / Non-Goals

**Goals:** Keep verification readable under very large output; retain bounded failure context and test totals; expose real command outcomes when structured check events exist; preserve lifecycle visibility and raw evidence access.

**Non-Goals:** Change commands, acceptance, fingerprints, retries, upstream tests, raw evidence retention policy or historical persisted records.

## Decisions

- Compact the Desktop presentation projection, preserving original runtime events and their existing evidence path. Changing upstream reporters or dropping process output would reduce diagnostic evidence and affect user repositories.
- Apply bounded budgets with reserved space for diagnostics and totals. Compact passing-suite and console noise; clearly signal omitted output. Keep generic handling for unknown reporters, independent streams and repeated verification attempts.
- Use validated structured check lifecycle data for command outcomes when available, with compatibility for older event streams. Advisory display never controls settlement.
- Keep lifecycle markers visible when the client bounds a job log and avoid letting invisible raw verification frames crowd out readable entries. Raw records remain available through existing persistence and evidence APIs.
- Carry the original optional attempt ID through readable log callbacks, persistence and live frames. The existing loop model can then associate delayed summaries with their original parallel attempt; legacy output keeps its existing fallback.
- Cover a large synthetic stream and the actual bridge/client paths. Use generic fixtures rather than user repository names, tokens or private source.

## Risks / Trade-offs

- Compaction could hide useful diagnostics → reserve diagnostic/summary budgets, retain evidence, show omission notices, and test late failures after warning floods.
- Interleaved or repeated checks could share presentation state → scope state to invocation/stream or check execution where identifiable and test reset/isolation.
- Raw evidence has existing storage/window limits → document those limits instead of claiming infinite complete retention.
- Client retention could distort loop grouping → preserve boundary events and test live append versus initial replay.
