# Local agent runner (internals)

Contract for `local-runner/` — the bundled process that makes an
OpenAI-compatible endpoint behave like an agentic CLI for every Desktop spawn
site. OpenSpec change: `local-ai-engines`.

## Packaging

- Source `local-runner/src/`, bundled by `scripts/build-local-runner.mjs`
  (esbuild, CJS, node20, SDK bundled) to `local-runner/dist/specrails-local-runner.js`
  and copied to `src-tauri/binaries/specrails-local-runner.js` (listed in
  `tauri.conf.json` `bundle.resources`). Same pattern as `specrails-mcp`.
- Spawned by `server/providers/local-adapter.ts` with the bundled Node
  (`resolveBundledNodeExe()` → `node` fallback), argv `[<script>, ...flags]`,
  through `windowsSpawnEnv` + cross-spawn on Windows (pkg sidecar trap: never
  `process.execPath`).
- Script resolution order mirrors the MCP bridge: `src-tauri/binaries/…` then
  `local-runner/dist/…` (dev).

## Argv

| Flag | Meaning |
|---|---|
| `-p <prompt>` | one-shot prompt (absent in persistent mode) |
| `--model <id>` | model id sent verbatim |
| `--base-url <url>` / `--api-key-env <NAME>` | endpoint + env var holding the bearer key |
| `--resume <sessionId>` | load a stored session |
| `--system-prompt` / `--append-system-prompt` | replace / extend the system message |
| `--tools <csv|__none__>` / `--disallowedTools <csv>` | tool policy |
| `--max-turns <n>` | tool-loop bound (`result.is_error` + `reason: max_turns`) |
| `--mcp-config <file>` | claude-shaped `{ mcpServers }` stdio servers |
| `--add-dir <path>` (repeatable) | extra confinement roots |
| `--output-format stream-json` | required |
| `--input-format stream-json` | persistent multi-turn over stdin |
| `--reasoning-effort <v>` | forwarded as OpenAI `reasoning_effort` |

Unknown flag ⇒ `unknown flag: X` on stderr, exit 2, no network call.

## Frames (stdout, one JSON per line)

```
{ "type":"system", "subtype":"init", "session_id":"…", "model":"…" }
{ "type":"assistant", "message":{ "id":"<per API call>", "role":"assistant",
    "content":[{ "type":"text", "text":"<delta>" }],
    "usage":{ "input_tokens":N, "output_tokens":N } } }
{ "type":"assistant", "message":{ "id":"…", "content":[{ "type":"tool_use", "id":"call_1", "name":"Read", "input":{…} }], "usage":{…} } }
{ "type":"user", "message":{ "content":[{ "type":"tool_result", "tool_use_id":"call_1", "content":"…", "is_error":false }] } }
{ "type":"result", "subtype":"success", "is_error":false, "num_turns":2, "duration_ms":1234,
  "usage":{ "input_tokens":N, "output_tokens":N }, "session_id":"…", "result":"<final text>" }
```

`total_cost_usd` is never emitted. `message.id` is stable per API call so the
adapter's per-message usage dedup (the claude precedent) sums one row per call.
Diagnostics go to stderr only. The adapter (`local-adapter.ts`) owns its own
`parseStreamLine` — a copy of the claude frame mapping WITHOUT the
notification-frame / background-task heuristics — so a claude parser change
can never silently break local engines.

## Tool loop

`POST <baseUrl>/chat/completions` with `stream:true`, the message history and
OpenAI `tools` definitions for the enabled set. SSE deltas are assembled
(`tool_calls` fragments by index). Each completed call executes and appends a
`tool` message; the loop ends when the model returns no calls or `--max-turns`
is hit. Malformed argument JSON ⇒ error `tool_result` back to the model (small
models self-correct). Context-length errors ⇒ evict the oldest tool-call/result
pairs (never the system prompt nor the latest user turn), retry once, then fail
with the endpoint message. `429` bodies pass through verbatim so
`classifyProviderLimit` recognises them.

Built-in tools (claude-compatible schemas): `Read`, `Grep`, `Glob`, `Bash`,
`Write`, `Edit`. Filesystem paths are realpath-confined to `cwd` + `--add-dir`
roots. `Bash` runs via `/bin/sh -c` (`cmd.exe /d /s /c` on win32), 10-minute
cap, 64 KB captured output. Policies: `__none__` sends no tools; a csv
restricts; `--disallowedTools` subtracts from the default set. There is no
permission prompt — the policy IS the permission model.

