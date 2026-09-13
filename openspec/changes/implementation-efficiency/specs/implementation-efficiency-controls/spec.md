## ADDED Requirements

### Requirement: Explicit role configuration survives launch
Desktop SHALL preserve project per-role selections when there is no selected launch provider. A provider selected for a new launch (request, stored rail, or Mission conversation selection) SHALL apply to architect, developer and reviewer, with recorded provenance. Explicit launch model/effort SHALL apply to every role, and incompatible settings from a different provider/model SHALL be cleared. Global settings MUST NOT be mutated.

#### Scenario: No launch provider is selected
- **WHEN** a job starts with project role settings and only incidental engine defaults
- **THEN** explicit role provider/model assignments remain unchanged in the frozen Core request

#### Scenario: User launches with Codex
- **WHEN** Codex is selected for an Implement or Batch Implement launch through Mission, Board or a saved rail
- **THEN** all three runtime roles use Codex
- **AND** the complete effective request records the selection source and validates each model/effort
- **AND** the same rule applies without Git worktree isolation

#### Scenario: Resume after changing the selected provider
- **WHEN** an existing job is resumed after a different provider is selected
- **THEN** the job retains its original frozen configuration
- **AND** changing providers requires a new launch

### Requirement: Configuration edits preserve supported metadata
Desktop SHALL round-trip every supported verification field and optional efficiency/role field through client, server, persistence and admission without lossy row conversion. Existing frozen requests MUST remain immutable.

#### Scenario: User edits the label of a configured check
- **WHEN** its original record also contains cwd, env, timeoutMs and host policy
- **THEN** saving and launching preserve those unedited fields and stable check identity

#### Scenario: Identical checks are reordered
- **WHEN** a user reorders distinct rows with identical command definitions
- **THEN** optional host keys preserve row identity and metadata while Core handles semantic execution deduplication independently

### Requirement: Controls reflect actual negotiated support
Desktop SHALL expose optional effort and a single same-provider escalation tier in existing role rows, with no duplicate verifier role or provider-specific settings copies. Unsupported requested capabilities SHALL fail before provider invocation; omitted effort SHALL remain provider default.

#### Scenario: Old Core reports only runtime API1
- **WHEN** capability metadata is absent
- **THEN** ordinary supported behavior remains available and new controls explain their unavailability
- **AND** a requested new policy cannot silently run as if enforced

#### Scenario: Feature flag exists but installed transport effort is unknown
- **WHEN** the read-only capabilities query returns unknown effort support for the selected role transport
- **THEN** the form does not offer values inferred from a legacy provider catalog and explains the limitation

#### Scenario: Provider selection invalidates an effort value
- **WHEN** a user changes the role provider to an incompatible transport
- **THEN** the incompatible dependent selection is clearly reset or marked invalid before save
- **AND** it is never silently interpreted as another effort value

### Requirement: Efficiency defaults remain conservative
Desktop SHALL use the Core-defined normalized defaults only for new capable v5 admissions. Escalation SHALL remain unset, reuse SHALL remain never absent an explicit host policy, and concurrency SHALL default one with a maximum four.

#### Scenario: User requests concurrency four without independence declarations
- **WHEN** the host check definitions do not declare eligible independent repositories
- **THEN** the UI explains that Core will still serialize those checks
- **AND** Desktop does not fabricate independence or reuse guarantees

### Requirement: Saved jobs use frozen configuration and original runtime
Desktop SHALL store immutable runtime identity at admission, resolve retained runtimes for continuation, and preserve original settings across global/project edits. It MUST NOT guess legacy package identity or rewrite frozen inputs for compatibility.

#### Scenario: Runtime and role settings change before continuation
- **WHEN** a saved v5 job is resumed
- **THEN** its original proven runtime and frozen configuration are used, including escalation tier and evidence state

#### Scenario: An original v4 runtime is available
- **WHEN** trustworthy provenance resolves the saved request to its original package
- **THEN** Desktop resumes with that package and leaves the original checkpoint intact

#### Scenario: Original legacy runtime cannot be established
- **WHEN** no reliable package identity or tested resolution exists
- **THEN** Desktop preserves history, explains original-runtime recovery and prevents an incompatible paid launch

### Requirement: Production pins prove package compatibility
Desktop SHALL validate contracts from the actual Core package and update release workflow and assembly lock pins together after the verified package is available. Source assembly MUST NOT substitute for the production package test.

#### Scenario: Sibling source exposes a capability missing in the pinned package
- **WHEN** package-based smoke tests run without the sibling checkout
- **THEN** the compatibility gate fails and Desktop cannot claim that feature is ready to release
