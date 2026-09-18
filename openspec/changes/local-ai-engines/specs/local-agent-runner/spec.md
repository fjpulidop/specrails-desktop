## ADDED Requirements

### Requirement: Runner is bundled and spawned like a CLI
The app SHALL ship `local-runner/` compiled by `scripts/build-local-runner.mjs` to `src-tauri/binaries/specrails-local-runner.js`, listed in `tauri.conf.json` `bundle.resources` and `package.json` `files`, built by `build`, `build:desktop`, `dev:desktop:prepare`, and type-checked by `typecheck`. The local adapter SHALL spawn it with the bundled Node (`resolveBundledNodeExe` + `windowsSpawnEnv` + cross-spawn on Windows) and argv `[<script>, ...args]`.

#### Scenario: Packaged spawn on Windows
- **WHEN** the packaged sidecar spawns the runner on Windows
- **THEN** the executable is the bundled `node.exe`, the env carries `SystemRoot`, and the first argv entry is the runner script path

### Requirement: Runner argv contract
The runner SHALL accept: `-p <prompt>` (or the prompt on stdin when `--input-format stream-json`), `--model <id>`, `--base-url <url>`, `--api-key-env <NAME>`, `--resume <sessionId>`, `--system-prompt <text>`, `--append-system-prompt <text>`, `--tools <csv|__none__>`, `--disallowedTools <csv>`, `--max-turns <n>`, `--mcp-config <file>`, `--add-dir <path>` (repeatable), `--output-format stream-json`, `--input-format stream-json`, `--reasoning-effort <value>`. Unknown flags SHALL exit 2 with a one-line stderr diagnostic before any network call.

#### Scenario: Unknown flag fails fast
- **WHEN** the runner is started with `--bogus`
- **THEN** it exits with code 2 and prints `unknown flag: --bogus` on stderr with no HTTP request

### Requirement: Runner emits claude-shaped stream-json
Each turn SHALL emit, one JSON object per line on stdout: a `system` frame `{ type:'system', subtype:'init', session_id, model }` first; `assistant` frames `{ type:'assistant', message:{ role:'assistant', content:[{type:'text',text}|{type:'tool_use',id,name,input}], usage:{ input_tokens, output_tokens } } }` (text streamed as incremental `assistant` frames carrying the delta); `user` frames `{ type:'user', message:{ content:[{ type:'tool_result', tool_use_id, content, is_error }] } }` after each tool; and exactly one terminal `result` frame `{ type:'result', subtype:'success'|'error', is_error, num_turns, duration_ms, usage, session_id, result }`. `total_cost_usd` SHALL never be emitted. Non-JSON diagnostics go to stderr only.

#### Scenario: Frames parse into adapter events
- **WHEN** a recorded runner transcript is fed through `localAdapter.parseStreamLine`
- **THEN** the events are `init(sessionId)`, `assistant(text)`, `tool_use(name,id,inputPreview)`, `tool-result(toolId)`, `result(numTurns, usage, isError:false)` in order

### Requirement: Streaming chat-completions tool loop
The runner SHALL call `POST <baseUrl>/chat/completions` with `stream: true`, the message history, and OpenAI `tools` definitions for the enabled tool set; SHALL parse SSE deltas (text and `tool_calls` fragments assembled by index); SHALL execute each completed tool call and append the `tool` role result; SHALL stop when the model returns no tool calls or `--max-turns` is reached (then `result.is_error: true` with `reason: 'max_turns'`). A malformed tool-call argument payload SHALL be returned to the model as an error `tool_result`, never crash the loop. A context-length error from the endpoint SHALL trigger ONE retry after evicting the oldest tool-call/result pairs; a second failure is a `result` error carrying the endpoint message.

#### Scenario: Two-step tool turn
- **WHEN** the model answers with a `Read` tool call then a final text
- **THEN** the runner emits `assistant(tool_use)`, executes Read, emits `user(tool_result)`, re-calls the endpoint, emits the text and `result { num_turns: 2 }`

#### Scenario: Malformed tool arguments
- **WHEN** the model emits `tool_calls[0].function.arguments = '{"path": '`
- **THEN** the runner emits a `tool_result` with `is_error: true` describing the parse failure and continues the loop

### Requirement: Built-in tools and policies
The runner SHALL implement `Read`, `Grep`, `Glob`, `Bash`, `Write`, `Edit` with claude-compatible input schemas. `--tools __none__` SHALL send no tools; `--tools <csv>` SHALL restrict to that set; `--disallowedTools <csv>` SHALL remove those from the default set. Every filesystem tool SHALL resolve paths against `cwd` and the `--add-dir` roots and SHALL reject paths outside them with a tool error. `Bash` SHALL run via the platform shell with a 10-minute cap and a 64 KB captured-output cap, inheriting the runner env.

#### Scenario: Read-only policy blocks writes
- **WHEN** the runner starts with `--tools Read,Grep,Glob` and the model calls `Write`
- **THEN** no `Write` tool definition was sent, and the unknown-tool call is answered with an error `tool_result`

#### Scenario: Path confinement
- **WHEN** the model calls `Read { path: '../../etc/passwd' }` from a cwd without that root
- **THEN** the tool returns an error naming the confinement and the file is not read

### Requirement: Sessions, resume and persistent stdin
Sessions SHALL persist to `~/.specrails/local-runner/sessions/<uuid>.json` (mode 0600, LRU-capped at 200) after every turn. `--resume <id>` SHALL load the message history; a missing session SHALL emit `result { is_error: true, result: 'No conversation found with session ID: <id>' }` (the same diagnostic the Explore recovery path matches). With `--input-format stream-json` the process SHALL stay alive, read one `{ type:'user', message:{ content } }` per line, run one turn per line, emit a `result` per turn, and exit 0 on stdin end.

#### Scenario: Persistent multi-turn
- **WHEN** two user lines are written to stdin
- **THEN** two `result` frames are emitted with the same `session_id` and the process exits 0 after stdin closes

### Requirement: MCP client
With `--mcp-config <file>` the runner SHALL start every `mcpServers` stdio entry with the SDK client, list their tools, and expose them to the model as `mcp__<server>__<tool>`; tool results SHALL flow back as `tool_result` frames. A server that fails to start SHALL be logged on stderr and skipped; the turn continues with the remaining tools.

#### Scenario: Bridge tools exposed
- **WHEN** the config lists the `specrails` bridge
- **THEN** the tool list sent to the model includes `mcp__specrails__specrails_specs`

### Requirement: Errors are surfaced as frames, never silent
HTTP errors (4xx/5xx), non-SSE bodies, connection failures and timeouts SHALL end the turn with `result { is_error: true, result: <message> }` on stdout and a non-zero exit code (1) in one-shot mode; in persistent mode the process SHALL stay alive for the next turn. Rate-limit (`429`) bodies SHALL be passed through verbatim so `classifyProviderLimit` can recognise them.

#### Scenario: Endpoint down
- **WHEN** the base URL refuses connections
- **THEN** stdout carries a `result` error naming the connection failure and the exit code is 1