Slash commands: a prompt starting with `/<name>` resolves
`<cwd>/.claude/commands/<name with ':'→'/'>.md`; its body becomes the system
tail with `$ARGUMENTS` substituted. Missing file ⇒ `Unknown command: /<name>`
(the same failure semantics kimi has).

## Small-model tolerances (local engines only)

- Assistant messages carrying `tool_calls` are sent with `content: ""` — never
  `null` (llama.cpp: `invalid message content type: <nil>`).
- A tool turn that ends with an EMPTY final message is nudged once
  (`EMPTY_REPLY_NUDGE`, an extra user message asking for the plain-text reply);
  a second empty reply settles as an empty non-error result.
- Desktop side: `agent-fence-promotion.ts` (client ⇄ server twins) re-tags a
  closed ```` ```json ```` fence with an `options` / `problem-frame` /
  `spec-draft` shaped body, gated on the conversation provider being a local
  id, and the per-turn context prefix restates the fence-tag + no-`#noframe`
  rules. CLI providers are untouched.

## Sessions

`$SPECRAILS_LOCAL_RUNNER_HOME` (default `~/.specrails/local-runner`)
`/sessions/<uuid>.json`, mode 0600, LRU-capped at 200. Missing session on
`--resume` ⇒ `result { is_error:true, result:"No conversation found with session ID: <id>" }`
— the exact diagnostic the Explore recovery path matches.

Persistent mode reads `{ "type":"user", "message":{ "content": … } }` lines
from stdin, one turn per line, one `result` per turn, exit 0 at stdin end.
Errors keep the process alive in this mode.

## MCP

`--mcp-config` servers are started with the SDK stdio `Client`; tools are
exposed as `mcp__<server>__<tool>` (claude naming, so the operator prompt and
activity chip work unchanged). A server that fails to start is logged and
skipped. `agent-mcp-config.ts` `prepareAgentMcp` has a `local` branch writing
the same per-conversation file it writes for claude (bridge + enabled external
servers); `SPECRAILS_AGENT_CONVERSATION` and the tier header ride `entry.env`.

## Desktop wiring

- Registry: `local-adapter-registry.ts` `syncLocalAdapters(connections)` at boot
  and after `PUT /runtime-providers`; `registry.unregisterAdapter` never removes
  CLI adapters; in-flight jobs keep the adapter instance they resolved.
- Detection: `local-engine-detection.ts` `probeConnection` (`GET /models`,
  3000 ms, no redirects, Bearer from env; 2xx ⇒ authenticated + models, 401/403
  ⇒ unauthenticated, else unreachable) inside the 60 s provider-detection cycle;
  `modelCatalog()` reads the cache.
- Selection: `validateRequestedProvider` accepts detected local ids; primary
  derivation never prefers a local id over a detected CLI.
- Rails: local engine ⇒ `runtimeProviderOverride { provider, model }` for all
  three core roles (core's `OpenAICompatibleExecutor`); non-core ai-steps spawn
  the runner; deciders use `--tools __none__`; no profile env, no OTEL, no
  plugins snapshot (capability-gated).
- Accounting: `result-event.ts` — rates ⇒ estimated cost, else `NULL`; never a
  rate-card guess.
- Kill switch `SPECRAILS_LOCAL_ENGINES`.

## Verification

`local-runner/src/__tests__/` runs the runner against an in-process fake SSE
server. `server/providers/__fixtures__/local-runner-transcript.jsonl` is fed
through the adapter to pin the `AdapterEvent[]` shape. Manual smoke record (2026-09-14, endpoint `http://192.168.68.74:8080/v1`,
`qwen3.5-9b:latest`, Ollama behind an OpenAI-compatible proxy):

- Runner one-shot with `--tools Read,Grep,Glob`: `system/init` → `Read`
  tool_use → tool_result → streamed text → `result { num_turns: 2, usage:
  { input_tokens: 1210, output_tokens: 132 } }`, exit 0.
- `--resume <id>` + `--input-format stream-json`, two user lines: two
  `result` frames on the same session id, prior-turn memory intact, exit 0.
- Dev server: `[local-engines] registered: local` at boot;
  `POST /api/runtime-providers/test` ⇒ reachable, authenticated, both models,
  20 ms; `GET /api/providers/detected?refresh=1` ⇒ `local` usable with models.
  The very first boot probe timed out under startup congestion — the probe
  bound was raised 1500 → 3000 ms as a result.
- Pending: in-app UI pass (Settings card, rail/Add Spec/chat selectors, a
  full implement rail on the local engine).
