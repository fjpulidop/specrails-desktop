# Custom agents & the catalog

Profiles decide *which agents run and with what models*. But where do the agents themselves come from? That's the **Agents catalog**.

Open **Agents → Catalog** in any project. It's a read-only viewer of every agent available to that project, in two groups:

- **Upstream agents** — the roles the Core engine defines at runtime: the baseline trio (`sr-architect`, `sr-developer`, `sr-reviewer`). They're not files in your repo; the catalog shows each role's live definition read-only, and you edit it in **Settings → Agent runtime**.
- **Custom agents** — agents you've added yourself, named `custom-*`.

Each catalog entry shows what the agent is for; custom agents also show their default model, while the baseline roles run with the provider and model set in **Settings → Agent runtime**. Either way you can see the full roster before wiring agents into a profile chain.

## Adding a custom agent

Because they live in your repo, custom agents are **committable team assets**: commit the file and your whole team gets the agent. This mirrors the core idea throughout the Agents section —

> **Custom agent definitions are shared (they live in the repo and travel with `git`); the baseline roles are defined by the Core runtime. Model configuration is per-project (it lives in profiles).**

## Putting a custom agent to work

The typical flow:

## Watching how profiles perform

The Agents section also has a **Usage** tab — a per-profile breakdown of how many jobs ran under each profile over a selected window. It's a quick way to confirm your `fast`/`max` split is actually being used the way you intended, and to spot which profile your team gravitates to.

## Recap of the whole section

- **Agents** are the specialised team members — the shared trio plus specialists and your custom agents. ([Meet the agents](meet-the-agents))
- **Profiles** package which agents run, with which models, and how tasks route — selected per rail at launch. The default profile is the balanced everyday choice. ([Profiles & the balanced default](profiles-and-the-balanced-default))
- **Models** are tuned per agent, per project, inside profiles — build `fast` and `max` to match the job. ([Customizing models per agent](customizing-models-per-agent))
- **The catalog** shows every agent, and the `custom-*` namespace lets you grow the team — definitions shared, config per-project.
