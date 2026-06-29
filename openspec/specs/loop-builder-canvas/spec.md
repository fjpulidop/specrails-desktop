# loop-builder-canvas Specification

## Purpose
TBD - created by archiving change loop-builder. Update Purpose after archive.
## Requirements
### Requirement: Node Canvas with Directed, Cyclic Edges

The loop builder SHALL present a visual node-graph canvas (built on `@xyflow/react`) on which the author places nodes and connects them with directed edges. The canvas MUST allow cycles, so an edge MAY route from a node back to any earlier node, expressing iterative loops. Each connection MUST originate from one node's output handle and terminate at another node's input handle, and the canvas MUST persist the full set of nodes (with positions) and edges as the loop's graph definition.

#### Scenario: Connecting two nodes with a directed edge

- **WHEN** the author drags from a source node's output handle and drops onto a target node's input handle
- **THEN** a directed edge from source to target SHALL be created and rendered on the canvas
- **AND** the edge SHALL be persisted in the loop's graph definition

#### Scenario: Routing an edge back to an earlier node forms a cycle

- **WHEN** the author connects an output handle of a downstream node to the input handle of a node that already precedes it in the graph
- **THEN** the cyclic edge SHALL be accepted and rendered
- **AND** the canvas MUST NOT reject the graph for containing a cycle

#### Scenario: Repositioning a node by drag

- **WHEN** the author drags a node to a new location on the canvas
- **THEN** the node's new position SHALL be saved in the graph definition so it is restored on reopen

### Requirement: Supported Node Types

The builder SHALL provide exactly six node types the author can place on the canvas: **Start**, **AI Step**, **Shell**, **Loop Decider**, **Condition**, and **End**. Each node MUST be visually distinguishable by type, and the builder MUST expose type-specific configuration for AI Step, Shell, Loop Decider, and Condition nodes.

#### Scenario: Placing each node type

- **WHEN** the author adds a node of any of the six supported types
- **THEN** the node SHALL appear on the canvas labeled with its type
- **AND** selecting an AI Step, Shell, Loop Decider, or Condition node SHALL open that node's type-specific configuration

#### Scenario: Start and End nodes carry no execution config

- **WHEN** the author selects a Start node or an End node
- **THEN** the builder SHALL present no AI/Shell/decision configuration for it, since these nodes mark graph entry and exit only

### Requirement: Adding Nodes via Inline "+" Affordance

The builder SHALL expose a "+" affordance positioned on an edge between two connected nodes as the primary way to insert a new node, and inserting a node through this affordance MUST splice it into that edge (rewiring the upstream node to the new node and the new node to the downstream node). The builder MAY additionally support adding nodes from a palette, and SHALL support disconnecting an existing edge.

#### Scenario: Inserting a node between two connected nodes

- **WHEN** the author clicks the "+" affordance on the edge between node A and node B and chooses a node type
- **THEN** a new node of that type SHALL be created between A and B
- **AND** the original A→B edge SHALL be replaced by an A→new and new→B edge pair

#### Scenario: Disconnecting an edge

- **WHEN** the author removes an existing edge between two nodes
- **THEN** the edge SHALL be deleted from the graph definition
- **AND** the two formerly connected nodes SHALL remain on the canvas unconnected by that edge

### Requirement: AI Step Node Configuration

An AI Step node SHALL be configurable with a prompt, an AI provider, a model, a reasoning effort, and a maximum number of turns. The prompt MUST support the interpolation tokens `{{spec.title}}` and `{{spec.description}}`, which are substituted with the bound spec's title and description at execution time. The provider selection SHALL be limited to Claude and Codex, and the model and reasoning-effort options MUST reflect the chosen provider.

#### Scenario: Authoring an AI Step prompt with spec tokens

- **WHEN** the author enters a prompt containing `{{spec.title}}` and `{{spec.description}}` for an AI Step node
- **THEN** the prompt SHALL be saved verbatim including the tokens
- **AND** the tokens SHALL be marked as the only supported interpolation variables for the prompt

