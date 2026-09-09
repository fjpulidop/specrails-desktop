# For agents only: connect to Specrails MCP

Use this runbook when a person asks Claude, Codex, Kimi or Gemini to connect to Specrails. Complete discovery, registration and a read-only verification for the requested client. Do not configure all four clients unless asked. If the tools are already loaded, test the existing connection before changing anything.

This is an external agent connecting to Specrails Desktop. It is separate from choosing an AI provider inside Specrails. Connection authorization does not authorize starting missions, creating specs or changing permission tiers. If local files or the client configuration are inaccessible, complete the available checks and report the exact remaining step.

## Discover the local bridge

Keep **Specrails Desktop running on the same machine** and enable MCP in **Settings ▸ MCP**. Use the stdio bridge bundled with Desktop: it reads `~/.specrails/mcp.token` locally. Do not paste tokens into prompts, logs or configuration. This setup does not require the separate legacy `specrails-mcp` npm package or its hub.

1. Inspect the requested client's existing `specrails` entry locally (for Codex, `codex mcp get specrails`). If it already points to the installed bridge, keep it. Preserve every other server and setting; never replace the whole Codex configuration. Do not share configuration output containing credentials.
2. Open **Settings ▸ MCP ▸ Copy client config** in Specrails. Use its `command` and each `args` element separately. Some versions only copy `command: "specrails-mcp"`; that is usable only if the executable actually resolves in the client's PATH. It is not a guarantee that Desktop installed a global command.
3. If the command does not resolve, locate the installed app's `binaries/specrails-mcp.js` and bundled Node executable. Verify that both files exist before registering them. In Codex, `command` is the Node executable and `args` contains the bridge script path; do not put a whole shell command into `command`.

| Platform | How to locate the installed bridge |
|---|---|
| macOS | Inspect the installed `Specrails.app` bundle. Resources are under `Contents/Resources`; the example below applies only to `/Applications/Specrails.app`. Apps installed elsewhere need their actual paths. |
| Windows | Inspect the installed app's resources for `binaries/specrails-mcp.js` and its bundled `node.exe`. Installation directories vary; preserve each complete path as one argument and use PowerShell quoting or TOML literal strings for backslashes. |
| Linux | Inspect the installation's resource directory (or mounted/extracted AppImage) for `binaries/specrails-mcp.js` and bundled Node. Avoid a temporary AppImage mount path that disappears after exit. If unavailable, report the missing files instead of guessing a global executable. |

Within the verified resource root, look for `binaries/specrails-mcp.js` and `runtimes/node/bin/node` (macOS/Linux) or `runtimes/node/node.exe` (Windows). Search only the identified installation if its layout differs. These are resource-relative candidates, not universal install locations. If you have no local filesystem access, ask for the installed paths or client configuration without credentials.

For **macOS with this exact installation**, this Codex-only example first checks the files and then registers the bridge. For another client, use its registration below. Run the registration only if the existing entry is absent or you intend to update that entry:

```bash
test -x /Applications/Specrails.app/Contents/Resources/runtimes/node/bin/node &&
test -f /Applications/Specrails.app/Contents/Resources/binaries/specrails-mcp.js &&
codex mcp add specrails -- \
  /Applications/Specrails.app/Contents/Resources/runtimes/node/bin/node \
  /Applications/Specrails.app/Contents/Resources/binaries/specrails-mcp.js
```

For other installations, construct the invocation from the verified paths: `codex mcp add`, the name `specrails`, `--`, the quoted executable path, then each quoted argument. If Codex CLI is not in PATH, locate the installed CLI or use the client's MCP configuration UI; do not assume a universal CLI installation path. Codex uses TOML (`[mcp_servers.specrails]` with `command` and `args`), so do not paste the panel's `mcpServers` JSON directly into `config.toml`.

Codex's default user configuration is `~/.codex/config.toml`; project configuration can also apply in trusted projects. CLI and desktop clients using the same local configuration can reuse the entry. Check that they use the same host and configuration home; a cloud task cannot launch your local bridge. See the [official OpenAI MCP documentation](https://developers.openai.com/codex/mcp).

## Register only the requested client

Check the installed client's version and help before editing. Prefer user scope for this machine-local app unless the user requested project scope. Preserve other servers, unrelated fields, existing permissions and file permissions. Inspect the effective entry first; if `specrails` already has a different purpose, resolve the name collision instead of replacing it. With JSON, parse and merge only `mcpServers.specrails`; invalid JSON is a diagnostic, never a reason to reset a file. Review the change locally without exposing secrets.

