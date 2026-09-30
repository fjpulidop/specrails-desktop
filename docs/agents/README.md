# Documentation exclusively for agents

## Maintaining the public copy

The canonical connection runbook is `docs/agents/mcp.md` in Specrails Desktop. Specrails Web keeps a reviewed copy in `src/content/for-agents/`. Its `docs:sync` command generates `/llms.txt`, `/for-agents/index.html` and the static Markdown runbook. These resources are usable without executing the documentation SPA.

Desktop's `docs/guide/` and Web's `src/content/guide/` are separate article trees. Do not overwrite the Web guide with Desktop's tree: the Web guide has its own revision markers and current product structure. Update their MCP article links deliberately. Other Desktop languages point to the current English runbook.

To import this runbook in a Web checkout, run `npm run docs:sync -- --desktop-source` followed by the quoted path to this Desktop checkout. To compare without writing, use `npm run docs:check -- --desktop-source` followed by that same path. Normal Web builds use their committed copy and do not need Desktop checked out.

Review paired PRs together. Merging Desktop alone does not update specrails.dev. Web's release workflow builds and uploads `dist/` to Hostinger on a release or manual dispatch; importing, building and opening PRs do not deploy the site. After an authorized deployment, verify that the Markdown URLs return text, not the SPA shell.
