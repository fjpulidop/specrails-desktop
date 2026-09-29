# Desktop definition authoring protocol

Decision recorded on 2026-09-26 before Desktop integration implementation.

The user requires complete Loop Manager compatibility and a visual editor with
all Core pieces. Desktop reuses React Flow, themed controls, keyboard actions and
the eight existing locales. The installed Core catalog is authoritative for
piece parameters and outcomes; an unavailable engine leaves existing graphs
readable and legacy execution intact. Newly authored definition graphs never
enter Desktop's legacy node traversal.

The editor supports adding pieces by palette click or drag, labeled outcome
connections, nested component canvases with breadcrumbs, and recursive schema
forms for objects, arrays, alternatives and arbitrary dictionary values. JSON
can be represented as structured fields; a raw JSON textarea is not the sole
parameter editor. Engine and role references use the configured project choices.

Publication compiles a deterministic raw draft without a version. Core validates
that draft and returns its exact published definition, canonical hash and graph.
Desktop stores the editable graph and validates the frozen launch definition
again against the selected project's effective roles and providers. Core owns
execution, durable checkpoints, receipts and completion; Desktop owns Git,
project routing, accounting projection and terminal settlement.

Component graph metadata preserves declared inputs and output labels. A local
end's exit label is separate from its business success/failure outcome. Typed
connections are unique per source/outcome and must use the effective labels for
the node parameters. Component references are validated by Core before launch.

The author can set an explicit global `config.maxTransitions` (1–10000).
Otherwise the compiler expands component visit costs and statically sized ticket
maps when deriving the iteration budget. Dynamic output maps, unknown repository
counts and the implementation builtin use Core's ceiling of 10000 because the
public catalog cannot predict their internal visit counts. Cost, time and builtin
correction budgets still apply. No guessed builtin node count is copied to Desktop.