| Client | Registration and effective configuration | Check |
|---|---|---|
| Claude Code | `claude mcp add --scope user --transport stdio specrails --` followed by the verified executable and arguments. User and local entries live in `~/.claude.json`; project entries use `.mcp.json`. The default CLI scope is local, so select scope explicitly. | `claude mcp get specrails`; `/mcp` in the client. Project approvals can block loading. |
| Codex CLI / desktop | `codex mcp add specrails --` followed by the verified executable and arguments. TOML user configuration, normally `~/.codex/config.toml`, is shared by local Codex clients using that home. | `codex mcp get specrails`; inspect the actual conversation tool catalog. |
| Gemini CLI | `gemini mcp add --scope user --transport stdio specrails` followed by the verified executable and arguments. Uses `mcpServers` in `~/.gemini/settings.json`; project scope uses `.gemini/settings.json` and is the CLI default. | `gemini mcp list`; `/mcp` in the client. Check allowed/excluded servers and tools. Do not add `--trust` merely to connect. |
| Kimi Code | Merge the stdio entry into `~/.kimi-code/mcp.json` (or the configured `KIMI_CODE_HOME`), or project `.kimi-code/mcp.json`. Project entries override user entries. Kimi Code 0.27.0 does **not** expose `kimi mcp add`; do not confuse it with the older Python Kimi CLI. | `/mcp` shows connection status; `/mcp-config` edits entries interactively. A newly added file entry requires a new session. |

The following commands are **alternatives**, not a script to install all clients. These macOS examples require the same two file checks shown above and no conflicting existing entry:

```bash
# Claude Code only
claude mcp add --scope user --transport stdio specrails -- \
  /Applications/Specrails.app/Contents/Resources/runtimes/node/bin/node \
  /Applications/Specrails.app/Contents/Resources/binaries/specrails-mcp.js
```

```bash
# Gemini CLI only
gemini mcp add --scope user --transport stdio specrails \
  /Applications/Specrails.app/Contents/Resources/runtimes/node/bin/node \
  /Applications/Specrails.app/Contents/Resources/binaries/specrails-mcp.js
```

For Kimi Code, merge this macOS example into the chosen `mcp.json`, retaining the existing root object and other servers. Use the verified paths for other installations:

```json
{
  "mcpServers": {
    "specrails": {
      "command": "/Applications/Specrails.app/Contents/Resources/runtimes/node/bin/node",
      "args": ["/Applications/Specrails.app/Contents/Resources/binaries/specrails-mcp.js"]
    }
  }
}
```

Claude Desktop is a separate client from Claude Code. If that is the requested host, merge this same `mcpServers` structure in its local MCP configuration through its settings; registering Claude Code alone is not proof that Claude Desktop is configured.

Sources: [Claude Code MCP](https://code.claude.com/docs/en/mcp), [Gemini CLI MCP](https://geminicli.com/docs/tools/mcp-server/), [Kimi Code MCP](https://moonshotai.github.io/kimi-code/en/customization/mcp). Command shapes were also checked against installed help for Claude Code 2.1.265, Gemini CLI 0.49.0 and Kimi Code 0.27.0. Client configuration and live connection are separate checks.

## Verify all three stages

- **Registered:** the requested client's configuration check (for Codex, `codex mcp get specrails`) shows the expected stdio command and arguments. This only proves configuration was saved.
- **Connected:** a real MCP session completes `initialize`, sends `notifications/initialized`, then receives `tools/list` without a protocol error. Inspect the returned catalog; tool counts vary by version and do not grant permission to every action.
- **Usable in this conversation:** ask the agent to call `specrails_projects` with `{"action":"list"}` and inspect the real result (including `isError`). This is read-only. Use returned project IDs for subsequent calls, and read `specrails_guide` before operating the app. A successful empty project list is still a successful connection.

If an agent has a protocol client but no loaded tools, it can perform the handshake and read-only call through the verified stdio bridge. Report that as bridge connectivity, separately from tool availability in the current conversation. Do not launch a rail or create a spec as a connection test.

## Connection troubleshooting

| Symptom | Check |
|---|---|
| App not running / connection refused | Start Specrails and check Settings ▸ MCP is enabled. Closing its window may leave it in the tray; quitting the app stops the server. |
| Command not found / missing script | Verify the actual executable and script paths. Recheck after moving or updating the app. The generic panel command may not be installed in PATH. |
| Registered, but no tools in this conversation | Check the desktop client's MCP status and effective config, including disabled servers/tools and project overrides. A saved entry does not retroactively prove a conversation loaded it. Verify in a new local session if needed; do not assume a reload command or promise an existing task will refresh automatically. |
| Transport error | Launch the bridge as stdio; do not pass an HTTP URL as its executable. Direct HTTP clients use streamable HTTP at the panel's `/api/mcp` URL, not SSE-only transport. |
| Wrong port | The bridge defaults to `4200`; it reads `SPECRAILS_MCP_PORT`, then `SPECRAILS_PORT`. For a custom app port, set `SPECRAILS_MCP_PORT` in the server's environment to the actual port. It does not discover arbitrary ports automatically. |
| Missing token / 401 | Run the bridge as the same OS user as Specrails and check local token-file access without printing its contents. If using `SPECRAILS_REGISTRY_HOME`, it must point to the same registry home as the app. Reconnect after token rotation. Never copy the master `desktop.token`. |
| Permission-tier error | Connectivity succeeded, but the requested action is restricted. Project listing needs only Read; enable other tiers only for the intended work. |

## Report the result

State the client and scope, whether the existing entry was reused or changed, whether `initialize` and `tools/list` succeeded, and whether the current conversation actually called `specrails_projects` successfully. Distinguish an empty list from a failed call. Report unavailable stages explicitly and give the next concrete step; do not claim success from registration alone. Never include tokens or full private configuration in the report.
