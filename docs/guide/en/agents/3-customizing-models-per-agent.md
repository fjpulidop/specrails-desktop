# Customizing models per agent

The single most useful thing profiles let you do is **pick the right model for each step**. A planning step might deserve your strongest model; a routine build step might be perfectly happy on something faster and cheaper. Profiles let you express exactly that.

This is where the shared-vs-per-project split pays off:

- The agent *definitions* stay shared across your team.
- The *model each agent runs with* is configured **per project**, inside a profile, and only affects your project.

Change a model and you change cost and behaviour for that project — without touching anyone else's setup or the agent's underlying instructions.

## Changing which model an agent uses

In **Agents → Profiles**, select a profile and open its agent chain editor. Each agent in the chain has a model field. There's also an **orchestrator** model that runs the top-level coordination of the pipeline.

The model values are aliases — for Claude that's `opus`, `sonnet`, and `haiku` (most capable → fastest). Set the alias you want per agent:

- Leave an agent's model **blank** to fall back to the agent file's own default.
- Set it explicitly to override just for this profile.

Save, and the next rail launched with that profile uses the new models. Jobs already running keep their snapshot.

## Creating profiles like `fast` and `max`

The natural pattern is a couple of named profiles you reach for depending on the job:

**A `fast` profile** — for small, low-risk changes where you want speed and a smaller bill:

- Architect: a mid or fast model — the plan is simple.
- Developer: a fast model — the change is mechanical.
- Reviewer: keep it solid, but you can trim here too.

**A `max` profile** — for gnarly, high-stakes features where you want every step to be as sharp as possible:

- Architect, developer, and reviewer: your strongest model across the board.

### Two ways to build one

1. **Duplicate and tweak** *(recommended).* Select your `default` profile, **Duplicate** it, give the copy a kebab-case name like `fast` or `max`, then adjust each agent's model. You inherit a known-good chain and routing and only change what you mean to.
2. **Start blank.** Create a **Blank profile** and assemble the chain yourself. You must still include the baseline trio (`sr-architect`, `sr-developer`, `sr-reviewer`) — the pipeline depends on all three — and exactly one terminal catch-all routing rule, which must be last.

Profile names are lowercase kebab-case (e.g. `fast`, `max`, `cheap-and-cheerful`).

## Routing tasks to specific agents

A profile's **routing rules** decide which agent handles a tagged task. Each rule lists task tags and a target agent; the first rule whose tags match wins, and a single `default: true` rule at the end catches everything else. Only agents that are actually in the profile's chain can be routing targets — the editor enforces this.

For everyday use you won't touch routing: the catch-all sends work to the developer and that's correct. Reach for tag rules when you want, say, work tagged `migration` to go to a specialist instead.

## Picking the profile when you launch

All of this comes together at launch: in the rail header, choose `fast`, `max`, or `default` per rail. A batch can mix them — a tiny fix on `fast`, a big feature on `max`, both running at once. See [Profiles & the balanced default](profiles-and-the-balanced-default) for the selection flow.

## A note on safety

Deleting a profile is safe for in-flight work: jobs already launched with it keep their snapshot, and future launches simply fall back through the resolution order. Experiment freely.

## Where to go next

- [Custom agents & the catalog](custom-agents-catalog) — add agents to put in your chains.
