# Documentation exclusively for agents

When a person says “connect to the Specrails MCP”, use the [English runbook](mcp.md) or [Spanish runbook](mcp.es.md). These instructions cover Claude Code, Codex CLI/desktop, Kimi Code and Gemini CLI. They require local discovery, a configuration-preserving registration and a real read-only verification.

## Maintaining the public copy

The canonical connection runbooks are `docs/agents/mcp.md` and `docs/agents/mcp.es.md` in Specrails Desktop. Specrails Web keeps reviewed copies in `src/content/for-agents/`. Its `docs:sync` command generates `/llms.txt`, `/for-agents/index.html` and the two static Markdown runbooks. These resources are usable without executing the documentation SPA.

Desktop's `docs/guide/` and Web's `src/content/guide/` are separate article trees. Do not overwrite the Web guide with Desktop's tree: the Web guide has its own revision markers and current product structure. Update their MCP article links deliberately. Other Desktop languages point to the current English runbook.

To import these two runbooks in a Web checkout, run `npm run docs:sync -- --desktop-source` followed by the quoted path to this Desktop checkout. To compare without writing, use `npm run docs:check -- --desktop-source` followed by that same path. Normal Web builds use their committed copy and do not need Desktop checked out.

Review paired PRs together. Merging Desktop alone does not update specrails.dev. Web's release workflow builds and uploads `dist/` to Hostinger on a release or manual dispatch; importing, building and opening PRs do not deploy the site. After an authorized deployment, verify that the Markdown URLs return text, not the SPA shell.
