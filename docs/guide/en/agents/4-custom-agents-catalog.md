# Custom agents & the catalog

Profiles decide *which agents run and with what models*. But where do the agents themselves come from? That's the **Agents catalog**.

Open **Agents → Catalog** in any project. It's a read-only viewer of every agent available to that project, in two groups:

- **Upstream agents** — the agents that ship with `specrails-core`: the baseline trio (`sr-architect`, `sr-developer`, `sr-reviewer`) and any specialists like `sr-merge-resolver`.
- **Custom agents** — agents you've added yourself, named `custom-*`.

Each catalog entry shows what the agent is for and its default model, so you can see the full roster before wiring agents into a profile chain.

## Adding a custom agent

Custom agents are plain Markdown files in your repository under `.claude/agents/`, named `custom-<something>.md`. The file contains the agent's instructions (its system prompt) and a small frontmatter header that includes a default `model:`.

Once the file exists in the project, it appears in the catalog as a custom agent, and you can add its id to any profile's agent chain (and route tasks to it). The id must match the filename — an entry for `custom-docs` maps to `.claude/agents/custom-docs.md`.

Because they live in your repo, custom agents are **committable team assets**: commit the file and your whole team gets the agent. This mirrors the core idea throughout the Agents section —

> **Agent definitions are shared (they live in the repo and travel with `git`). Model configuration is per-project (it lives in profiles).**

The `custom-*` namespace is reserved and protected: `specrails-core`'s `init` and `update` commands never touch `.claude/agents/custom-*.md`, so your custom agents survive core upgrades untouched. (The same protection covers plugin-contributed fragments like `custom-serena.md`.)

## Putting a custom agent to work

The typical flow:

1. Write `.claude/agents/custom-<name>.md` with instructions and a default model.
2. Confirm it shows up in **Agents → Catalog** under Custom.
3. In **Agents → Profiles**, add the agent to a profile's chain (optionally overriding its model for that profile).
4. Add a routing rule so tasks with the right tags reach it — or rely on the chain order.
5. Launch a rail with that profile from the rail header.

## Watching how profiles perform

The Agents section also has a **Usage** tab — a per-profile breakdown of how many jobs ran under each profile over a selected window. It's a quick way to confirm your `fast`/`max` split is actually being used the way you intended, and to spot which profile your team gravitates to.

## Recap of the whole section

- **Agents** are the specialised team members — the shared trio plus specialists and your custom agents. ([Meet the agents](meet-the-agents))
- **Profiles** package which agents run, with which models, and how tasks route — selected per rail at launch. The default profile is the balanced everyday choice. ([Profiles & the balanced default](profiles-and-the-balanced-default))
- **Models** are tuned per agent, per project, inside profiles — build `fast` and `max` to match the job. ([Customizing models per agent](customizing-models-per-agent))
- **The catalog** shows every agent, and the `custom-*` namespace lets you grow the team — definitions shared, config per-project.
