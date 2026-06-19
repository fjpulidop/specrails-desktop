# Profiles & the balanced default

A **profile** is a saved recipe for a pipeline run. It answers three questions in one place:

1. **Which agents** participate (the baseline trio, plus any specialists or custom agents).
2. **Which model** each agent runs with.
3. **How tasks are routed** to those agents.

You'll find profiles in the **Agents** section of any project (right sidebar → **Agents** → the **Profiles** tab).

## The balanced default

Out of the box, a project resolves to a sensible **default** profile. It includes the baseline trio — `sr-architect`, `sr-developer`, `sr-reviewer` — and routes every task to the developer through a single catch-all rule. The models are balanced for everyday work: a capable model where it matters, without reaching for the most expensive option on every step.

If your project already had agent models configured the old way (in the agent files' frontmatter), the **Migrate** button reads those and builds a `default` profile that mirrors today's behaviour exactly — zero loss, nothing changes until you decide to tune it.

The headline: **you don't have to create a profile to use Specrails.** The default just works. Profiles are how you go further.

## How a profile is chosen for a run

When you launch a rail, Specrails picks a profile in this order:

1. **Your explicit choice** in the rail header (see below).
2. Your **per-developer preference** — a profile you've marked as your personal default for this project (it's local to you and not committed).
3. The project's **`default`** profile.

The profile is *snapshotted at launch*, so each rail in a batch can run a different profile, and changing a profile later never rewrites jobs that already started.

## Selecting a profile per rail

Profile selection happens right where you launch — in the **rail header**, via the profile selector.

- Pick a profile from the dropdown to use it for **this launch only**.
- Use the persist option to make a profile the rail's standing choice going forward.

That's the whole flow: choose a profile, launch, done. Concurrent rails in the same batch can each carry their own profile, so a quick fix and a heavy feature can run side by side with different setups.

## When the Agents section is quiet

Profiles are a Claude capability. On a project that includes a non-Claude provider (Codex or Gemini), the Agents section is hidden and rails run without profiles — that's expected, not a bug. Profiles also require a recent enough `specrails-core` in the project; if it's older, you'll see a yellow banner. Profiles you create still **save** — they just don't affect the pipeline until core is updated. Update with the command shown in the banner to unlock them.

## Where to go next

- [Customizing models per agent](customizing-models-per-agent) — build `fast` and `max` profiles.
- [Custom agents & the catalog](custom-agents-catalog) — see and extend the team.