#### Scenario: Selecting provider, model, reasoning effort, and max turns

- **WHEN** the author selects Claude or Codex for an AI Step node
- **THEN** the model and reasoning-effort choices offered SHALL correspond to the selected provider
- **AND** the author SHALL be able to set a maximum number of turns for that node

### Requirement: Shell Node Configuration

A Shell node SHALL be configurable with a single shell command string that the execution engine runs in the project working directory. The builder MUST persist the command string verbatim as part of the node's configuration.

#### Scenario: Authoring a shell command

- **WHEN** the author enters a command string into a Shell node's configuration
- **THEN** the command string SHALL be saved verbatim on the node
- **AND** it SHALL be available to the execution engine as the command to run for that node

### Requirement: Loop Decider Node Configuration

A Loop Decider node SHALL be configurable with a goal / stop-criteria description that states when the loop should stop. The builder MUST persist this description, and it SHALL document that the actual continue/stop decision is evaluated at execution time by the loop-execution engine, not by the builder.

#### Scenario: Authoring a stop-criteria goal

- **WHEN** the author enters a goal / stop-criteria description into a Loop Decider node
- **THEN** the description SHALL be saved on the node as the decision goal
- **AND** the builder MUST NOT itself evaluate continue/stop, deferring that to execution time

### Requirement: Condition Node AND/OR Joins

A Condition node SHALL support two join semantics: an **AND** join and an **OR** join. The AND join MUST express a sequence in which both incoming branches are required to proceed. The OR join MUST express a fallback in which the first branch is attempted and, only on its exhaustion, the alternative branch is taken. The builder MUST persist which join semantic each Condition node uses.

#### Scenario: Configuring an AND join (sequence, both required)

- **WHEN** the author configures a Condition node as an AND join
- **THEN** the node SHALL be persisted as requiring both incoming branches to proceed

#### Scenario: Configuring an OR join (fallback)

- **WHEN** the author configures a Condition node as an OR join
- **THEN** the node SHALL be persisted as attempting the first branch and taking the alternative only on the first branch's exhaustion

### Requirement: General Loop Configuration

The builder SHALL expose a loop-level configuration carrying a maximum number of iterations (`maxIterations`) and a timeout. These values MUST be persisted on the loop definition and MUST be available to the execution engine as the iteration and time bounds for any run of the loop.

#### Scenario: Setting iteration and timeout bounds

- **WHEN** the author sets `maxIterations` and a timeout on the loop
- **THEN** both values SHALL be saved on the loop definition
- **AND** they SHALL be exposed to the execution engine as the run's iteration and time limits

### Requirement: Publish-Time Graph Validation

The builder SHALL validate the graph at publish time and MUST block publishing when any of the following holds: the graph does not contain exactly one Start node; the graph contains no End node; the graph contains neither a Loop Decider node nor an explicit exit path; or the graph contains any orphan (unconnected) node. On any validation failure the builder MUST keep the loop unpublished and SHALL surface concrete per-node errors identifying the offending nodes. When all rules pass, publishing SHALL be allowed to proceed.

#### Scenario: Blocking publish when Start/End/Decider rules are violated

- **WHEN** the author attempts to publish a graph that lacks exactly one Start, lacks any End, or lacks any Loop Decider or explicit exit
- **THEN** publishing SHALL be blocked
- **AND** a concrete per-node error SHALL be shown for each violated rule identifying the affected node

#### Scenario: Blocking publish when an orphan node exists

- **WHEN** the author attempts to publish a graph containing a node with no connecting edges
- **THEN** publishing SHALL be blocked
- **AND** a per-node error SHALL identify the orphan (unconnected) node

#### Scenario: Allowing publish for a valid graph

- **WHEN** the author publishes a graph with exactly one Start, at least one End, at least one Loop Decider or explicit exit, and no orphan nodes
- **THEN** validation SHALL pass
- **AND** publishing SHALL be allowed to proceed

