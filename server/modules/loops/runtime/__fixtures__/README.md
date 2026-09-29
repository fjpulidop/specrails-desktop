# Core v2 transport recording

`core-v2-events.jsonl` was emitted by the actual built Core engine and LangGraph,
using a deterministic local executor. It records a two-branch map, a question,
and resume including replay of committed events. It is contract test data, not
provider billing or rollout telemetry. The companion metadata records the Core
commit, physical call count, phase boundary, final cursor and authoritative usage.

Regenerate after building the paired Core checkout:

```sh
SPECRAILS_CORE_SOURCE_DIR=/path/to/specrails-core node scripts/generate-core-event-fixture.mjs
```

Use Core's supported Node version. The generator uses a disposable Git repository
and makes no external provider calls. Only the temporary root path is redacted;
identities, timestamps, usage and topology remain as emitted. Generation asserts
that the run pauses then succeeds and executes exactly two provider invocations.
`loop-definition-events.test.ts` compares Desktop projection with these recorded
Core totals, including restart replay, branch identities, integer allocation and
unknown billing. Regeneration changes UUIDs/timestamps and must be reviewed.

## Real host/Core crash acceptance

`loop-crash-worker.mjs` runs the production Loop Manager, executors, retained
Core package and disk project database in a separate host process. The parent
kills its owned process tree during a read, partial write, human pause or between
committed nodes and
starts another host. The provider preload isolates the fixture home and replaces
only the AI executor; no paid CLI/network call is made. Production lease TTLs
remain unchanged, and write recovery uses the attempt returned by Core status.

The paired test invalidates current project settings before restart, resumes the
frozen request, independently verifies repository contents and replays all
durable events twice. Interrupted calls remain counted with unknown usage; the
human answer produces exactly one additional invocation. Every process and
temporary repository belongs to that test and is cleaned up on failure.
