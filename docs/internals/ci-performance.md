# CI and release execution

The required `test` check waits for quality, both complete coverage reports,
workflow and secret checks, bundled Core, provider portability and native macOS
fixtures. Failed, cancelled or skipped prerequisites cannot authorize a release.
Main/branch push CI remains available for exact-source release admission; pull
request checks do not substitute for trusted push evidence.

## Coverage partitions

Server coverage runs on three workers, each using one Vitest process as before.
Client coverage runs on four workers. Every worker uses the locked Vitest version
and its public `--shard` option; no test filters or coverage exclusions are added.
`vitest.shard.config.ts` collects partial coverage without evaluating global
thresholds. The mandatory merge jobs use the ordinary configuration and enforce
all original thresholds on the combined coverage, including uncovered files.

`scripts/coverage-shards.mjs` records the actually executed files, complete test
inventory, commit, dependency/configuration digest, Vitest version and SHA-256 of
each blob. Before merging, it rejects missing shards, overlapping or omitted
files, unsuccessful reports, mixed identities and changed bytes. A real two-shard
fixture proves complete coverage passes and an uncovered function fails the
aggregate. A list-only command is not used to infer shard assignment: Vitest's
file listing includes the complete corpus even when a shard is requested.

To reproduce a server shard and merge downloaded artifacts:

```sh
node scripts/coverage-shards.mjs run server 1/3 /tmp/server-shard-1
node scripts/coverage-shards.mjs merge server 3 /tmp/downloaded-server-shards
```

Merge input must contain all three `.manifest.json` and `.blob.json` pairs from
one commit. Use `client 1/4` and `client 4` for the client. Normal local
`test:coverage` commands retain their existing behavior.

## Verified frontend reuse

The quality job builds and package-checks the application, then uploads
`verified-desktop-client`. It contains the platform-independent production
frontend plus its commit, client lock digest and complete asset inventory with
individual checksums. Production Vite URLs are relative and contain no runner or
platform-specific endpoint.

Release admission selects the latest successful trusted push CI attempt for the
exact source SHA. A shared release job verifies and republishes that run's frontend.
If the artifact expired or predates receipts, it rebuilds the exact admitted source
once. API, identity and checksum failures remain failures; they never trigger a
rebuild fallback. Each native job checks the shared bytes before restoring them,
then builds its own platform-specific server, sidecars
and Rust shell. The three native jobs reuse the same frontend; each still signs,
notarizes where configured, and performs installed-application smoke checks.
`build:desktop` continues to build from source for local development.

## Measuring improvements

The previous completed run `36228425753` took 15m50s including queue time; client
coverage ran for 10m53s and server coverage for 7m07s. The final check waited almost
five minutes for a runner. Compare critical-path execution and queue time
separately; more partitions reduce work per runner but cannot eliminate host
queueing. Blob manifests retain start/end and test counts for subsequent tuning.
Updated run `36230773446` passed every check. Server shards took 2m12s–2m56s
and client shards 2m52s–3m24s; each aggregate took 37s. Including queueing,
the run took 22m52s, so this loaded-run comparison does not demonstrate a total
wall-time reduction. Preserve both measures when adjusting worker counts.
