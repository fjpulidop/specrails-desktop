# Adding your first project

A project is just a folder on your computer that contains a codebase. Let's connect one.

## Open the Add Project dialog

Click **Add your first project** on the welcome screen (or the **Add project** button in the left sidebar later on). A small dialog appears.

## Fill in the details

**Project folder** *(required)*

Point specrails at the folder that holds your code. On the desktop app you can click the folder icon to browse and pick it visually, or paste the full path. This should be the root of your repository — the folder that contains your code and (usually) a `.git` directory.

**Project name** *(optional)*

A friendly label shown in the sidebar. If you leave it blank, specrails uses the folder name.

**Providers**

Choose which AI provider(s) this project should use. Specrails shows you the ones it detected on your machine:

- 🤖 **Claude**
- ⚡ **Codex**
- ✨ **Gemini**

Providers it didn't find are greyed out and marked *not found* — install and sign in to one, then re-open the dialog. By default every available provider is pre-selected, but you can deselect down to just the one you want. If you pick more than one, the **first** becomes the project's default; you'll be able to choose per task later.

> A quick check runs in the background to confirm the required tools are present. If something essential is missing, the **Add** button stays disabled and a **More info** link gives you exact install commands.

Click **Add** to continue.

## Setup that runs in seconds

If the folder already has specrails configured, you're done — the project appears in your sidebar instantly.

If it's a fresh project, a short **setup wizard** runs. It has three steps:

1. **Configure** — confirm the basics for each provider you chose.
2. **Install** — specrails sets up the project automatically. This is the *quick* install: ready-to-use template agents that are in place within seconds. You'll see a live log as it runs.
3. **Done** — a summary confirming everything's ready.

For a multi-provider project, the install runs once per provider, one after another, and the Done step shows a card for each.

## What gets installed

Setup is deliberately light and **non-invasive**. Specrails adds a small amount of configuration to your project so the pipeline knows how to run:

- A `.specrails/` folder holding your project's agent profiles and local settings.
- Agent definitions under `.claude/agents/` that power the Architect → Developer → Reviewer → Ship pipeline.

That's it — specrails won't rewrite your source code during setup, and these files are safe to commit if you want to share the configuration with your team.

> **Want the deep setup instead?** The app ships the fast template install on purpose. If you'd prefer the AI-enriched flow (codebase analysis and custom agent personas), you can run `npx specrails-core@latest init` from your project folder in a terminal.

## You're in

Once setup finishes, specrails drops you into your project's dashboard. Time for the tour — see [The dashboard tour](the-dashboard-tour).