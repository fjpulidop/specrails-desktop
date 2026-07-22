# Adding your first project

A project is just a folder on your computer that contains a codebase. Let's connect one.

## Open the Add Project dialog

Click **Add your first project** on the welcome screen (or the **Add project** button in the left sidebar later on). A small dialog appears.

## Fill in the details

**Project folder** *(required)*

Point specrails at the folder that holds your code. On the desktop app you can click the folder icon to browse and pick it visually, or paste the full path. This should be the root of your repository — the folder that contains your code and (usually) a `.git` directory.

**Project name** *(optional)*

A friendly label shown in the sidebar. If you leave it blank, specrails uses the folder name.

> A quick check runs in the background to confirm the required tools are present. If something essential is missing, the **Add** button stays disabled and a **More info** link gives you exact install commands.

That's the whole form — click **Add** and you're done.

## AI providers are detected automatically

You don't pick providers anymore. Specrails detects every AI CLI installed on your machine — **Claude**, **Codex**, **Gemini**, **Kimi** — and every project can use all of them, always. Install a new provider later and it appears everywhere on its own the next time you focus the app; no re-setup, no per-project configuration. If a provider is installed but not signed in, its selector shows a subtle *Not signed in* badge.

## Setup happens silently

There is no setup wizard. The moment you click **Add**, the project is registered and appears in your sidebar — you can open it immediately. In the background, specrails assembles the project's workspace (a few seconds, fully offline): a tiny pulsing dot on the project's sidebar row shows it's working, and it simply disappears when everything is ready. If something goes wrong for one provider, the project still works with the others — an amber dot appears, and clicking it retries.

## What gets installed — and where

Setup is deliberately **non-invasive**: your repository stays pristine. All specrails artifacts (agent definitions, commands, profiles, local settings) live in a per-project workspace under your home directory, linked to a single shared framework installation that ships with the app. Your repo is never modified — and when the app updates, every project picks up the new framework automatically, at once.

> **Want the deep setup instead?** The app ships the fast template install on purpose. If you'd prefer the AI-enriched flow (codebase analysis and custom agent personas), you can run `npx specrails-core@latest init` from your project folder in a terminal.

## You're in

The project dashboard is available the moment you click **Add**. Time for the tour — see [The dashboard tour](the-dashboard-tour).
