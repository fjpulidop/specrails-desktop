# Installing & first run

Getting specrails onto your machine takes a couple of minutes. Here's the whole flow.

## 1. Download and install

Grab the installer for your platform:

- **macOS (Apple Silicon)** — a `.dmg` file. Open it and drag **specrails** into your Applications folder.
- **Windows** — a `.exe` setup installer. Run it and follow the prompts.

> **Heads-up on macOS and Windows security prompts**
>
> - On **Windows**, the installer isn't code-signed yet, so SmartScreen may show a warning. Click **More info → Run anyway** to continue.
> - On **macOS**, the app is signed and notarized, so it should open cleanly.

## 2. What you'll need (prerequisites)

Specrails runs AI development pipelines by driving real command-line tools, so a few things need to be available. The good news: the desktop app **bundles most of them for you** (Node.js, npm, and Git ship inside the app), so on a fresh machine there's usually nothing to install.

The one thing specrails can't bundle is the **AI provider CLI** itself. You'll need at least one of:

- **Claude Code**
- **Codex CLI**
- **Gemini CLI**

Install whichever you plan to use, sign in to it once from your terminal, and you're set. Specrails detects which providers are present automatically.

> If you ever see a tool flagged as missing, the app shows a **More info** link with copy-paste install commands tailored to your operating system (Homebrew on macOS, winget on Windows, apt/dnf on Linux). You can re-check at any time without restarting.

## 3. First launch — the welcome screen

The first time you open specrails, you'll land on a clean **welcome screen**. There are no projects yet, so the app invites you to add your first one.

You'll see:

- A short description of what specrails does.
- A single **Add your first project** button.

That's the whole onboarding — no account to create, no sign-up. Specrails works entirely on your machine.

Click **Add your first project** and continue to [Adding your first project](adding-your-first-project).