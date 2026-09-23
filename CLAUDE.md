# Claude Code navigation

@AGENTS.md

`AGENTS.md` is the shared repository working guide. Follow its feature map,
module boundaries, behavior invariants and verification matrix.

Use progressive context: read the affected module's README and nearest tests,
then follow references as needed. Avoid loading the entire source index or
historical implementation notes for an unrelated change.

## Reference entry points

- [Architecture decision: modular monolith, SOLID and selective ports/adapters](docs/internals/modular-architecture.md)
- [Persistence/queue refactor and unused-source policy](docs/internals/source-architecture.md)
- [Project settings module: public API, ports, adapters and test commands](server/modules/project-settings/README.md)
- [Generated source/test map](docs/internals/source-map.md)
- [Contributor setup, coverage and packaging](CONTRIBUTING.md)
- [Internals index](docs/internals/README.md)
- [HTTP API](docs/internals/api-reference.md)
- [Configuration and feature flags](docs/internals/configuration.md)
- [Runtime contracts](docs/internals/programmatic-agent-runtime.md)
- [PR/recovery lifecycle](docs/internals/safe-pr-review-flow.md)
- [User documentation](docs/README.md)
- [Historical feature notes](docs/internals/legacy-implementation-notes.md)

Keep this file short. Put feature details in their domain guide and link them
from `AGENTS.md` or the internals index. Historical notes are reference material,
not a substitute for current source/tests or an additional instruction layer.
