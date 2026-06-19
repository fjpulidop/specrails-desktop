# What is specrails

Welcome to **specrails** — a desktop app that turns an AI coding assistant into a real software team that works on *your* projects, on *your* machine.

Instead of copy-pasting prompts back and forth, you describe what you want as a **spec**, and specrails runs it through a complete development pipeline — designing, building, reviewing, and shipping the change — while you watch it happen live.

## Spec-driven AI development

The heart of specrails is a simple idea: **the best way to get good code out of AI is to start from a clear spec.**

A *spec* is a short, structured description of one piece of work — a feature, a fix, a refactor. You can write one in seconds, or shape one through a guided chat that asks the right questions and drafts it for you. Each spec becomes a **ticket** on your project board, just like a task in any issue tracker.

From there, you hand the spec to the pipeline and let the AI do the heavy lifting.

## The pipeline: Architect → Developer → Reviewer → Ship

When you launch a spec, specrails runs it through four stages, each played by a focused AI agent:

1. **Architect** — reads your spec and the surrounding code, then plans the change: what files to touch, what the shape of the solution should be.
2. **Developer** — writes the actual code, following the plan.
3. **Reviewer** — checks the work for correctness and quality, catching issues before you do.
4. **Ship** — finalizes the change so it's ready to commit.

You see every stage as it runs, with live logs streaming straight from the AI. Nothing is hidden — if something goes sideways, you'll see exactly where.

## Projects

Everything in specrails is organized around **projects**. A project is simply a folder on your computer that holds a codebase. You can add as many projects as you like and switch between them instantly — each one keeps its own specs, job history, analytics, and settings.

Specrails never touches code you didn't ask it to. It works inside your existing repository, and you stay in control of what gets committed.

## Choose your AI provider

Specrails works with the major AI coding CLIs:

- **Claude** (Claude Code)
- **Codex** (Codex CLI)
- **Gemini** (Gemini CLI)

Pick whichever you already use — or install more than one and choose per task. A project can run on a single provider or several at once, so you're never locked in.

## Why you'll like it

- **Speed without chaos** — specs keep the AI focused, so you get useful changes instead of sprawling guesses.
- **Full visibility** — live logs, a clear pipeline view, and per-project analytics show you exactly what happened and what it cost.
- **Your machine, your code** — everything runs locally against your real repository.
- **One place for everything** — specs, jobs, chat, a built-in terminal, and cost tracking, all in a single window.

Ready to get going? Next up: [Installing & first run](installing-and-first-run).