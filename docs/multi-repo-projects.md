# Projects with several repositories

A Specrails project can contain a frontend, backend, libraries and other local repositories. They share one board, spec numbering, missions, Jira connection and project settings. A spec can select several repositories and describe the contract between them.

## Add repositories

When adding a project, choose its primary folder and use **Add folder** for additional folders. On desktop, the folder picker also accepts several additional selections. In a web development session, enter their local paths.

For an existing project, open **Project settings → General → Repositories and folders**. Add repositories there, give them descriptive names, and optionally set their integration branches. The primary folder continues to own the existing project identity and backlog; adding a repository preserves the existing specs, history and Jira configuration.

Folder paths must exist. Specrails resolves symbolic links and rejects duplicate or nested roots within the same project. A secondary checkout can belong to several logical projects, each with its own backlog. Git operations on a shared checkout use the same repository lock.

A folder without Git can provide read-only context. It cannot be selected as an additional implementation target. A previously registered project with one non-Git primary folder retains its existing behavior.

## Scope a shared spec

Use **Affected repositories** when creating or editing a spec. Select every repository that needs implementation changes. The selection is retained through Quick and Explore authoring, parked drafts, edits and Jira refreshes.

Older specs without a selection continue to target the primary repository. Jira imports use that same default until you choose a different scope. A batch targets the union of its specs' repositories. An explicit launch selection may add repositories but cannot omit a repository required by a spec. A standalone loop has a repository selector in its Run dialog.

The mission agent can discover every registered repository. Code and Git views have a repository picker, and file references retain repository identity even when several repos contain `src/index.ts`. Reading a repository does not add it to a spec's implementation scope.

## Run and review

Multi-repository launches prepare isolated Git worktrees for all selected repositories before starting the provider. One coordinated implementation can edit the selected worktrees and verify changes across their boundaries. Preparation failures stop the launch and preserve an actionable error.

OpenSpec artifacts belong to the selected primary repository, or to the first selected repository when the primary is outside the scope. Custom shell nodes must choose a repository explicitly for multi-repository runs. Built-in archive steps use the artifact repository.

The delivery card contains one section per repository with its branch, commit and delivery status. Review evidence by repository, then create or publish a PR, integrate locally, or check out the work for that repository. Checkout moves a verified review branch into that repository's local folder; it does not mark the shared spec complete.

The shared spec and Jira issue finish only after every required repository is accepted, including explicit acceptance of repositories with no changes. If one integration succeeds and another fails, the successful result is retained. Resolve the reported problem and retry the outstanding repository. Git cannot make commits or merges atomic across separate repositories.

Revisions preserve the repository scope and build on the previous delivery commits. An already integrated repository starts from its verified integration head, preserving subsequent local work. Sequential milestone chunks use the latest delivered head for each repository, including repositories unchanged by an intermediate chunk. Their local integration destination remains the configured integration branch.

## Change or detach a repository

Names and integration branches can be edited without moving a checkout. Changing a secondary folder path or detaching it is blocked while specs or active execution records still refer to that membership. Update those specs and resolve the pending work first. Detaching a member never deletes its local files.

An unavailable folder remains visible with an error. Specrails does not redirect an explicit repository selection to the primary folder. Frozen execution records keep their original paths so that recovery and review cannot follow a later membership edit into a different checkout.

## MCP and API

`specrails_projects` and `specrails_context` expose repository inventories. Individual code and Git operations accept `repositoryId`; on a multi-repository project the agent must identify the member. Code find/search can discover across members and reports truncation when its shared budget is exhausted.

Specs and launches accept `repositoryIds`. IDs belong to the selected logical project. Unknown, removed or foreign IDs produce an error before implementation starts.

Use `specrails_rails` to implement a shared spec and `specrails_loops` for coordinated standalone work. Direct `specrails_jobs(spawn)` is a primary-repository operation; in a multi-repository project it requires that primary member's explicit ID and rejects secondary targets before enqueueing.

To start a development server through the mission agent, use `specrails_jobs` with `action: "background_start"`, the intended `repositoryId`, and a command such as `npm run dev`. An optional `cwd` stays inside that repository. This keeps the existing Autonomous permission level and explicit command confirmation; selecting or reading a repository does not start a process.

REST membership lives at `/api/projects/:projectId/repositories`. Repository code and Git routes live under `/api/projects/:projectId/repositories/:repositoryId`; existing unscoped routes retain primary-repository behavior. Grouped delivery decisions retain the parent delivery ID and optionally specify `repositoryId`. Review packets accept a `repositoryId` query parameter.
